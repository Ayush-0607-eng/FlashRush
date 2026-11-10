import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { expireReservation } from '../src/domain/expiry'
import { reserve } from '../src/domain/reservations'
import { getSale, updateSale } from '../src/domain/sales'
import { forceDue, hold, makeSale, makeSession, newKey, openPool, outcomeOf, resetDatabase } from './helpers'

describe('reservation rules and database invariants', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('rejects reservations before the sale opens and after it ends', async () => {
    const now = Date.now()
    const upcoming = await makeSale(pool, { startsAt: new Date(now + 3600000), endsAt: new Date(now + 7200000) })
    const finished = await makeSale(pool, { startsAt: new Date(now - 7200000), endsAt: new Date(now - 3600000) })
    const session = await makeSession(pool)
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: upcoming.id, quantity: 1, idempotencyKey: newKey() }))).toBe('SALE_NOT_ACTIVE')
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: finished.id, quantity: 1, idempotencyKey: newKey() }))).toBe('SALE_NOT_ACTIVE')
  })

  it('rejects invalid quantities and unknown sales', async () => {
    const sale = await makeSale(pool, { maxPerSession: 2 })
    const session = await makeSession(pool)
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 3, idempotencyKey: newKey() }))).toBe('INVALID_QUANTITY')
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 0, idempotencyKey: newKey() }))).toBe('INVALID_QUANTITY')
    expect(await outcomeOf(reserve(pool, { sessionId: session.id, saleId: randomUUID(), quantity: 1, idempotencyKey: newKey() }))).toBe('SALE_NOT_FOUND')
  })

  it('derives sale status from inventory and the schedule', async () => {
    const now = Date.now()
    const upcoming = await makeSale(pool, { startsAt: new Date(now + 3600000), endsAt: new Date(now + 7200000) })
    const finished = await makeSale(pool, { startsAt: new Date(now - 7200000), endsAt: new Date(now - 3600000) })
    const tiny = await makeSale(pool, { total: 1 })
    expect((await getSale(pool, upcoming.id)).status).toBe('SCHEDULED')
    expect((await getSale(pool, finished.id)).status).toBe('ENDED')
    expect((await getSale(pool, tiny.id)).status).toBe('ACTIVE')
    await hold(pool, tiny.id)
    const soldOut = await getSale(pool, tiny.id)
    expect(soldOut.status).toBe('SOLD_OUT')
    expect(soldOut.available).toBe(0)
  })

  it('refuses inventory counters that violate the database constraint', async () => {
    const sale = await makeSale(pool, { total: 10 })
    await expect(pool.query('UPDATE sales SET reserved = total + 1 WHERE id = $1', [sale.id])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('UPDATE sales SET reserved = 6, sold = 5 WHERE id = $1', [sale.id])).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses to shrink a sale below what is already held', async () => {
    const sale = await makeSale(pool, { total: 10, maxPerSession: 5 })
    await hold(pool, sale.id, 5)
    expect(await outcomeOf(updateSale(pool, sale.id, { total: 3 }))).toBe('CONSTRAINT_VIOLATION')
    expect((await updateSale(pool, sale.id, { total: 8 })).total).toBe(8)
  })

  it('rejects invalid prices at the database level', async () => {
    await expect(makeSale(pool, { priceMinor: 0 })).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' })
  })

  it('blocks illegal reservation transitions with a trigger', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id)
    await forceDue(pool, reservation.id, -1000)
    expect(await expireReservation(pool, reservation.id)).toBe('EXPIRED')
    await expect(
      pool.query("UPDATE reservations SET status = 'CONFIRMED', resolved_at = now() WHERE id = $1", [reservation.id])
    ).rejects.toMatchObject({ code: '23514' })
  })
})
