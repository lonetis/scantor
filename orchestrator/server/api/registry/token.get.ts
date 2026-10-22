defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'getRegistryToken',
    summary: 'Issue a registry token (GET flow)',
    description:
      'The token realm of the platform registry, called by Docker daemons (docker login, Engine API /auth, legacy pulls) with Basic credentials: node:<node token> gets pull on tasks/<taskId> for the task repositories of the node’s current assignments; orchestrator:<derived push password> gets pull, push and delete on tasks/* and the catalog. The token (ES256 JWT, 300 s) holds the intersection of the requested scopes and the allowed actions; a request without scope gets "access": []. Errors use the registry format {"errors": [{"code", "message"}]}.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    parameters: [
      { name: 'service', in: 'query', required: false, schema: { type: 'string', enum: ['scantor-registry'] } },
      { name: 'scope', in: 'query', required: false, description: 'repeatable, for example repository:tasks/<taskId>:pull', schema: { type: 'string' } },
      { name: 'account', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'client_id', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'offline_token', in: 'query', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'The token',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'access_token', 'expires_in', 'issued_at'],
              properties: {
                token: { type: 'string' },
                access_token: { type: 'string' },
                expires_in: { type: 'integer' },
                issued_at: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      400: { description: 'Unknown service', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
      401: { description: 'Missing or invalid credentials (registry error format)', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { handleRegistryTokenEvent } from '../../services/registry/handler'
import { productionTokenDeps } from '../../services/registry/token'
import { useLogger } from '../../utils/logger'

const log = useLogger('registry')

export default defineEventHandler((event) => handleRegistryTokenEvent(event, 'get', productionTokenDeps(), log))
