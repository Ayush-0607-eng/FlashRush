import path from 'node:path'
import { runMigrations } from '../src/migrate'

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL must be set. Run the tests through docker compose.')
  const directory = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations')
  await runMigrations(url, directory)
}
