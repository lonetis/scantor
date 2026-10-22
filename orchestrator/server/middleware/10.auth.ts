import { defineEventHandler, getRequestHeader, type H3Event, setResponseHeaders, setResponseStatus } from 'h3'
import { trustedOrigins } from '../utils/auth-policy'
import { useAuth } from '../utils/auth'
import { isBootComplete } from '../utils/boot'
import { useConfig } from '../utils/config'
import { applyOpenCors, handleOpenCorsPreflight, isOpenCorsPath } from '../utils/cors'
import { apiError } from '../utils/errors'
import { capabilityRequestOf, consumeInternalCapability, INTERNAL_AUTH_HEADER } from '../utils/internal-auth'
import { useLogger } from '../utils/logger'
import { resolveNodeToken } from '../utils/node-tokens'
import { matchOperation, type Operation, useOperationRegistry } from '../utils/operations'
import {
  apiKeyConfigIdOf,
  bearerValue,
  classifyUserCredential,
  effectiveAdmin,
  looksLikeApiKey,
  type Principal,
  toUserRole,
  type UserPrincipal,
} from '../utils/principal'
import { checkSetupToken } from '../utils/setup'
import { getCachedUser, isUserBanned, toCachedUser } from '../utils/user-cache'
import { checkClientVersion, scantorVersion } from '../utils/version'
import { resolveWorkerToken } from '../utils/worker-tokens'

// The global auth middleware (docs/auth.md §5.5, docs/api.md §1.2) for `/api/*` on the dashboard listener:
// route prefix → credential → operation registry (deny by default) → scope, session-only and MCP level → ban →
// CSRF. It stores `event.context.principal` and `event.context.operation`. `/mcp` authenticates itself.

const log = useLogger('auth')

/** Nitro's built-in OpenAPI routes: public and not part of the operation registry. */
const DOCS_PATHS = new Set(['/api/docs', '/api/docs/openapi.json'])
/** Public operations whose credentials are never validated (their scope is checked against the registry). */
const PUBLIC_PATHS = new Set(['/api/health'])
/**
 * Paths served while boot is still running: health, and the OpenAPI document, which boot itself reads to build the
 * operation registry.
 */
const BOOT_EXEMPT_PATHS = new Set(['/api/health', ...DOCS_PATHS])
/** Traefik's forwardAuth route, which never answers with the JSON error envelope (docs/api.md §4.18). */
const FORWARD_AUTH_PATH = '/api/tools/forward-auth'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function carriesApiKey(event: H3Event): boolean {
  return !!getRequestHeader(event, 'x-api-key') || looksLikeApiKey(bearerValue(getRequestHeader(event, 'authorization')))
}

function assertVersion(event: H3Event): void {
  const check = checkClientVersion(scantorVersion, getRequestHeader(event, 'x-scantor-version'))
  if (!check.ok) {
    throw apiError('incompatibleVersion', `client version is outside the supported window (minimum ${check.minVersion})`, {
      serverVersion: check.serverVersion,
      minVersion: check.minVersion,
    })
  }
}

async function forwardSessionCookies(event: H3Event, headers: Headers | undefined): Promise<void> {
  const cookies = headers?.getSetCookie?.() ?? []
  for (const cookie of cookies) event.node.res.appendHeader('set-cookie', cookie)
}

interface SessionResult {
  session: { id: string; createdAt: string | Date }
  user: Record<string, unknown>
}

async function sessionFrom(headers: Headers): Promise<{ result: SessionResult | null; headers?: Headers }> {
  try {
    const response = (await useAuth().api.getSession({ headers, returnHeaders: true })) as {
      response: SessionResult | null
      headers?: Headers
    }
    return { result: response.response, headers: response.headers }
  } catch {
    return { result: null }
  }
}

function userRefOf(user: Record<string, unknown>) {
  return { id: String(user.id), email: String(user.email ?? ''), name: String(user.name ?? ''), role: toUserRole(user.role) }
}

