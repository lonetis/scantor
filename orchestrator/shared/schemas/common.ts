import { z } from 'zod'

// Building blocks of the request schemas (docs/api.md §1.5, §1.8, §1.9). Every request schema is strict: unknown
// keys are rejected. Query strings arrive as strings, so query schemas use the q* helpers below.

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200
export const MAX_WAIT_SECONDS = 120

export const uuid = () => z.uuid()

/** A bounded, trimmed, non-empty string. */
export const text = (max: number, min = 1) => z.string().trim().min(min).max(max)

export const emailAddress = () => z.email().max(254).transform((value) => value.toLowerCase())

/** A boolean query value: exactly `true` or `false`. */
export const qBoolean = () => z.enum(['true', 'false']).transform((value) => value === 'true')

/** A decimal integer query value within bounds. */
export const qInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^-?\d{1,16}$/, 'must be a decimal integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))

/** A comma-separated list query value; whitespace is trimmed and empty entries are dropped. */
export const qList = <T extends z.ZodType<unknown, string>>(item: T, maxItems = 32) =>
  z
    .string()
    .max(4096)
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(item).max(maxItems))

export const cursorQuery = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, 'must be an opaque cursor')

/** `?limit&cursor` of cursor-paginated lists. */
export const pageQueryShape = {
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
  cursor: cursorQuery.optional(),
}

export const pageQuery = z.strictObject(pageQueryShape)

/** `?wait` of long-poll operations, in seconds. */
export const waitQueryShape = {
  wait: qInt(0, MAX_WAIT_SECONDS).optional(),
}

export const waitQuery = z.strictObject(waitQueryShape)

/** An optional `userId` list filter; non-admins may only pass their own id. */
export const userIdFilterShape = {
  userId: z.uuid().optional(),
}

export const emptyQuery = z.strictObject({})
export const emptyBody = z.strictObject({})
