import pino, { type Logger } from 'pino'

export type { Logger }

export function createLogger(level: string, service: string): Logger {
  return pino({
    level,
    base: { service },
    redact: ['req.headers.cookie', 'req.headers["x-admin-token"]', 'headers.cookie', 'headers["x-admin-token"]']
  })
}