/** Resolves the user principal of a user route (docs/auth.md §5.2), or throws 401. */
async function resolveUserPrincipal(event: H3Event, pathname: string): Promise<{ principal: UserPrincipal; banned: boolean }> {
  const credential = classifyUserCredential({
    internalAuth: getRequestHeader(event, INTERNAL_AUTH_HEADER),
    apiKey: getRequestHeader(event, 'x-api-key'),
    authorization: getRequestHeader(event, 'authorization'),
    cookie: getRequestHeader(event, 'cookie'),
  })
  switch (credential.kind) {
    case 'internal': {
      const capability = consumeInternalCapability(credential.token, capabilityRequestOf(event.node.req, pathname))
      if (!capability) throw apiError('unauthorized', 'invalid or expired internal capability')
      const user = await getCachedUser(capability.principal.user.id)
      if (!user) throw apiError('unauthorized', 'user no longer exists')
      const snapshot = capability.principal
      const level = snapshot.mcp?.level ?? 'read'
      const principal: UserPrincipal = {
        kind: 'user',
        via: 'mcp',
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        isAdmin: effectiveAdmin(user.role, 'mcp', snapshot.apiKey?.configId, level),
        ...(snapshot.apiKey ? { apiKey: snapshot.apiKey } : {}),
        mcp: { clientId: snapshot.mcp?.clientId ?? null, level, operationId: capability.operationId },
      }
      return { principal, banned: isUserBanned(user) }
    }
    case 'apiKey': {
      const { result } = await sessionFrom(new Headers({ 'x-api-key': credential.key }))
      if (!result) throw apiError('unauthorized', 'invalid or expired API key')
      const configId = apiKeyConfigIdOf(credential.key)
      const user = userRefOf(result.user)
      return {
        principal: {
          kind: 'user',
          via: 'apiKey',
          user,
          isAdmin: effectiveAdmin(user.role, 'apiKey', configId),
          apiKey: { id: String(result.session.id), configId },
        },
        banned: isUserBanned(toCachedUser(result.user)),
      }
    }
    case 'session': {
      const { result, headers } = await sessionFrom(new Headers({ cookie: credential.cookie }))
      if (!result) throw apiError('unauthorized', 'session expired or invalid')
      await forwardSessionCookies(event, headers)
      const user = userRefOf(result.user)
      return {
        principal: {
          kind: 'user',
          via: 'session',
          user,
          isAdmin: effectiveAdmin(user.role, 'session'),
          sessionId: String(result.session.id),
          sessionCreatedAt: new Date(result.session.createdAt),
        },
        banned: isUserBanned(toCachedUser(result.user)),
      }
    }
    default:
      throw apiError('unauthorized', 'authentication required')
  }
}

function enforceScope(operation: Operation, principal: Principal | null, pathname: string): void {
  if (operation.problems.length > 0) {
    log.error('operation violates the OpenAPI extension rules; refusing it', {
      operationId: operation.operationId,
      problems: operation.problems,
    })
    throw apiError('forbidden', 'this operation is misconfigured')
  }
  switch (operation.scope) {
    case 'public':
      return
    case 'owner':
      if (principal?.kind !== 'user') throw apiError('unauthorized', 'authentication required')
      break
    case 'admin':
      if (principal?.kind !== 'user') throw apiError('unauthorized', 'authentication required')
      if (!principal.isAdmin) throw apiError('adminRequired', 'this operation requires an admin')
      break
    case 'node':
      // The registry token route parses its Basic credential itself.
      if (pathname === '/api/registry/token') return
      if (principal?.kind !== 'node') throw apiError('unauthorized', 'node token required')
      return
    case 'worker':
      if (principal?.kind !== 'worker') throw apiError('unauthorized', 'worker token required')
      return
    case 'setup':
      if (principal?.kind !== 'setup') throw apiError('setupTokenInvalid', 'setup token required')
      return
    case 'tools':
      // The forward-auth route parses the tools cookie itself.
      return
  }
  const user = principal as UserPrincipal
  if (operation.sessionOnly && user.via !== 'session') throw apiError('sessionRequired', 'this operation requires a browser session')
  if (user.via === 'mcp') {
    const level = user.mcp?.level ?? 'read'
    if (user.mcp?.operationId !== operation.operationId) throw apiError('unauthorized', 'capability bound to another operation')
    const needed = operation.adminOnly ? 'admin' : operation.method === 'GET' || operation.readOnly ? 'read' : 'write'
    const order = { read: 0, write: 1, admin: 2 } as const
    if (order[level] < order[needed]) throw apiError('forbidden', `this operation needs MCP level ${needed}`)
  }
}

