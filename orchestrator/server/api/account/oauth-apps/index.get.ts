defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'listOAuthApps',
    summary: 'List authorised OAuth applications',
    description: 'Lists the MCP clients you authorised through OAuth, with their granted scopes and the date of consent.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'Authorised applications',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/OAuthApp' } } } },
          },
        },
      },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { toOAuthApp } from '../../../services/account'
import { requireUser } from '../../../utils/authz'
import { listOAuthApps } from '../../../utils/users'

export default defineEventHandler(async (event) => {
  const apps = await listOAuthApps(requireUser(event).user.id)
  return { items: apps.map(toOAuthApp) }
})
