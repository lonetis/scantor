defineRouteMeta({
  openAPI: {
    tags: ['credentials'],
    operationId: 'listCredentials',
    summary: 'List git credentials',
    description:
      'Lists your git credentials (HTTPS tokens used by importGitTask and pullGitTask), sorted by name. Tokens are write-only: only their last 4 characters are shown. A credential is sent only to its exact host.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'Your credentials',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Credential' } } } },
          },
        },
      },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Credential: {
            type: 'object',
            description: 'A git credential: an HTTPS token sent as Basic auth (username:token) to exactly one host. The token itself is never returned.',
            required: ['id', 'kind', 'name', 'host', 'username', 'last4', 'lastUsedAt', 'createdAt', 'updatedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: { type: 'string', enum: ['gitToken'] },
              name: { type: 'string', maxLength: 64 },
              host: { type: 'string', description: 'lowercase host[:port] the token is sent to (exact match)' },
              username: { type: 'string', maxLength: 128 },
              last4: { type: 'string', description: 'the last 4 characters of the token' },
              lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listCredentials } from '../../services/credentials'
import { requireUser } from '../../utils/authz'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  return listCredentials(principal)
})
