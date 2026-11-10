import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

const MIGRATION_LOCK_ID = 727274

export async function runMigrations(databaseUrl: string, directory: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    )
    const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const completed = new Set(done.rows.map((row) => row.name))
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      if (completed.has(file)) continue
      const sql = await readFile(path.join(directory, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return applied
  } finally {
    await client.end()
  }
}
