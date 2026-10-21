# hub-vault

A Hub service that carries v57 Vault's record changes between a user's devices: end-to-end-encrypted envelopes,
kept per vault until every member device has them. The service sees ciphertext, device ids and timing, never a
record.

- **Devices only.** Every call needs the caller's device (`context.hub.caller.device`, set by hub-pro for a
  connection with a certificate from an approved device). Who may call `vault/*` at all is the hub's decision
  (owners, or a grant in default-deny mode).
- **Vaults.** An owner's device creates a vault (an opaque id the devices agree on) by joining it. Members invite
  other devices; owners may also join and remove devices.
- **Delivery.** `vault/push` appends envelopes to the vault's log (a retried envelope id is stored once),
  `vault/pull` returns what the others sent after a sequence number, `vault/ack` says what a device has. An envelope
  is deleted once every member but its sender acknowledged it, or after 30 days; `pull` then reports `missed` to a
  device that never got it, which sends everything again. `vault/changes` streams the latest sequence number and the
  members, so devices pull at once instead of polling.

| Path | Body | Result |
|---|---|---|
| `vault/join` | `{ vault }` | `{ last, members, joined }` |
| `vault/invite` | `{ vault, device }` | |
| `vault/leave` | `{ vault, device? }` | |
| `vault/push` | `{ vault, envelopes: [{ id, payload }] }` | last sequence number |
| `vault/pull` | `{ vault, after, limit? }` | `{ envelopes: [{ seq, id, from, at, payload }], last, missed }` |
| `vault/ack` | `{ vault, seq }` | |
| `vault/changes` (stream) | `{ vault }` | `{ last, members }`, then again after every change |

Limits: payloads up to 512 KB of base64, 500 envelopes per push, 100,000 waiting per vault.

```bash
bun install
bun test
HUB=ws://127.0.0.1:1997 bun run index.ts      # data in ./data (HUB_VAULT_DATA)
```

Storage is SQLite (`data/vault.sqlite`, WAL). The client is VaultKit's `HubSync` (`~/Developer/v57/Vault`).
