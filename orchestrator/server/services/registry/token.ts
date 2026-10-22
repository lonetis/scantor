import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import { type RegistrySigningKey, safeEqual, useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { resolveNodeToken } from '../../utils/node-tokens'
import { REGISTRY_SERVICE, REGISTRY_TOKEN_TTL_SECONDS, registryClaims, signRegistryToken } from './jwt'
import { type AllowedActions, grantAccess, nodeAllowed, orchestratorAllowed, parseScopes, type RegistryAccess } from './scopes'

// The registry token server (docs/api.md §6, docs/auth.md §10.4, docs/nodes.md §10.1): Docker daemons call the realm
// with Basic credentials, either `GET ?service&scope…` (docker login, Engine API /auth, legacy pulls) or `POST`
// with an OAuth2 password grant form (containerd, the Docker 29 image store). Credentials:
//   node:<snt_…>                         pull on tasks/<taskId> of the node's current assignments (assigned … draining)
//   orchestrator:<base64url(registry-push)>  pull, push, delete on tasks/*, plus registry:catalog:*
// Anything else is 401 in the registry error format. Responses never use the scantor error envelope.

export const NODE_USERNAME = 'node'
export const ORCHESTRATOR_USERNAME = 'orchestrator'

export type RegistrySubject = { kind: 'node'; nodeId: string } | { kind: 'orchestrator' }

export interface RegistryTokenRequest {
  /** decoded Basic credential, or null when missing or malformed */
  credential: { username: string; password: string } | null
  service: string | null
  scopes: string[]
  grantType: string | null
}

export interface RegistryTokenDeps {
  signingKey: () => RegistrySigningKey
  orchestratorPassword: () => string
  /** the node id of a valid, unrevoked node token, or null */
  nodeOf: (token: string) => Promise<string | null>
  /** repositories (`tasks/<taskId>`) of the node's active assignments */
  nodeRepositories: (nodeId: string) => Promise<Set<string>>
  now?: () => number
}

export type RegistryTokenOutcome =
  | { status: 200; body: Record<string, unknown>; subject: RegistrySubject; access: RegistryAccess[] }
  | { status: 400 | 401; body: { errors: { code: string; message: string }[] } }

function registryError(status: 400 | 401, code: string, message: string): RegistryTokenOutcome {
  return { status, body: { errors: [{ code, message }] } }
}

/** Decodes `Authorization: Basic …`; null when absent or malformed. */
export function parseBasicAuth(header: string | null | undefined): { username: string; password: string } | null {
  if (!header) return null
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header)
  if (!match) return null
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/** The GET flow: Basic credentials, repeated `scope` query values. */
export function getTokenRequest(authorization: string | null | undefined, query: URLSearchParams): RegistryTokenRequest {
  return { credential: parseBasicAuth(authorization), service: query.get('service'), scopes: query.getAll('scope'), grantType: null }
}

/** The POST flow: an OAuth2 password grant form (credentials in the form, or Basic as a fallback). */
export function postTokenRequest(authorization: string | null | undefined, form: URLSearchParams): RegistryTokenRequest {
  const username = form.get('username')
  const password = form.get('password')
  const credential = username !== null && password !== null ? { username, password } : parseBasicAuth(authorization)
  return { credential, service: form.get('service'), scopes: form.getAll('scope'), grantType: form.get('grant_type') }
}

async function authenticate(request: RegistryTokenRequest, deps: RegistryTokenDeps): Promise<RegistrySubject | null> {
  const credential = request.credential
  if (!credential) return null
  if (credential.username === ORCHESTRATOR_USERNAME) {
    return safeEqual(credential.password, deps.orchestratorPassword()) ? { kind: 'orchestrator' } : null
  }
  if (credential.username === NODE_USERNAME) {
    const nodeId = await deps.nodeOf(credential.password)
    return nodeId ? { kind: 'node', nodeId } : null
  }
  return null
}

/** Answers one token request (both flows). */
export async function issueRegistryToken(request: RegistryTokenRequest, deps: RegistryTokenDeps): Promise<RegistryTokenOutcome> {
  if (request.grantType !== null && request.grantType !== 'password') {
    return registryError(400, 'UNSUPPORTED', `grant_type ${request.grantType} is not supported`)
  }
  if (request.service !== null && request.service !== REGISTRY_SERVICE) {
    return registryError(400, 'DENIED', `unknown service ${request.service}`)
  }
  const subject = await authenticate(request, deps)
  if (!subject) return registryError(401, 'UNAUTHORIZED', 'authentication required: invalid credentials')

  const requested = parseScopes(request.scopes)
  let allowed: AllowedActions = orchestratorAllowed
  if (subject.kind === 'node') allowed = nodeAllowed(await deps.nodeRepositories(subject.nodeId))
  const access = grantAccess(requested, allowed)

  const nowMs = deps.now?.() ?? Date.now()
  const claims = registryClaims(subject.kind === 'node' ? `node:${subject.nodeId}` : 'orchestrator', access, nowMs)
  const token = signRegistryToken(claims, deps.signingKey())
  const issuedAt = new Date(claims.iat * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // The GET flow's clients read `token`; containerd's OAuth2 flow reads `access_token` (no refresh token).
  const body: Record<string, unknown> =
    request.grantType === null
      ? { token, access_token: token, expires_in: REGISTRY_TOKEN_TTL_SECONDS, issued_at: issuedAt }
      : { access_token: token, expires_in: REGISTRY_TOKEN_TTL_SECONDS, issued_at: issuedAt }
  return { status: 200, body, subject, access }
}

// ── production dependencies ─────────────────────────────────────────────────

/** Task repositories of the workers currently assigned to a node (states assigned … draining). */
export async function nodeRepositories(nodeId: string): Promise<Set<string>> {
  const repositories = await useCollections().workers.distinct('spec.repository', { nodeId, state: { $in: [...ACTIVE_WORKER_STATES] } })
  return new Set(repositories.filter((value): value is string => typeof value === 'string'))
}

export function productionTokenDeps(): RegistryTokenDeps {
  const keys = useKeys()
  return {
    signingKey: () => keys.registrySigningKey(),
    orchestratorPassword: () => keys.registryPushPassword(),
    nodeOf: async (token) => (await resolveNodeToken(token))?.node.id ?? null,
    nodeRepositories,
  }
}

export function logTokenOutcome(outcome: RegistryTokenOutcome, log: Logger): void {
  if (outcome.status === 200) {
    log.debug('registry token issued', {
      subject: outcome.subject.kind === 'node' ? `node:${outcome.subject.nodeId}` : 'orchestrator',
      access: outcome.access.map((entry) => `${entry.type}:${entry.name}:${entry.actions.join(',')}`),
    })
  } else {
    log.info('registry token refused', { status: outcome.status, code: outcome.body.errors[0]?.code })
  }
}
