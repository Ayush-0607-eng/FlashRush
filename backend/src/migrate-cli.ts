import { runMigrations } from './migrate'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations')
  const directory = process.env.MIGRATIONS_DIR ?? '/app/migrations'
  const applied = await runMigrations(databaseUrl, directory)
  console.log(applied.length === 0 ? 'No pending migrations' : `Applied migrations: ${applied.join(', ')}`)
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
