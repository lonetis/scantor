import { z } from 'zod'
import { USER_ROLES } from '../utils/enums'
import { emailAddress, pageQueryShape, text } from './common'

// Request schemas of the `users` tag (docs/api.md §4.4).

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export const password = () => z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH)
export const personName = () => text(100)

export const userIdParams = z.strictObject({ userId: z.uuid() })

export const listUsersQuery = z.strictObject({
  ...pageQueryShape,
  q: text(254).optional(),
})

export const createUserBody = z.strictObject({
  email: emailAddress(),
  name: personName(),
  password: password().optional(),
  role: z.enum(USER_ROLES).default('user'),
  canRunPrivileged: z.boolean().default(false),
  maxWorkers: z.number().int().min(0).max(100_000).optional(),
})
export type CreateUserBody = z.infer<typeof createUserBody>

export const updateUserBody = z
  .strictObject({
    name: personName().optional(),
    email: emailAddress().optional(),
    role: z.enum(USER_ROLES).optional(),
    canRunPrivileged: z.boolean().optional(),
    maxWorkers: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'at least one field is required')
export type UpdateUserBody = z.infer<typeof updateUserBody>

export const setUserPasswordBody = z.strictObject({ password: password() })

export const banUserBody = z.strictObject({
  reason: text(500).optional(),
  cancelScans: z.boolean().default(false),
})
export type BanUserBody = z.infer<typeof banUserBody>
