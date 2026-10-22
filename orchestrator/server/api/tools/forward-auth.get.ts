defineRouteMeta({
  openAPI: {
    tags: ['tools'],
    operationId: 'toolsForwardAuth',
    summary: 'Traefik forwardAuth for admin tools',
    description:
      'Called by Traefik\'s forwardAuth middleware `scantor-tools-auth` for every request to an admin tool host (traefik., rabbitmq., mongo-express., rustfs.<SCANTOR_DOMAIN>), never by clients. 200 with `X-Scantor-User` when the `scantor_tools` cookie belongs to an active admin. Otherwise a browser navigation (`Accept` contains text/html) gets a 302 to createToolsSession for that tool and every other request a 401 with a short text/plain body. A forwarded host outside the four tool hosts is always 401. Never answers with the JSON error envelope.',
    'x-scantor-scope': 'tools',
    'x-mcp': false,
    parameters: [
      { name: 'X-Forwarded-Host', in: 'header', required: false, schema: { type: 'string' }, description: 'the tool host, set by Traefik' },
      { name: 'X-Forwarded-Uri', in: 'header', required: false, schema: { type: 'string' } },
      { name: 'X-Forwarded-Method', in: 'header', required: false, schema: { type: 'string' } },
      { name: 'Accept', in: 'header', required: false, schema: { type: 'string' } },
      { name: 'scantor_tools', in: 'cookie', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'Allowed',
        headers: { 'X-Scantor-User': { description: 'id of the admin', schema: { type: 'string', format: 'uuid' } } },
      },
      302: {
        description: 'A browser without a valid tools cookie: redirect to createToolsSession',
        headers: { Location: { description: '<SCANTOR_PUBLIC_URL>/api/tools/session?target=<target>', schema: { type: 'string' } } },
      },
      401: { description: 'Denied', content: { 'text/plain': { schema: { type: 'string' } } } },
      503: { description: 'The orchestrator is still starting', content: { 'text/plain': { schema: { type: 'string' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { decideForwardAuth } from '../../services/tools/forward-auth'
import { useConfig } from '../../utils/config'
import { useKeys } from '../../utils/keys'
import { useLogger } from '../../utils/logger'
import { getCachedUser, isUserBanned } from '../../utils/user-cache'

const log = useLogger('tools')

export default defineEventHandler(async (event) => {
  const config = useConfig()
  const keyring = useKeys()
  const decision = await decideForwardAuth(
    {
      forwardedHost: getRequestHeader(event, 'x-forwarded-host'),
      accept: getRequestHeader(event, 'accept'),
      cookie: event.node.req.headers.cookie,
    },
    {
      publicUrl: config.publicUrl,
      domain: config.domain,
      sign: (signingInput) => keyring.toolsCookieSignature(signingInput),
      getUser: (userId) => getCachedUser(userId),
      isBanned: (user) => isUserBanned(user),
    },
  )
  setResponseHeader(event, 'Cache-Control', 'no-store')
  switch (decision.kind) {
    case 'allow':
      setResponseHeader(event, 'X-Scantor-User', decision.userId)
      setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
      setResponseStatus(event, 200)
      return 'OK\n'
    case 'redirect':
      setResponseHeader(event, 'Location', decision.location)
      setResponseStatus(event, 302)
      return ''
    case 'deny':
      log.info('admin tool access denied', { reason: decision.reason, forwardedHost: getRequestHeader(event, 'x-forwarded-host') })
      setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
      setResponseStatus(event, 401)
      return 'Unauthorized\n'
  }
})
