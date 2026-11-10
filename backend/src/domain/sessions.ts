import { createHmac, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export const SESSION_COOKIE = 'fr_sid'

function hashToken(secret: string, token: string): Buffer {
  return createHmac('sha256', secret).update(token).digest()
}

export async function createSession(pool: Pool, secret: string, ttlHours: number): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('base64url')
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + make_interval(hours => $2::int)) RETURNING id',
    [hashToken(secret, token), ttlHours]
  )
  return { id: rows[0].id, token }
}

export async function findSession(pool: Pool, secret: string, token: string): Promise<string | null> {
  if (token.length < 20 || token.length > 100) return null
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [
    hashToken(secret, token)
  ])
  return rows.length > 0 ? rows[0].id : null
}
