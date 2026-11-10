import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) {
  console.error('.env already exists. Delete it first if you want new secrets.')
  process.exit(1)
}

const secret = (bytes) => randomBytes(bytes).toString('hex')
const generated = {
  POSTGRES_PASSWORD: secret(16),
  SESSION_SECRET: secret(32),
  ADMIN_TOKEN: secret(24)
}

const lines = readFileSync('.env.example', 'utf8')
  .split('\n')
  .map((line) => {
    const name = line.split('=')[0]
    return name in generated ? `${name}=${generated[name]}` : line
  })

writeFileSync('.env', lines.join('\n'))
console.log('Created .env with freshly generated secrets.')
