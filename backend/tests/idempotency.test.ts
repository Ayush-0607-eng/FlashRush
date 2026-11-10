import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelReservation, checkout } from '../src/domain/checkout'
import { reserve } from '../src/domain/reservations'
import { countRows, counters, expectConsistent, hold, makeSale, makeSession, newKey, openPool, outcomeOf, resetDatabase } from './helpers'

describe('idempotency', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('executes a reservation once when 20 identical requests race', async () => {
    const sale = await makeSale(pool)
    const session = await makeSession(pool)
    const key = newKey()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 2, idempotencyKey: key }))
    )
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1)
    expect(results.every((result) => result.status === 201)).toBe(true)
    expect(results.filter((result) => result.replayed)).toHaveLength(19)
    expect(await countRows(pool, 'reservations')).toBe(1)
    expect(await countRows(pool, 'outbox')).toBe(1)
    expect((await counters(pool, sale.id)).reserved).toBe(2)
    await expectConsistent(pool)
  })

  it('returns the stored response when a client retries after a lost response', async () => {
    const sale = await makeSale(pool)
    const session = await makeSession(pool)
    const key = newKey()
    const original = await reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    const retry = await reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    expect(retry.replayed).toBe(true)
    expect(retry.body).toEqual(original.body)
    expect((await counters(pool, sale.id)).reserved).toBe(1)
  })

  it('rejects a reused key with a different payload', async () => {
    const sale = await makeSale(pool)
    const session = await makeSession(pool)
    const key = newKey()
    await reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 2, idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED')
    expect((await counters(pool, sale.id)).reserved).toBe(1)
  })

  it('scopes keys to the session that created them', async () => {
    const sale = await makeSale(pool)
    const [first, second] = await Promise.all([makeSession(pool), makeSession(pool)])
    const key = newKey()
    const a = await reserve(pool, { sessionId: first.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    const b = await reserve(pool, { sessionId: second.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    expect(a.body.data.id).not.toBe(b.body.data.id)
    expect(b.replayed).toBe(false)
  })

  it('does not leave a stuck key behind when the operation fails', async () => {
    const sale = await makeSale(pool, { total: 1 })
    const holder = await hold(pool, sale.id)
    const waiting = await makeSession(pool)
    const key = newKey()
    expect(await outcomeOf(reserve(pool, { sessionId: waiting.id, saleId: sale.id, quantity: 1, idempotencyKey: key }))).toBe('SOLD_OUT')
    expect(await countRows(pool, 'idempotency_keys', `session_id = '${waiting.id}'`)).toBe(0)
    await cancelReservation(pool, holder.session.id, holder.reservation.id)
    const retry = await reserve(pool, { sessionId: waiting.id, saleId: sale.id, quantity: 1, idempotencyKey: key })
    expect(retry.status).toBe(201)
    expect(retry.replayed).toBe(false)
    await expectConsistent(pool)
  })

  it('charges once when 10 identical checkout requests race', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id, 2)
    const key = newKey()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: key }))
    )
    expect(results.every((result) => result.status === 201)).toBe(true)
    expect(new Set(results.map((result) => result.body.data?.order.id)).size).toBe(1)
    expect(await countRows(pool, 'orders')).toBe(1)
    expect(await countRows(pool, 'payment_attempts', "outcome = 'SUCCESS'")).toBe(1)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 2 })
    await expectConsistent(pool)
  })

  it('creates one order when double-clicks use different keys', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() }))
    )
    expect(results.filter((result) => result.status === 201)).toHaveLength(1)
    expect(results.filter((result) => result.status === 200)).toHaveLength(5)
    expect(new Set(results.map((result) => result.body.data?.order.id)).size).toBe(1)
    expect(await countRows(pool, 'orders')).toBe(1)
    expect(await countRows(pool, 'payment_attempts', "outcome = 'SUCCESS'")).toBe(1)
    await expectConsistent(pool)
  })

  it('replays a declined payment without recording another attempt', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    const key = newKey()
    const first = await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'fail', idempotencyKey: key })
    const replay = await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'fail', idempotencyKey: key })
    expect(first.status).toBe(402)
    expect(replay.status).toBe(402)
    expect(replay.replayed).toBe(true)
    expect(await countRows(pool, 'payment_attempts', "outcome = 'FAILED'")).toBe(1)
  })
})
