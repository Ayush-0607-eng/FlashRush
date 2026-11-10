import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sweepExpired } from '../src/domain/expiry'
import { countRows, counters, expectConsistent, forceDue, hold, makeSale, openPool, resetDatabase } from './helpers'

describe('expiry sweeper', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('releases every due reservation exactly once across concurrent sweepers', async () => {
    const sale = await makeSale(pool, { total: 100, maxPerSession: 1 })
    const holds = await Promise.all(Array.from({ length: 60 }, () => hold(pool, sale.id)))
    await Promise.all(holds.slice(0, 50).map((entry) => forceDue(pool, entry.reservation.id, -1000)))
    const results = await Promise.all(Array.from({ length: 4 }, () => sweepExpired(pool, 200, 5)))
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(50)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 10, sold: 0 })
    expect(await countRows(pool, 'reservations', "status = 'EXPIRED'")).toBe(50)
    expect(await countRows(pool, 'reservations', "status = 'RESERVED'")).toBe(10)
    await expectConsistent(pool)
  })

  it('recovers overdue reservations after a restart without any queue state', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id, 2)
    expect(await countRows(pool, 'outbox', 'published_at IS NULL')).toBe(1)
    await forceDue(pool, reservation.id, -60000)
    const result = await sweepExpired(pool)
    expect(result).toEqual({ examined: 1, expired: 1 })
    expect((await counters(pool, sale.id)).reserved).toBe(0)
  })

  it('does not touch reservations that are still live', async () => {
    const sale = await makeSale(pool)
    await hold(pool, sale.id)
    expect(await sweepExpired(pool)).toEqual({ examined: 0, expired: 0 })
    expect((await counters(pool, sale.id)).reserved).toBe(1)
  })
})
