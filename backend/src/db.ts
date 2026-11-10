import { Pool, type PoolClient } from 'pg'
import { sleep } from './utils'

const RETRYABLE_CODES = new Set(['40001', '40P01'])

export function createPool(connectionString: string, max: number, onError: (error: Error) => void, connectionTimeoutMillis = 10000): Pool {
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000
  })
  pool.on('error', onError)
  return pool
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

async function runOnce<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let connectionError: Error | undefined
  const onClientError = (error: Error) => {
    connectionError = error
  }
  client.on('error', onClientError)
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      connectionError = connectionError ?? (rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)))
    }
    throw error
  } finally {
    client.off('error', onClientError)
    client.release(connectionError)
  }
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOnce(pool, work)
    } catch (error) {
      const code = pgErrorCode(error)
      if (attempt >= attempts || code === undefined || !RETRYABLE_CODES.has(code)) throw error
      await sleep(10 * attempt + Math.random() * 20)
    }
  }
}
