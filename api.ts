import type { Caller, MultiplatformService, ServiceRequest } from 'hub-service/service'
import { Mailbox, MailboxError, type Envelope } from './mailbox'

/**
 * The service's paths, on any hub-service `Service`. Every call needs the caller's device (`context.hub.caller`,
 * set by the hub); key-only clients get no mailbox. The hub decides who may call `vault/*` at all (owners, or a
 * grant in default-deny mode); the mailbox decides which vaults a device belongs to.
 *
 * | Path | Body | Result |
 * |---|---|---|
 * | `vault/join` | `{ vault }` | `{ last, members, joined }`: creates the vault (owners only) or joins it (invited devices, owners) |
 * | `vault/invite` | `{ vault, device }` | lets another device join |
 * | `vault/leave` | `{ vault, device? }` | removes this device, or another one (owners) |
 * | `vault/push` | `{ vault, envelopes: [{ id, payload }] }` | the last sequence number |
 * | `vault/pull` | `{ vault, after, limit? }` | `{ envelopes: [{ seq, id, from, at, payload }], last, missed }` |
 * | `vault/ack` | `{ vault, seq }` | the device has everything up to `seq` |
 * | `vault/changes` (stream) | `{ vault }` | `{ last, members }` now and after every change |
 */
export function serveVault(service: MultiplatformService, mailbox: Mailbox) {
  const watchers = new Map<string, Set<() => void>>()
  const changed = (vault: string) => {
    for (const wake of watchers.get(vault) ?? []) wake()
  }

  service
    .post('vault/join', (body, request) => {
      const caller = device(request)
      const result = run(() => mailbox.join(vaultID(body), caller.id, { owner: caller.owner, name: caller.name }))
      if (result.joined) changed(vaultID(body))
      return result
    })
    .post('vault/invite', (body, request) => {
      run(() => mailbox.invite(vaultID(body), device(request).id, body?.device))
    })
    .post('vault/leave', (body, request) => {
      const caller = device(request)
      run(() => mailbox.leave(vaultID(body), caller.id, body?.device ?? caller.id, caller.owner))
      changed(vaultID(body))
    })
    .post('vault/push', (body, request) => {
      const last = run(() => mailbox.push(vaultID(body), device(request).id, body?.envelopes as Envelope[]))
      changed(vaultID(body))
      return last
    })
    .post('vault/pull', (body, request) => {
      const after = Number(body?.after ?? 0)
      const limit = body?.limit == null ? undefined : Number(body.limit)
      return run(() => mailbox.pull(vaultID(body), device(request).id, Number.isFinite(after) ? after : 0, limit))
    })
    .post('vault/ack', (body, request) => {
      run(() => mailbox.ack(vaultID(body), device(request).id, Number(body?.seq ?? 0)))
    })
    .stream('vault/changes', async function* (body, request) {
      const vault = vaultID(body)
      const id = device(request).id
      if (!mailbox.isMember(vault, id)) throw 'not a member of this vault'
      let wake: (() => void) | undefined
      let pending = false
      const listener = () => {
        pending = true
        wake?.()
      }
      const set = watchers.get(vault) ?? new Set()
      set.add(listener)
      watchers.set(vault, set)
      try {
        while (mailbox.isMember(vault, id)) {
          yield { last: mailbox.last(vault), members: mailbox.members(vault) }
          if (!pending) await new Promise<void>(resolve => (wake = resolve))
          pending = false
          wake = undefined
        }
      } finally {
        set.delete(listener)
        if (set.size === 0) watchers.delete(vault)
      }
    })
}

/** The calling device, or a refusal for callers without one. */
function device(request: ServiceRequest): { id: string; name?: string; owner: boolean } {
  const caller: Caller | undefined = request.caller
  if (!caller?.device?.id) throw 'a device is required: connect with a device certificate from an approved device'
  if (caller.via) throw 'vaults are reached on their own hub, not through a merged one'
  return { id: caller.device.id, name: caller.device.name, owner: caller.owner === true }
}

function vaultID(body: any): string {
  if (typeof body?.vault !== 'string') throw 'vault is required'
  return body.vault
}

/** Hub errors are strings. */
function run<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof MailboxError) throw error.message
    throw error
  }
}
