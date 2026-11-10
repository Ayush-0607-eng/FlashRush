export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const saleNotFound = () => new AppError(404, 'SALE_NOT_FOUND', 'Sale not found')
export const saleNotActive = () => new AppError(409, 'SALE_NOT_ACTIVE', 'The sale is not open right now')
export const soldOut = () => new AppError(409, 'SOLD_OUT', 'Not enough inventory remaining')
export const invalidQuantity = (max: number) => new AppError(422, 'INVALID_QUANTITY', `Quantity must be between 1 and ${max}`)
export const purchaseLimitExceeded = (max: number) => new AppError(409, 'PURCHASE_LIMIT_EXCEEDED', `A session may hold at most ${max} tickets for this sale`)
export const reservationNotFound = () => new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found')
export const reservationExpired = () => new AppError(410, 'RESERVATION_EXPIRED', 'The reservation has expired')
export const reservationCancelled = () => new AppError(409, 'RESERVATION_CANCELLED', 'The reservation was cancelled')
export const reservationAlreadyConfirmed = () => new AppError(409, 'RESERVATION_ALREADY_CONFIRMED', 'The reservation is already confirmed')
export const idempotencyKeyRequired = () => new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header of 8 to 128 safe characters is required')
export const idempotencyKeyReused = () => new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request')
export const validationFailed = (details?: unknown) => new AppError(400, 'VALIDATION_ERROR', 'The request is invalid', details)
export const sessionRequired = () => new AppError(401, 'SESSION_REQUIRED', 'A valid demo session is required')
export const csrfHeaderRequired = () => new AppError(403, 'CSRF_HEADER_REQUIRED', 'The X-Requested-With header is required')
export const adminRequired = () => new AppError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required')
export const adminDisabled = () => new AppError(403, 'ADMIN_DISABLED', 'Administrative operations are disabled on this deployment')
export const rateLimited = (retryAfterSeconds: number) => new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSeconds })
export const rateLimiterUnavailable = () => new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request limiting is temporarily unavailable')
export const constraintViolation = () => new AppError(422, 'CONSTRAINT_VIOLATION', 'The change violates an inventory or schedule constraint')
