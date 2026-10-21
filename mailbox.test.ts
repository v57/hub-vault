import { describe, expect, test } from 'bun:test'
import { Mailbox } from './mailbox'

const owner = { owner: true }
const envelope = (id: string) => ({ id, payload: Buffer.from(`ciphertext ${id}`).toString('base64') })

describe('mailbox', () => {
  test('keeps envelopes until every other member has them', () => {
    const box = new Mailbox()
    box.join('v1', 'mac', { ...owner, name: 'Mac' })
    box.invite('v1', 'mac', 'pad')
    box.join('v1', 'pad', { owner: false, name: 'iPad' })
    expect(box.push('v1', 'mac', [envelope('a'), envelope('b')])).toBe(2)
    // The sender doesn't get its own back.
    expect(box.pull('v1', 'mac', 0).envelopes).toEqual([])
    const pulled = box.pull('v1', 'pad', 0)
    expect(pulled.envelopes.map(e => [e.seq, e.id, e.from])).toEqual([
      [1, 'a', 'mac'],
      [2, 'b', 'mac'],
    ])
    expect(pulled.missed).toBe(false)
    box.ack('v1', 'pad', 1)
    expect(box.pull('v1', 'pad', 0).envelopes.map(e => e.id)).toEqual(['b'])
    box.ack('v1', 'pad', 2)
    expect(box.db.query('SELECT count(*) AS n FROM envelopes').get()).toEqual({ n: 0 })
  })

  test('a push only acknowledges nothing: what others sent meanwhile still reaches the pusher', () => {
    const box = new Mailbox()
    box.join('v1', 'mac', owner)
    box.join('v1', 'linux', owner)
    box.push('v1', 'linux', [envelope('from-linux')])
    box.push('v1', 'mac', [envelope('from-mac')])
    expect(box.pull('v1', 'mac', 0).envelopes.map(e => e.id)).toEqual(['from-linux'])
  })

  test('retried pushes are stored once', () => {
    const box = new Mailbox()
    box.join('v1', 'mac', owner)
    box.join('v1', 'pad', owner)
    box.push('v1', 'mac', [envelope('a')])
    expect(box.push('v1', 'mac', [envelope('a'), envelope('b')])).toBe(2)
    expect(box.pull('v1', 'pad', 0).envelopes.map(e => e.id)).toEqual(['a', 'b'])
  })

  test('only owners create vaults, and only invited devices or owners join', () => {
    const box = new Mailbox()
    expect(() => box.join('v1', 'phone', { owner: false })).toThrow('only an owner can create a vault')
    box.join('v1', 'mac', owner)
    expect(() => box.join('v1', 'phone', { owner: false })).toThrow('not invited')
    expect(() => box.push('v1', 'phone', [envelope('x')])).toThrow('not a member')
    expect(() => box.invite('v1', 'phone', 'phone')).toThrow('not a member')
    box.invite('v1', 'mac', 'phone')
    expect(box.join('v1', 'phone', { owner: false }).joined).toBe(true)
    expect(box.join('v1', 'phone', { owner: false }).joined).toBe(false)
    expect(() => box.leave('v1', 'phone', 'mac', false)).toThrow('only an owner')
  })

  test('a device that left no longer holds envelopes back', () => {
    const box = new Mailbox()
    box.join('v1', 'mac', owner)
    box.join('v1', 'old', owner)
    box.push('v1', 'mac', [envelope('a')])
    box.leave('v1', 'mac', 'old', true)
    expect(box.db.query('SELECT count(*) AS n FROM envelopes').get()).toEqual({ n: 0 })
    expect(box.members('v1').map(m => m.device)).toEqual(['mac'])
  })

  test('envelopes past retention go, and the device that missed them is told', () => {
    let now = 1_000_000
    const box = new Mailbox(':memory:', { payload: 1000, batch: 10, waiting: 20, retention: 100 }, () => now)
    box.join('v1', 'mac', owner)
    box.join('v1', 'away', owner)
    box.push('v1', 'mac', [envelope('old')])
    now += 200
    box.push('v1', 'mac', [envelope('new')])
    box.prune('v1')
    const pulled = box.pull('v1', 'away', 0)
    expect(pulled.envelopes.map(e => e.id)).toEqual(['new'])
    expect(pulled.missed).toBe(true)
    box.ack('v1', 'away', pulled.last)
    expect(box.pull('v1', 'away', pulled.last).missed).toBe(false)
  })

  test('limits', () => {
    const box = new Mailbox(':memory:', { payload: 10, batch: 2, waiting: 3, retention: 100 })
    box.join('v1', 'mac', owner)
    box.join('v1', 'pad', owner)
    expect(() => box.push('v1', 'mac', [{ id: 'a', payload: 'x'.repeat(11) }])).toThrow('payload')
    expect(() => box.push('v1', 'mac', [envelope('a'), envelope('b'), envelope('c')].map(e => ({ ...e, payload: 'p' })))).toThrow('at most 2')
    box.push('v1', 'mac', [{ id: 'a', payload: 'p' }, { id: 'b', payload: 'p' }])
    expect(() => box.push('v1', 'mac', [{ id: 'c', payload: 'p' }, { id: 'd', payload: 'p' }])).toThrow('too many')
    expect(() => box.join('bad id/../', 'mac', owner)).toThrow('vault must be')
  })

  test('the log survives a restart', () => {
    const path = `/tmp/hub-vault-test-${crypto.randomUUID()}.sqlite`
    const first = new Mailbox(path)
    first.join('v1', 'mac', owner)
    first.join('v1', 'pad', owner)
    first.push('v1', 'mac', [envelope('a')])
    first.db.close()
    const again = new Mailbox(path)
    expect(again.pull('v1', 'pad', 0).envelopes.map(e => e.id)).toEqual(['a'])
    expect(again.push('v1', 'mac', [envelope('b')])).toBe(2)
    again.db.close()
  })
})
