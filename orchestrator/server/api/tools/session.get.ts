defineRouteMeta({
  openAPI: {
    tags: ['tools'],
    operationId: 'createToolsSession',
    summary: 'Open an admin tool',
    description:
      'Browser navigation target of the admin tools page: sets the admin-only `scantor_tools` cookie (an 8 h HS256 JWT, Domain=SCANTOR_DOMAIN) and redirects to the tool (RabbitMQ management, mongo-express, RustFS console or the Traefik dashboard), where Traefik forwardAuth accepts the cookie. The tools still ask for their own credentials. Browser session of an admin only. 404 when Traefik is not configured (SCANTOR_DOMAIN empty); the tools are then reachable only on SCANTOR_ADMIN_BIND_ADDRESS.',
    'x-scantor-scope': 'admin',
    'x-admin-only': true,
    'x-mcp': false,
    'x-session-only': true,
    parameters: [
      { name: 'target', in: 'query', required: true, schema: { type: 'string', enum: ['rabbitmq', 'mongo-express', 'rustfs', 'traefik'] } },
    ],
    responses: {
      302: {
        description: 'Redirect to the tool with the tools cookie set',
        headers: {
          Location: { description: 'the tool URL', schema: { type: 'string' } },
          'Set-Cookie': { description: 'scantor_tools=<jwt>; Domain=<SCANTOR_DOMAIN>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax', schema: { type: 'string' } },
        },
      },
      400: { description: 'Unknown target', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Not an admin, or not a browser session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Traefik is not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { appendResponseHeader, defineEventHandler, setResponseHeader, setResponseStatus } from 'h3'
import { toolsSessionQuery } from '#shared/schemas/editor'
import { mintToolsJwt, toolsCookieHeader } from '../../services/tools/cookie'
import { requireAdmin, requireSession } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { toolUrl } from '../../utils/instance-info'
import { useKeys } from '../../utils/keys'
import { useLogger } from '../../utils/logger'
import { validateQuery } from '../../utils/zod'

const log = useLogger('tools')

export default defineEventHandler((event) => {
  const principal = requireAdmin(event)
  requireSession(event)
  const config = useConfig()
  if (!config.domain) throw apiError('notFound', 'admin tools are routed only through Traefik (SCANTOR_DOMAIN is empty)')
  const { target } = validateQuery(event, toolsSessionQuery)
  const location = toolUrl(config, target)!
  const keyring = useKeys()
  const { token } = mintToolsJwt(principal.user.id, (signingInput) => keyring.toolsCookieSignature(signingInput))
  appendResponseHeader(event, 'Set-Cookie', toolsCookieHeader(token, config.domain))
  setResponseHeader(event, 'Location', location)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, 302)
  log.info('admin tools cookie issued', { userId: principal.user.id, target })
  return ''
})
