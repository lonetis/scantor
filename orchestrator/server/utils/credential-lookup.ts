import { isAPIError } from 'better-auth/api'
import { useAuth } from './auth'
import { apiError } from './errors'
import { useLogger } from './logger'

// Session cookie and API key lookups through better-auth (docs/auth.md §5.2), shared by the auth middleware and `/mcp`.
// better-auth rejects an unknown, expired or disabled credential with a 4xx APIError. A 5xx APIError (better-auth wraps
// database errors that way) or any other error means the credential could not be checked at all: that is 503
// `unavailable`, never 401, so a MongoDB election does not sign browsers out or make clients drop a valid key.

const log = useLogger('auth')

export interface SessionLookup {
  session: { id: string; createdAt: string | Date }
  user: Record<string, unknown>
}

/** True when better-auth rejected the presented credential, as opposed to failing to check it. */
export function isCredentialRejection(error: unknown): boolean {
  return isAPIError(error) && error.statusCode < 500
}

/**
 * The session behind a cookie or `x-api-key` header, or `result: null` when better-auth rejects the credential;
 * `headers` are the response headers of the lookup (a refreshed session cookie). A failed lookup throws 503
 * `unavailable`.
 */
export async function lookupSession(credential: Headers): Promise<{ result: SessionLookup | null; headers?: Headers }> {
  try {
    const response = (await useAuth().api.getSession({ headers: credential, returnHeaders: true })) as {
      response: SessionLookup | null
      headers?: Headers
    }
    return { result: response.response, headers: response.headers }
  } catch (error) {
    if (isCredentialRejection(error)) return { result: null }
    log.error('the credential lookup failed', { err: error })
    throw apiError('unavailable', 'the credential cannot be checked right now; retry shortly')
  }
}
