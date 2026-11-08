/**
 * What a path says about itself in `hub/api/list` (protocol.md section 15): passed in the settings of `post` and
 * `stream`, next to `access`. hub-service before descriptions ignores these fields.
 */
export interface Described {
  title?: string
  description: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
export type Descriptions = { post?: Record<string, Described>; stream?: Record<string, Described> }

/** An id as mailbox.ts validates it (`validateID`) */
const id = (description: string) => ({ type: 'string', description, minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' })
const vault = id('Vault id: an opaque id the member devices agree on')
const last = { type: 'integer', minimum: 0, description: 'Sequence number of the newest envelope in the vault, 0 when none was pushed' }
const members = {
  type: 'array',
  description: 'Devices that joined the vault, oldest first (invited devices appear once they join)',
  items: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id' },
      name: { type: 'string', description: 'Device name from its certificate' },
      acked: { type: 'integer', minimum: 0, description: 'Last sequence number the device acknowledged' },
      joinedAt: { type: 'integer', description: 'When the device joined, Unix seconds' },
      invitedBy: { type: 'string', description: 'Device id of the member that invited it; absent for devices that joined as owners' },
    },
    required: ['device', 'acked', 'joinedAt'],
  },
}
const who =
  'Needs a device certificate from an approved device on this hub (not through a merged hub); the hub allows owners, or a grant of the path.'

/**
 * Typed as `Described` (not only `satisfies`) so the schemas' `type` strings don't need `as const` to pass as the
 * SDK's `ApiSettings`.
 */
export const descriptions: { post: Record<string, Described>; stream: Record<string, Described> } = {
  post: {
    'vault/join': {
      title: 'Join a vault',
      description: `Creates the vault when it is new (owners only) or joins it (invited devices, or owners), and returns the newest sequence number and the members; joining again is harmless and updates the device's name. Fails with "only an owner can create a vault" or "not invited to this vault". ${who}`,
      inputSchema: { type: 'object', properties: { vault }, required: ['vault'] },
      outputSchema: {
        type: 'object',
        properties: {
          last,
          members,
          joined: { type: 'boolean', description: 'True when this call added the device, false when it was already a member' },
        },
        required: ['last', 'members', 'joined'],
      },
      annotations: { idempotentHint: true },
    },
    'vault/invite': {
      title: 'Invite a device to a vault',
      description: `Lets another device join the vault with vault/join; any member may invite, and inviting a device twice changes nothing. Fails with "not a member of this vault". ${who}`,
      inputSchema: { type: 'object', properties: { vault, device: id('Device id of the device to invite') }, required: ['vault', 'device'] },
      annotations: { idempotentHint: true },
    },
    'vault/leave': {
      title: 'Leave a vault',
      description: `Removes the calling device from the vault, or another device (owners only); envelopes no longer wait for the removed device. Fails with "not a member of this vault" or "only an owner can remove another device". ${who}`,
      inputSchema: {
        type: 'object',
        properties: { vault, device: { type: 'string', description: 'Device id to remove; the calling device when absent' } },
        required: ['vault'],
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    'vault/push': {
      title: 'Push envelopes to a vault',
      description: `Appends end-to-end-encrypted envelopes to the vault's log for the other members and returns the newest sequence number; a retried envelope id is stored once. The service only sees sealed payloads. Fails with "not a member of this vault", over 500 envelopes per push, a payload over 512 KB of base64, or 100,000 envelopes waiting. ${who}`,
      inputSchema: {
        type: 'object',
        properties: {
          vault,
          envelopes: {
            type: 'array',
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                id: id('Envelope id chosen by the sender, unique in the vault, like "<device id>:<record id>:<version>"'),
                payload: { type: 'string', maxLength: 524288, description: 'Sealed record change, base64 ciphertext' },
              },
              required: ['id', 'payload'],
            },
          },
        },
        required: ['vault', 'envelopes'],
      },
      outputSchema: last,
      annotations: { idempotentHint: true },
    },
    'vault/pull': {
      title: 'Pull envelopes from a vault',
      description: `Envelopes the other members pushed after a sequence number, oldest first (up to 200 by default, 1000 at most). When \`missed\` is true some the device never acknowledged expired after 30 days, and it should push everything it has again. Payloads are sealed. Fails with "not a member of this vault". ${who}`,
      inputSchema: {
        type: 'object',
        properties: {
          vault,
          after: { type: 'integer', minimum: 0, default: 0, description: 'Sequence number the device already has; 0 for everything kept' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Most envelopes to return' },
        },
        required: ['vault'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          envelopes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'integer', minimum: 1, description: "Place in the vault's log" },
                id: { type: 'string', description: 'Envelope id the sender chose' },
                from: { type: 'string', description: 'Device id of the sender' },
                at: { type: 'integer', description: 'When it was pushed, Unix seconds' },
                payload: { type: 'string', description: 'Sealed record change, base64 ciphertext' },
              },
              required: ['seq', 'id', 'from', 'at', 'payload'],
            },
          },
          last,
          missed: { type: 'boolean', description: 'Envelopes the device never had expired: it should push everything again' },
        },
        required: ['envelopes', 'last', 'missed'],
      },
      annotations: { readOnlyHint: true },
    },
    'vault/ack': {
      title: 'Acknowledge envelopes',
      description: `Records that the device has every envelope up to a sequence number, so envelopes all members have are deleted; an acknowledgement never moves back. Fails with "not a member of this vault". ${who}`,
      inputSchema: {
        type: 'object',
        properties: { vault, seq: { type: 'integer', minimum: 0, description: 'Sequence number of the newest envelope the device has' } },
        required: ['vault', 'seq'],
      },
      annotations: { idempotentHint: true },
    },
  },
  stream: {
    'vault/changes': {
      title: 'Watch a vault',
      description: `Sends the vault's newest sequence number and members now and after every join, leave or push, so devices pull at once instead of polling; it ends when the device leaves. Fails with "not a member of this vault". ${who}`,
      inputSchema: { type: 'object', properties: { vault }, required: ['vault'] },
      outputSchema: { type: 'object', properties: { last, members }, required: ['last', 'members'] },
      annotations: { readOnlyHint: true },
    },
  },
} satisfies Descriptions
