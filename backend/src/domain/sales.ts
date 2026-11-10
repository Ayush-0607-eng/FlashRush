import type { Pool } from 'pg'
import { constraintViolation, saleNotFound, validationFailed } from '../errors'
import { pgErrorCode } from '../db'

export interface SaleInput {
  name: string
  description: string
  priceMinor: number
  total: number
  maxPerSession: number
  holdSeconds: number
  startsAt: Date
  endsAt: Date
}

export type SaleStatus = 'SCHEDULED' | 'ACTIVE' | 'SOLD_OUT' | 'ENDED'

export interface SaleView {
  id: string
  name: string
  description: string
  priceMinor: number
  total: number
  reserved: number
  sold: number
  available: number
  maxPerSession: number
  holdSeconds: number
  startsAt: string
  endsAt: string
  status: SaleStatus
  serverTime: string
}

interface SaleRow {
  id: string
  name: string
  description: string
  price_minor: number
  total: number
  reserved: number
  sold: number
  available: number
  max_per_session: number
  hold_seconds: number
  starts_at: Date
  ends_at: Date
  status: SaleStatus
  server_time: Date
}

const SALE_SELECT = `
  SELECT s.*,
    GREATEST(s.total - s.reserved - s.sold, 0) AS available,
    CASE
      WHEN now() < s.starts_at THEN 'SCHEDULED'
      WHEN now() >= s.ends_at THEN 'ENDED'
      WHEN s.total - s.reserved - s.sold <= 0 THEN 'SOLD_OUT'
      ELSE 'ACTIVE'
    END AS status,
    now() AS server_time
  FROM sales s`

function toSaleView(row: SaleRow): SaleView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMinor: row.price_minor,
    total: row.total,
    reserved: row.reserved,
    sold: row.sold,
    available: row.available,
    maxPerSession: row.max_per_session,
    holdSeconds: row.hold_seconds,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status,
    serverTime: row.server_time.toISOString()
  }
}

function rethrowConstraint(error: unknown): never {
  if (pgErrorCode(error) === '23514') throw constraintViolation()
  throw error
}

export async function createSale(pool: Pool, input: SaleInput): Promise<SaleView> {
  try {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sales (name, description, price_minor, total, max_per_session, hold_seconds, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.name, input.description, input.priceMinor, input.total, input.maxPerSession, input.holdSeconds, input.startsAt, input.endsAt]
    )
    return await getSale(pool, inserted.rows[0].id)
  } catch (error) {
    return rethrowConstraint(error)
  }
}

const UPDATABLE_COLUMNS: Record<keyof SaleInput, string> = {
  name: 'name',
  description: 'description',
  priceMinor: 'price_minor',
  total: 'total',
  maxPerSession: 'max_per_session',
  holdSeconds: 'hold_seconds',
  startsAt: 'starts_at',
  endsAt: 'ends_at'
}

export async function updateSale(pool: Pool, id: string, changes: Partial<SaleInput>): Promise<SaleView> {
  const assignments: string[] = []
  const values: unknown[] = [id]
  for (const key of Object.keys(UPDATABLE_COLUMNS) as (keyof SaleInput)[]) {
    const value = changes[key]
    if (value === undefined) continue
    values.push(value)
    assignments.push(`${UPDATABLE_COLUMNS[key]} = $${values.length}`)
  }
  if (assignments.length === 0) throw validationFailed([{ path: '', message: 'No updatable fields were provided' }])
  try {
    const result = await pool.query(`UPDATE sales SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1`, values)
    if (result.rowCount === 0) throw saleNotFound()
  } catch (error) {
    return rethrowConstraint(error)
  }
  return getSale(pool, id)
}

export async function getSale(pool: Pool, id: string): Promise<SaleView> {
  const { rows } = await pool.query<SaleRow>(`${SALE_SELECT} WHERE s.id = $1`, [id])
  if (rows.length === 0) throw saleNotFound()
  return toSaleView(rows[0])
}

export async function listSales(pool: Pool): Promise<SaleView[]> {
  const { rows } = await pool.query<SaleRow>(`${SALE_SELECT} ORDER BY s.starts_at ASC, s.id ASC LIMIT 200`)
  return rows.map(toSaleView)
}