export default defineEventHandler(async (event) => {
  const pathname = event.path.split('?')[0] ?? '/'
  if (!pathname.startsWith('/api/') && pathname !== '/api') return

  if (!isBootComplete() && !BOOT_EXEMPT_PATHS.has(pathname)) {
    if (pathname === FORWARD_AUTH_PATH) {
      setResponseStatus(event, 503)
      setResponseHeaders(event, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return 'Service Unavailable\n'
    }
    throw apiError('unavailable', 'the orchestrator is starting')
  }

  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    if (carriesApiKey(event)) throw apiError('unauthorized', 'API keys cannot be used on /api/auth')
    if (handleOpenCorsPreflight(event, pathname)) return
    if (isOpenCorsPath(pathname)) applyOpenCors(event)
    return
  }

  if (DOCS_PATHS.has(pathname)) {
    event.context.principal = null
    return
  }

  let principal: Principal | null = null
  let banned = false
  if (PUBLIC_PATHS.has(pathname)) {
    principal = null
  } else if (pathname.startsWith('/api/node/')) {
    const token = bearerValue(getRequestHeader(event, 'authorization'))
    principal = token?.startsWith('snt_') ? await resolveNodeToken(token) : null
    if (!principal) throw apiError('unauthorized', 'unknown or revoked node token')
    assertVersion(event)
  } else if (pathname.startsWith('/api/runtime/')) {
    const token = bearerValue(getRequestHeader(event, 'authorization'))
    principal = token?.startsWith('swt_') ? await resolveWorkerToken(token) : null
    if (!principal) throw apiError('unauthorized', 'invalid worker token')
    assertVersion(event)
  } else if (pathname === '/api/registry/token' || pathname === FORWARD_AUTH_PATH) {
    principal = null
  } else if (pathname.startsWith('/api/setup/')) {
    if (!(pathname === '/api/setup/status' && (event.method === 'GET' || event.method === 'HEAD'))) {
      const check = await checkSetupToken(getRequestHeader(event, 'x-scantor-setup-token'))
      if (check === 'completed') throw apiError('setupCompleted', 'setup is already completed')
      if (check === 'invalid') throw apiError('setupTokenInvalid', 'missing or wrong setup token')
      principal = { kind: 'setup' }
    }
  } else {
    const resolved = await resolveUserPrincipal(event, pathname)
    principal = resolved.principal
    banned = resolved.banned
  }

  const registry = await useOperationRegistry()
  const match = matchOperation(registry, event.method, pathname)
  if (match.kind === 'notFound') throw apiError('notFound', `no operation at ${pathname}`)
  if (match.kind === 'methodNotAllowed') {
    event.node.res.setHeader('Allow', match.allowed.join(', '))
    throw apiError('methodNotAllowed', `${event.method} is not allowed here`, { allowed: match.allowed })
  }
  enforceScope(match.operation, principal, pathname)

  if (principal?.kind === 'user') {
    if (banned) throw apiError('banned', 'this account is banned')
    if (principal.via === 'session' && UNSAFE_METHODS.has(event.method)) {
      const origin = getRequestHeader(event, 'origin')
      if (!origin || !trustedOrigins(useConfig()).includes(origin)) {
        throw apiError('forbidden', 'untrusted request origin')
      }
    }
  }

  event.context.principal = principal
  event.context.operation = match.operation
})
