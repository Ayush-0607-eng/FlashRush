import { z } from 'zod'

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(20),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  ADMIN_TOKEN: z.preprocess(emptyToUndefined, z.string().min(24).optional()),
  ALLOWED_ORIGINS: z.string().default('http://localhost:18473'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_READ_CAPACITY: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_READ_REFILL_PER_SEC: z.coerce.number().min(0.001).default(60),
  RATE_LIMIT_BOOK_CAPACITY: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_BOOK_REFILL_PER_SEC: z.coerce.number().min(0.001).default(10),
  RATE_LIMIT_FAIL_MODE: z.enum(['open', 'closed']).default('open'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(500).default(5000)
})

export type Config = z.infer<typeof schema> & { cookieSecure: boolean; allowedOrigins: string[] }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`)
  }
  const data = parsed.data
  if (data.NODE_ENV === 'production' && data.SESSION_SECRET.includes('change-me')) {
    throw new Error('Invalid configuration:\n  SESSION_SECRET: replace the placeholder value before running in production')
  }
  if (data.NODE_ENV === 'production' && data.ADMIN_TOKEN?.includes('change-me')) {
    throw new Error('Invalid configuration:\n  ADMIN_TOKEN: replace the placeholder value before running in production')
  }
  const cookieSecure = data.COOKIE_SECURE ? data.COOKIE_SECURE === 'true' : data.NODE_ENV === 'production'
  if (data.COOKIE_SAMESITE === 'none' && !cookieSecure) {
    throw new Error('Invalid configuration:\n  COOKIE_SAMESITE: "none" requires COOKIE_SECURE=true')
  }
  const allowedOrigins = data.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  return { ...data, cookieSecure, allowedOrigins }
}
