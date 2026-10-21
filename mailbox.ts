import { Database } from 'bun:sqlite'

/** One encrypted record change, as a device sends it. The payload is ciphertext: the service never reads it. */
export interface Envelope {
  /** Chosen by the sender, unique per vault; a retried push with the same id is stored once. */
  id: string
  /** Base64 ciphertext. */
  payload: string
}

/** An envelope as it is delivered: its place in the vault's log, who sent it and when. */
export interface StoredEnvelope extends Envelope {
  seq: number
  from: string
  /** Unix seconds. */
  at: number
}

export interface Member {
  device: string
  name?: string
  /** The last sequence number the device has. */
  acked: number
  joinedAt: number
  invitedBy?: string
}

export interface Limits {
  /** Largest payload, in base64 characters. */
  payload: number
  /** Most envelopes per push. */
  batch: number
  /** Most envelopes waiting in one vault. */
  waiting: number
  /** Seconds an envelope waits for a device that never acknowledges it. */
  retention: number
}

export const defaultLimits: Limits = { payload: 512 * 1024, batch: 500, waiting: 100_000, retention: 30 * 86_400 }

export class MailboxError extends Error {}

/**
 * The vaults' mailboxes: per vault, the member devices and a log of envelopes that each member pulls and acknowledges.
 * An envelope is deleted once every member acknowledged it (or after `retention`). A vault is an opaque id the
 * devices agree on; who may read it is the vault's own key, which never reaches this service.
 */
