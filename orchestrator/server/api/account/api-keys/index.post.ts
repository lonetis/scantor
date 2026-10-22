defineRouteMeta({
  openAPI: {
    tags: ['api-keys'],
    operationId: 'createApiKey',
    summary: 'Create an API key',
    description:
      'Creates a `default` API key (sk_scantor_…) for the CLI, MCP clients and scripts. The key is returned exactly once; store it as SCANTOR_TOKEN. Browser session only. Expires after expiresInDays (1–365, default 90).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    'x-session-only': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 32 },
              expiresInDays: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'The new key (shown once)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['apiKey', 'key'],
              properties: { apiKey: { $ref: '#/components/schemas/ApiKey' }, key: { type: 'string' } },
            },
          },
        },
      },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Browser session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createApiKeyBody } from '#shared/schemas/account'
import { toApiKey } from '../../../services/account'
import { requireSession } from '../../../utils/authz'
import { createUserApiKey } from '../../../utils/users'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireSession(event)
  const body = await validateBody(event, createApiKeyBody)
  const created = await createUserApiKey(principal.user.id, { name: body.name, configId: 'default', expiresInDays: body.expiresInDays })
  setResponseStatus(event, 201)
  return { apiKey: toApiKey(created.apiKey), key: created.key }
})
