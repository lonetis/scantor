defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'createRegistryToken',
    summary: 'Issue a registry token (OAuth2 password grant)',
    description:
      'The token realm\'s POST flow used by containerd (the Docker 29 image store): an application/x-www-form-urlencoded OAuth2 password grant with username node or orchestrator, the matching password, and space-separated scopes. Grants are the same as the GET flow; the response carries access_token only and no refresh token. Errors use the registry format {"errors": [{"code", "message"}]}.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/x-www-form-urlencoded': {
          schema: {
            type: 'object',
            required: ['grant_type', 'username', 'password'],
            properties: {
              grant_type: { type: 'string', enum: ['password'] },
              service: { type: 'string', enum: ['scantor-registry'] },
              client_id: { type: 'string' },
              username: { type: 'string', enum: ['node', 'orchestrator'] },
              password: { type: 'string' },
              scope: { type: 'string', description: 'space-separated scopes' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The token',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['access_token', 'expires_in', 'issued_at'],
              properties: { access_token: { type: 'string' }, expires_in: { type: 'integer' }, issued_at: { type: 'string', format: 'date-time' } },
            },
          },
        },
      },
      400: { description: 'Unsupported grant type or unknown service', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
      401: { description: 'Missing or invalid credentials (registry error format)', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { handleRegistryTokenEvent } from '../../services/registry/handler'
import { productionTokenDeps } from '../../services/registry/token'
import { useLogger } from '../../utils/logger'

const log = useLogger('registry')

export default defineEventHandler((event) => handleRegistryTokenEvent(event, 'post', productionTokenDeps(), log))
