import { getQuery, getRequestHeader, getRouterParams, readRawBody, type H3Event } from 'h3'
import type { z } from 'zod'
import type { ValidationIssue } from '#shared/types/common'
import { apiError, validationError } from './errors'

// Request validation (docs/api.md §1.5): every body, query and path parameter is parsed with a strict zod schema.
// Body and query failures are 400 `validationFailed` with `details.issues`; a path parameter that does not parse
// names no resource and is 404 `notFound` (docs/api.md §1.4). JSON bodies are capped by the per-route limit that
// middleware/02.body-limit.ts stores in `event.context.bodyLimit`.

/** `details.issues` of a validation failure: dot paths; unknown keys are reported one by one at their own path. */
export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map(String)
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ path: [...path, key].join('.'), message: 'unknown field' }))
    }
    return [{ path: path.join('.'), message: issue.message }]
  })
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false
  const type = value.split(';')[0]!.trim().toLowerCase()
  return type === 'application/json' || type.endsWith('+json')
}

/**
 * Reads and parses a JSON request body. An empty body is `undefined`; a non-empty body must be
 * `application/json` (415), well-formed (400 badRequest) and within the route's body cap (413).
 */
export async function readJsonBody(event: H3Event): Promise<unknown> {
  const raw = await readRawBody(event, false)
  if (!raw || raw.length === 0) return undefined
  const limit = typeof event.context.bodyLimit === 'number' ? event.context.bodyLimit : undefined
  if (limit !== undefined && raw.length > limit) {
    throw apiError('payloadTooLarge', `request body exceeds ${limit} bytes`, { limit, actual: raw.length })
  }
  if (!isJsonContentType(getRequestHeader(event, 'content-type'))) {
    throw apiError('unsupportedMediaType', 'request body must be application/json')
  }
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw apiError('badRequest', 'request body is not valid JSON')
  }
}

/** Parses the JSON body with `schema`; a missing body is validated as `{}`. */
export async function validateBody<T extends z.ZodType>(event: H3Event, schema: T): Promise<z.output<T>> {
  const body = await readJsonBody(event)
  const result = schema.safeParse(body === undefined ? {} : body)
  if (!result.success) throw validationError(zodIssues(result.error))
  return result.data
}

/** Parses the query string with `schema` (values are strings; repeated keys are rejected). */
export function validateQuery<T extends z.ZodType>(event: H3Event, schema: T): z.output<T> {
  const query = getQuery(event)
  const result = schema.safeParse(query)
  if (!result.success) throw validationError(zodIssues(result.error), 'query validation failed')
  return result.data
}

/** Parses the decoded path parameters with `schema`; any failure is 404 notFound. */
export function validateParams<T extends z.ZodType>(event: H3Event, schema: T): z.output<T> {
  const result = schema.safeParse(getRouterParams(event, { decode: true }))
  if (!result.success) throw apiError('notFound', 'resource not found')
  return result.data
}

/** Parses an arbitrary value (for example a nested config) and throws validationFailed on failure. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw validationError(zodIssues(result.error))
  return result.data
}
