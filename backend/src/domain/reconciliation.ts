import type { Pool } from 'pg'
import { withTransaction } from '../db'

export interface Discrepancy {
  saleId: string
  field: 'reserved' | 'sold' | 'orders' | 'overcommitted'
  recorded: number
  expected: number
}

export interface ReconcileReport {
  checked: number
  discrepancies: Discrepancy[]
  repaired: number
}

interface SaleCounters {
  id: string
  total: number
  reserved: number
  sold: number
}

interface Derived {
  reserved: number
  sold: number
  orders: number
}

export async function reconcile(pool: Pool, options: { repair: boolean }): Promise<ReconcileReport> {
  const ids = await pool.query<{ id: string }>('SELECT id FROM sales ORDER BY id')
  const report: ReconcileReport = { checked: 0, discrepancies: [], repaired: 0 }
  for (const { id } of ids.rows) {
    const outcome = await reconcileSale(pool, id, options.repair)
    if (!outcome) continue
    report.checked += 1
    report.discrepancies.push(...outcome.found)
    if (outcome.repaired) report.repaired += 1
  }
  return report
}

async function reconcileSale(pool: Pool, saleId: string, repair: boolean): Promise<{ found: Discrepancy[]; repaired: boolean } | null> {
  return withTransaction(pool, async (client) => {
    const sale = await client.query<SaleCounters>('SELECT id, total, reserved, sold FROM sales WHERE id = $1 FOR UPDATE', [saleId])
    if (sale.rows.length === 0) return null
    const recorded = sale.rows[0]
    const derived = await client.query<Derived>(
      `SELECT
         COALESCE((SELECT SUM(quantity) FROM reservations WHERE sale_id = $1 AND status = 'RESERVED'), 0)::int AS reserved,
         COALESCE((SELECT SUM(quantity) FROM reservations WHERE sale_id = $1 AND status = 'CONFIRMED'), 0)::int AS sold,
         COALESCE((SELECT SUM(quantity) FROM orders WHERE sale_id = $1), 0)::int AS orders`,
      [saleId]
    )
    const expected = derived.rows[0]
    const found: Discrepancy[] = []
    if (recorded.reserved !== expected.reserved) found.push({ saleId, field: 'reserved', recorded: recorded.reserved, expected: expected.reserved })
    if (recorded.sold !== expected.sold) found.push({ saleId, field: 'sold', recorded: recorded.sold, expected: expected.sold })
    if (expected.orders !== expected.sold) found.push({ saleId, field: 'orders', recorded: expected.orders, expected: expected.sold })
    const committed = expected.reserved + expected.sold
    const overcommitted = committed > recorded.total
    if (overcommitted) found.push({ saleId, field: 'overcommitted', recorded: recorded.total, expected: committed })

    const counterDrift = recorded.reserved !== expected.reserved || recorded.sold !== expected.sold
    if (repair && counterDrift && !overcommitted) {
      await client.query('UPDATE sales SET reserved = $2, sold = $3, updated_at = now() WHERE id = $1', [saleId, expected.reserved, expected.sold])
      return { found, repaired: true }
    }
    return { found, repaired: false }
  })
}
