# hub-vault

A Hub service that carries v57 Vault's record changes between a user's devices: end-to-end-encrypted envelopes,
kept per vault until every member device has them. The service never sees a record, but it does see:
- ciphertext, with each payload's size and the key id and record id in its plain `Sealed{id, keyID}` wrapper;
- envelope ids (`<device id>:<record id>:<version>`, so structured record ids such as `profile.<account>` show), the
  sender and the time of every push;
- the devices' names, which devices share each vault (invites, joins and leaves) and how far each one has read.

Hashing the ids and dropping names is planned after 1.0 (security audit M13).

- **Devices only.** Every call needs the caller's device (`context.hub.caller.device`, set by hub-server for a
  connection with a certificate from an approved device). Who may call `vault/*` at all is the hub's decision
  (owners, or a grant in default-deny mode).
- **Vaults.** An owner's device creates a vault (an opaque id the devices agree on) by joining it. Members invite
  other devices; owners may also join and remove devices.
- **Delivery.** `vault/push` appends envelopes to the vault's log (a retried envelope id is stored once),
  `vault/pull` returns what the others sent after a sequence number, `vault/ack` says what a device has. An envelope
  is deleted once every member but its sender acknowledged it, or after 30 days; `pull` then reports `missed` to a
  device that never got it, which sends everything again. `vault/changes` streams the latest sequence number and the
  members, so devices pull at once instead of polling.

## API

Every path is described for `hub/api/list` in `descriptions.ts`, with input and output schemas that follow
`mailbox.ts`'s checks. Vault and device ids are 1 to 128 characters of `A-Z a-z 0-9 . _ : -`.

| Path | Kind | Title | Body | Result |
|---|---|---|---|---|
| `vault/join` | post | Join a vault | `{ vault }` | `{ last, members, joined }`: creates the vault (owners only) or joins it (invited devices, owners) |
| `vault/invite` | post | Invite a device to a vault | `{ vault, device }` | nothing; any member may invite |
| `vault/leave` | post | Leave a vault | `{ vault, device? }` | nothing; removes this device, or another one (owners) |
| `vault/push` | post | Push envelopes to a vault | `{ vault, envelopes: [{ id, payload }] }` | last sequence number |
| `vault/pull` | post | Pull envelopes from a vault | `{ vault, after?, limit? }` (limit 200 by default, 1000 at most) | `{ envelopes: [{ seq, id, from, at, payload }], last, missed }` |
| `vault/ack` | post | Acknowledge envelopes | `{ vault, seq }` | nothing; an acknowledgement never moves back |
| `vault/changes` | stream | Watch a vault | `{ vault }` | `{ last, members }`, then again after every change; ends when the device leaves |

`members` is `{ device, name?, acked, joinedAt, invitedBy? }[]`, oldest first. Errors are strings such as
`not a member of this vault`, `not invited to this vault`, `only an owner can create a vault` and
`only an owner can remove another device`.

Limits: payloads up to 512 KB of base64, 500 envelopes per push, 100,000 waiting per vault.

Storage is SQLite (`data/vault.sqlite`, WAL). The client is VaultKit's `HubSync` (`~/Developer/v57/Vault`).

## Installing on a Hub

hub-vault isn't in the launcher's app catalogue yet. On a Hub with hub-launcher, an owner adds it as a Bun app from
its repository: in the Hub app, **Launcher** → **New App** → **Bun** with the repository `v57/hub-vault`, or with the
launcher's API:

```ts
await owner.send('launcher/app/create', { name: 'Vault', type: 'bun', repo: 'v57/hub-vault', active: true, restarts: true })
```

To run it by hand next to a hub:

```bash
bun install
HUB=ws://127.0.0.1:1997 bun run index.ts      # data in ./data (HUB_VAULT_DATA)
```

| Variable | Default | |
|---|---|---|
| `HUB` | `1997` | Hub address (port or `ws://`/`wss://` URL) |
| `HUB_VAULT_DATA` | `./data` | Folder of `vault.sqlite` |

It needs no secrets. Its service key is the `auth` file in its working directory, created on the first run; under
the launcher that is the app's folder. Like every service whose key isn't an owner's, it waits on the Hub app's
**Requests** page until an owner allows it to host the `vault/*` paths.

## Permissions

- **The hub decides who reaches `vault/*`.** The service sets no permission of its own. In a `default-deny` hub (every
  new hub) only owners and callers an owner granted the paths get through; in an older `default-allow` hub any
  caller does, and the checks below still apply.
- **Devices only.** Every call needs the caller's device, so a key without a device certificate from an approved
  device gets `a device is required`, and calls through a merged hub are refused.
- **Membership.** Only an owner's device creates a vault. Other devices join when a member invited them, and only
  owners remove another device. A device sees only the vaults it belongs to.

For a device that isn't an owner's to sync, an owner grants it the vault paths, for example as a prefix:

```ts
await owner.send('hub/grant/add', { subject: { device: '<device id>' }, object: { prefix: 'vault/' } })
```

## Testing

```bash
bun install
bun test
```

`mailbox.test.ts` covers the log (delivery, retries, membership, retention, limits, restarts) on SQLite.
`api.test.ts` runs the service against hub-service's `FakeHub`, with owner, member and device-less callers.
`descriptions.test.ts` checks every registered path is described with schemas in the subset.
