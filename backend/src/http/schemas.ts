import { z } from 'zod'

const saleFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  priceMinor: z.number().int().min(1).max(100_000_000),
  total: z.number().int().min(1).max(1_000_000),
  maxPerSession: z.number().int().min(1).max(10),
  holdSeconds: z.number().int().min(5).max(3600),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date()
}

export const createSaleSchema = z
  .object({
    ...saleFields,
    description: saleFields.description.default(''),
    maxPerSession: saleFields.maxPerSession.default(4),
    holdSeconds: saleFields.holdSeconds.default(300)
  })
  .strict()
  .refine((value) => value.endsAt > value.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] })

export const updateSaleSchema = z.object(saleFields).partial().strict()

export const reserveSchema = z.object({ quantity: z.number().int().min(1).max(10) }).strict()

export const checkoutSchema = z.object({ outcome: z.enum(['success', 'fail']) }).strict()

export const reconcileSchema = z.object({ repair: z.boolean().default(false) }).strict()

export const uuidSchema = z.string().uuid()

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
