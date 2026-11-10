import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelReservation, checkout } from '../src/domain/checkout'
import { reconcile } from '../src/domain/reconciliation'
import { countRows, counters, hold, makeSale, newKey, openPool, resetDatabase } from './helpers'

describe('inventory reconciliation', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('reports a clean system', async () => {
    const sale = await makeSale(pool)
    const first = await hold(pool, sale.id, 2)
    await hold(pool, sale.id)
    await checkout(pool, { sessionId: first.session.id, reservationId: first.reservation.id, outcome: 'success', idempotencyKey: newKey() })
    expect(await reconcile(pool, { repair: false })).toEqual({ checked: 1, discrepancies: [], repaired: 0 })
  })

  it('detects drifted counters without changing them in report mode', async () => {
    const sale = await makeSale(pool)
    await hold(pool, sale.id, 3)
    await pool.query('UPDATE sales SET reserved = reserved + 1, sold = sold + 2 WHERE id = $1', [sale.id])
    const report = await reconcile(pool, { repair: false })
    expect(report.discrepancies).toEqual(
      expect.arrayContaining([
        { saleId: sale.id, field: 'reserved', recorded: 4, expected: 3 },
        { saleId: sale.id, field: 'sold', recorded: 2, expected: 0 }
      ])
    )
    expect(report.repaired).toBe(0)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 4, sold: 2 })
  })

  it('repairs drifted counters from the reservation rows', async () => {
    const sale = await makeSale(pool)
    await hold(pool, sale.id, 3)
    await pool.query('UPDATE sales SET reserved = 50, sold = 7 WHERE id = $1', [sale.id])
    const repaired = await reconcile(pool, { repair: true })
    expect(repaired.repaired).toBe(1)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 3, sold: 0 })
    expect((await reconcile(pool, { repair: false })).discrepancies).toEqual([])
  })

  it('flags overcommitted sales instead of repairing them', async () => {
    const sale = await makeSale(pool, { total: 5, maxPerSession: 10 })
    const { session } = await hold(pool, sale.id, 1)
    await pool.query(
      `INSERT INTO reservations (sale_id, session_id, quantity, unit_price_minor, expires_at) VALUES ($1, $2, 8, 100, now() + interval '5 minutes')`,
      [sale.id, session.id]
    )
    const report = await reconcile(pool, { repair: true })
    expect(report.discrepancies.some((item) => item.field === 'overcommitted' && item.expected === 9)).toBe(true)
    expect(await counters(pool, sale.id)).toEqual({ total: 5, reserved: 1, sold: 0 })
  })

  it('detects an order that is missing for a confirmed reservation', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
    await pool.query('DELETE FROM orders')
    const report = await reconcile(pool, { repair: false })
    expect(report.discrepancies).toEqual([{ saleId: sale.id, field: 'orders', recorded: 0, expected: 1 }])
  })

  it('stays consistent while reservations, payments and cancellations run concurrently', async () => {
    const sale = await makeSale(pool, { total: 80 })
    let running = true
    const reports: number[] = []
    const checker = (async () => {
      while (running) {
        reports.push((await reconcile(pool, { repair: false })).discrepancies.length)
      }
    })()
    const traffic = Array.from({ length: 100 }, async (_, index) => {
      try {
        const { session, reservation } = await hold(pool, sale.id)
        if (index % 3 === 0) await cancelReservation(pool, session.id, reservation.id)
        else if (index % 3 === 1) await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error as { code: string }).code === 'SOLD_OUT')) throw error
      }
    })
    await Promise.all(traffic)
    running = false
    await checker
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.every((count) => count === 0)).toBe(true)
    const state = await counters(pool, sale.id)
    expect(state.reserved + state.sold).toBeLessThanOrEqual(80)
    expect(state.sold).toBe(await countRows(pool, 'orders'))
  })
})
