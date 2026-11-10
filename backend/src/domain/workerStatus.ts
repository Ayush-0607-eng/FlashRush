import type { Pool } from 'pg'

export async function recordStatus(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO worker_status (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  )
}

export interface StatusRecord {
  value: unknown
  ageSeconds: number
}

export async function readStatus(pool: Pool, key: string): Promise<StatusRecord | null> {
  const { rows } = await pool.query<{ value: unknown; age_seconds: number }>(
    'SELECT value, EXTRACT(EPOCH FROM (now() - updated_at))::float8 AS age_seconds FROM worker_status WHERE key = $1',
    [key]
  )
  return rows.length > 0 ? { value: rows[0].value, ageSeconds: rows[0].age_seconds } : null
}
