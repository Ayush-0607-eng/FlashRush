import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { reserve } from '../src/domain/reservations'
import { AppError } from '../src/errors'
import { countRows, counters, expectConsistent, makeSale, makeSession, newKey, openPool, outcomeOf, resetDatabase } from './helpers'

describe('concurrent reservations', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('never oversells when 400 sessions compete for 100 tickets', async () => {
    const sale = await makeSale(pool, { total: 100 })
    const sessions = await Promise.all(Array.from({ length: 400 }, () => makeSession(pool)))
    const outcomes = await Promise.all(
      sessions.map((session) => outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: newKey() })))
    )
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(100)
    expect(outcomes.filter((outcome) => outcome === 'SOLD_OUT')).toHaveLength(300)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 100, sold: 0 })
    expect(await countRows(pool, 'reservations', "status = 'RESERVED'")).toBe(100)
    await expectConsistent(pool)
  })

  it('never exceeds the total when requested quantities vary', async () => {
    const sale = await makeSale(pool, { total: 150, maxPerSession: 3 })
    const sessions = await Promise.all(Array.from({ length: 200 }, () => makeSession(pool)))
    const granted = await Promise.all(
      sessions.map(async (session, index) => {
        const quantity = (index % 3) + 1
        try {
          await reserve(pool, { sessionId: session.id, saleId: sale.id, quantity, idempotencyKey: newKey() })
          return quantity
        } catch (error) {
          if (error instanceof AppError && error.code === 'SOLD_OUT') return 0
          throw error
        }
      })
    )
    const total = granted.reduce((sum, quantity) => sum + quantity, 0)
    const state = await counters(pool, sale.id)
    expect(state.reserved).toBe(total)
    expect(total).toBeLessThanOrEqual(150)
    expect(150 - total).toBeLessThanOrEqual(2)
    await expectConsistent(pool)
  })

  it('enforces the per-session limit when one session sends parallel requests', async () => {
    const sale = await makeSale(pool, { total: 100, maxPerSession: 4 })
    const session = await makeSession(pool)
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: newKey() })))
    )
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(4)
    expect(outcomes.filter((outcome) => outcome === 'PURCHASE_LIMIT_EXCEEDED')).toHaveLength(6)
    expect((await counters(pool, sale.id)).reserved).toBe(4)
    await expectConsistent(pool)
  })

  it('leaves no outbox or idempotency rows behind for a rejected reservation', async () => {
    const sale = await makeSale(pool, { total: 1 })
    const [first, second] = await Promise.all([makeSession(pool), makeSession(pool)])
    const outcomes = await Promise.all(
      [first, second].map((session) => outcomeOf(reserve(pool, { sessionId: session.id, saleId: sale.id, quantity: 1, idempotencyKey: newKey() })))
    )
    expect([...outcomes].sort()).toEqual(['SOLD_OUT', 'ok'])
    expect(await countRows(pool, 'reservations')).toBe(1)
    expect(await countRows(pool, 'outbox')).toBe(1)
    expect(await countRows(pool, 'idempotency_keys')).toBe(1)
  })
})
