import type { Logger } from 'pino'

declare global {
  namespace Express {
    interface Request {
      requestId: string
      sessionId?: string
      log: Logger
    }
  }
}

export {}
