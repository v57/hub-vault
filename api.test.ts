import { afterEach, describe, expect, test } from 'bun:test'
import { KeyFile, authToken } from 'hub-service/keys'
import { MultiplatformService } from 'hub-service/service'
import { FakeHub, vectors, waitFor } from 'hub-service/testing/fake-hub'
import { serveVault } from './api'
import { Mailbox } from './mailbox'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
const sign = async (hubKey?: string) => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey)

let hub: FakeHub
let service: MultiplatformService
afterEach(() => {
  service?.sender?.stop()
  hub?.stop()
})

/** The hub's caller context for a device (or a key-only client without `device`). */
function caller(device?: { id: string; name: string }, owner = true) {
  return { hub: { caller: { key: 'K', device, groups: owner ? ['owners'] : [], owner }, hubKey: vectors.keys.hub.publicKey } }
}
const mac = caller({ id: 'mac-id', name: 'Mac Studio' })
const phone = () => caller({ id: 'phone-id', name: 'Pixel' }, false)

async function start() {
  hub = new FakeHub()
  const port = hub.start()
  service = new MultiplatformService({ sign }, { address: port })
  serveVault(service, new Mailbox())
  service.start()
  // The service learns the hub key on its first connection and uses v1 from the next.
  await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
  const connection = hub.open.find(c => c.version === '1' && c.updates.length > 0)!
  return (path: string, body: unknown, context: unknown) => connection.sender.send(path, body, { context })
}

describe('hub-vault over a hub', () => {
  test('devices exchange envelopes they never see inside', async () => {
    const send = await start()
    expect(hub.open.at(-1)!.updates.at(-1).services.map((s: any) => s.path).sort()).toContain('vault/push')
    expect(await send('vault/join', { vault: 'v1' }, mac)).toMatchObject({ last: 0, joined: true })
    await send('vault/invite', { vault: 'v1', device: 'phone-id' }, mac)
    const joined: any = await send('vault/join', { vault: 'v1' }, phone())
    expect(joined.members.map((m: any) => m.name)).toEqual(['Mac Studio', 'Pixel'])
    expect(await send('vault/push', { vault: 'v1', envelopes: [{ id: 'e1', payload: 'AAEC' }] }, mac)).toBe(1)
    const pulled: any = await send('vault/pull', { vault: 'v1', after: 0 }, phone())
    expect(pulled.envelopes).toMatchObject([{ seq: 1, id: 'e1', from: 'mac-id', payload: 'AAEC' }])
    await send('vault/ack', { vault: 'v1', seq: 1 }, phone())
    expect(((await send('vault/pull', { vault: 'v1', after: 0 }, phone())) as any).envelopes).toEqual([])
  })

  test('callers without a device, or not invited, get nothing', async () => {
    const send = await start()
    await expect(send('vault/join', { vault: 'v1' }, caller(undefined))).rejects.toMatch('a device is required')
    await expect(send('vault/join', { vault: 'v1' }, {})).rejects.toMatch('a device is required')
    await expect(send('vault/join', { vault: 'v1' }, phone())).rejects.toMatch('only an owner can create')
    await send('vault/join', { vault: 'v1' }, mac)
    await expect(send('vault/join', { vault: 'v1' }, phone())).rejects.toMatch('not invited')
    await expect(send('vault/pull', { vault: 'v1', after: 0 }, phone())).rejects.toMatch('not a member')
    // A caller claimed by the client itself (not the pinned hub's) is ignored.
    const forged = { hub: { ...mac.hub, hubKey: 'someone else' } }
    await expect(send('vault/join', { vault: 'v2' }, forged)).rejects.toMatch('a device is required')
  })

  test('changes stream wakes devices when envelopes arrive', async () => {
    const hubSend = await start()
    await hubSend('vault/join', { vault: 'v1' }, mac)
    await hubSend('vault/join', { vault: 'v1' }, caller({ id: 'linux-id', name: 'builder' }))
    const connection = hub.open.find(c => c.version === '1' && c.updates.length > 0)!
    const seen: number[] = []
    const reading = (async () => {
      for await (const change of connection.sender.values('vault/changes', { vault: 'v1' }, { context: mac }) as any) {
        seen.push(change.last)
        if (seen.length === 3) break
      }
    })()
    await waitFor(() => seen.length === 1)
    const linux = caller({ id: 'linux-id', name: 'builder' })
    await hubSend('vault/push', { vault: 'v1', envelopes: [{ id: 'a', payload: 'AA' }] }, linux)
    await waitFor(() => seen.length === 2)
    await hubSend('vault/push', { vault: 'v1', envelopes: [{ id: 'b', payload: 'AA' }] }, linux)
    await reading
    expect(seen).toEqual([0, 1, 2])
  })
})
