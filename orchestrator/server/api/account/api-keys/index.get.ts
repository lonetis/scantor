defineRouteMeta({
  openAPI: {
    tags: ['api-keys'],
    operationId: 'listApiKeys',
    summary: 'List your API keys',
    description:
      'Lists your API keys (never the key values): `default` keys for the CLI, MCP clients and scripts, and the `editor` key of your browser editor. Filter with configId.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'configId', in: 'query', required: false, schema: { type: 'string', enum: ['default', 'editor'] } }],
    responses: {
      200: {
        description: 'API keys',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } } },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listApiKeysQuery } from '#shared/schemas/account'
import { toApiKey } from '../../../services/account'
import { requireUser } from '../../../utils/authz'
import { listUserApiKeys } from '../../../utils/users'
import { validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, listApiKeysQuery)
  const keys = await listUserApiKeys(principal.user.id, query.configId)
  return { items: keys.map(toApiKey) }
})