export class Mailbox {
  readonly db: Database
  constructor(
    path = ':memory:',
    readonly limits: Limits = defaultLimits,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 1, expired_to INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members (vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        device TEXT NOT NULL, name TEXT, acked INTEGER NOT NULL DEFAULT 0, joined_at INTEGER, invited_by TEXT,
        PRIMARY KEY (vault, device));
      CREATE TABLE IF NOT EXISTS envelopes (vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, id TEXT NOT NULL, from_device TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (vault, seq), UNIQUE (vault, id));
    `)
  }

  /**
   * Adds the device to the vault, creating the vault if it is new. A device that wasn't invited may join only as an
   * owner. A device joining for the first time has nothing yet: it starts at the oldest envelope still kept.
   */
  join(
    vault: string,
    device: string,
    options: { owner: boolean; name?: string },
  ): { last: number; members: Member[]; joined: boolean } {
    validateID(vault, 'vault')
    return this.db.transaction(() => {
      const existing = this.vault(vault)
      const member = existing && this.member(vault, device)
      if (!existing) {
        if (!options.owner) throw new MailboxError('only an owner can create a vault')
        this.db.query('INSERT INTO vaults (id, created_by, created_at) VALUES (?, ?, ?)').run(vault, device, this.now())
      }
      if (!member) {
        const invited = existing && this.invited(vault, device)
        if (existing && !invited && !options.owner) throw new MailboxError('not invited to this vault')
        this.db
          .query(
            `INSERT INTO members (vault, device, name, acked, joined_at) VALUES (?, ?, ?, 0, ?)
             ON CONFLICT (vault, device) DO UPDATE SET name = excluded.name, joined_at = excluded.joined_at`,
          )
          .run(vault, device, options.name ?? null, this.now())
      } else if (member.joinedAt == null || options.name !== undefined) {
        this.db
          .query('UPDATE members SET name = coalesce(?, name), joined_at = coalesce(joined_at, ?) WHERE vault = ? AND device = ?')
          .run(options.name ?? null, this.now(), vault, device)
      }
      return { last: this.last(vault), members: this.members(vault), joined: member?.joinedAt == null }
    })()
  }

  /** Lets another device join (a member invites it). */
  invite(vault: string, by: string, device: string) {
    this.requireMember(vault, by)
    validateID(device, 'device')
    this.db
      .query('INSERT INTO members (vault, device, invited_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(vault, device, by)
  }

  /** Removes a device: itself, or another one when `owner`. Its acknowledgements no longer hold envelopes back. */
  leave(vault: string, by: string, device: string, owner: boolean) {
    if (device !== by && !owner) throw new MailboxError('only an owner can remove another device')
    this.requireMember(vault, by)
    this.db.query('DELETE FROM members WHERE vault = ? AND device = ?').run(vault, device)
    this.prune(vault)
  }

  /** Stores envelopes for the other members; returns the last sequence number. */
  push(vault: string, from: string, envelopes: Envelope[]): number {
    this.requireMember(vault, from)
    if (!Array.isArray(envelopes)) throw new MailboxError('envelopes must be a list')
    if (envelopes.length > this.limits.batch) throw new MailboxError(`at most ${this.limits.batch} envelopes per push`)
    for (const envelope of envelopes) {
      validateID(envelope?.id, 'envelope id')
      if (typeof envelope.payload !== 'string' || envelope.payload.length > this.limits.payload) {
        throw new MailboxError(`an envelope's payload is a base64 string of at most ${this.limits.payload} characters`)
      }
    }
    return this.db.transaction(() => {
      const waiting = this.db.query('SELECT count(*) AS n FROM envelopes WHERE vault = ?').get(vault) as { n: number }
      if (waiting.n + envelopes.length > this.limits.waiting) throw new MailboxError('the vault has too many envelopes waiting')
      const insert = this.db.query(
        'INSERT INTO envelopes (vault, seq, id, from_device, at, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      let seq = this.vault(vault)!.next_seq
      for (const envelope of envelopes) {
        if (insert.run(vault, seq, envelope.id, from, this.now(), envelope.payload).changes > 0) seq += 1
      }
      this.db.query('UPDATE vaults SET next_seq = ? WHERE id = ?').run(seq, vault)
      return seq - 1
    })()
  }

  /**
   * Envelopes after `after` from the other members, oldest first. `missed` is true when some the device never
   * acknowledged were deleted for retention: it should send everything it has again.
   */
  pull(vault: string, device: string, after: number, limit = 200): { envelopes: StoredEnvelope[]; last: number; missed: boolean } {
    const member = this.requireMember(vault, device)
    const rows = this.db
      .query(
        `SELECT seq, id, from_device AS "from", at, payload FROM envelopes
         WHERE vault = ? AND seq > ? AND from_device != ? ORDER BY seq LIMIT ?`,
      )
      .all(vault, Math.max(0, after), device, Math.min(Math.max(1, limit), 1000)) as StoredEnvelope[]
    return { envelopes: rows, last: this.last(vault), missed: this.pruned(vault, Math.max(member.acked, after)) }
  }

  /** The device has every envelope up to `seq`. */
  ack(vault: string, device: string, seq: number) {
    const member = this.requireMember(vault, device)
    const upTo = Math.min(Math.max(member.acked, Math.floor(seq)), this.last(vault))
    this.db.query('UPDATE members SET acked = ? WHERE vault = ? AND device = ?').run(upTo, vault, device)
    this.prune(vault)
  }

  /** Deletes what every member but its sender has, and what waited past `retention`. */
  prune(vault: string) {
    this.db
      .query(
        `DELETE FROM envelopes WHERE vault = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.vault = envelopes.vault
           AND m.joined_at IS NOT NULL AND m.device != envelopes.from_device AND m.acked < envelopes.seq)`,
      )
      .run(vault)
    const expired = this.db
      .query('DELETE FROM envelopes WHERE vault = ? AND at < ? RETURNING seq')
      .all(vault, this.now() - this.limits.retention) as { seq: number }[]
    const highest = Math.max(0, ...expired.map(row => row.seq))
    if (highest > 0) {
      this.db.query('UPDATE vaults SET expired_to = max(expired_to, ?) WHERE id = ?').run(highest, vault)
    }
  }

  members(vault: string): Member[] {
    return (
      this.db
        .query(
          `SELECT device, name, acked, joined_at AS joinedAt, invited_by AS invitedBy FROM members
           WHERE vault = ? AND joined_at IS NOT NULL ORDER BY joined_at`,
        )
        .all(vault) as any[]
    ).map(row => ({ ...row, name: row.name ?? undefined, invitedBy: row.invitedBy ?? undefined }))
  }

  last(vault: string): number {
    return (this.vault(vault)?.next_seq ?? 1) - 1
  }

  isMember(vault: string, device: string): boolean {
    return this.member(vault, device)?.joinedAt != null
  }

  private vault(id: string) {
    return this.db.query('SELECT id, next_seq FROM vaults WHERE id = ?').get(id) as { id: string; next_seq: number } | null
  }

  private member(vault: string, device: string) {
    return this.db
      .query('SELECT device, acked, joined_at AS joinedAt FROM members WHERE vault = ? AND device = ?')
      .get(vault, device) as { device: string; acked: number; joinedAt: number | null } | null
  }

  private invited(vault: string, device: string): boolean {
    return this.member(vault, device) != null
  }

  private requireMember(vault: string, device: string) {
    const member = this.member(vault, device)
    if (!member || member.joinedAt == null) throw new MailboxError('not a member of this vault')
    return member
  }

  /** Whether envelopes after `acked` expired before the device had them (retention, not acknowledgement). */
  private pruned(vault: string, acked: number): boolean {
    const row = this.db.query('SELECT expired_to FROM vaults WHERE id = ?').get(vault) as { expired_to: number } | null
    return (row?.expired_to ?? 0) > acked
  }
}

function validateID(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new MailboxError(`${what} must be 1–128 letters, digits or . _ : -`)
  }
}
