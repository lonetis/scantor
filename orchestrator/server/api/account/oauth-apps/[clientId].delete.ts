defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'revokeOAuthApp',
    summary: 'Revoke an OAuth application',
    description:
      'Deletes your consent and every access and refresh token of the client; its next /mcp call is rejected with 401. 404 when you never authorised the client.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'clientId', in: 'path', required: true, schema: { type: 'string', maxLength: 2048 }, description: 'OAuth client id (URL-encoded)' },
    ],
    responses: {
      204: { description: 'Revoked' },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not authorised by you', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { clientIdParams } from '#shared/schemas/account'
import { requireUser } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { revokeOAuthApp } from '../../../utils/users'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { clientId } = validateParams(event, clientIdParams)
  if (!(await revokeOAuthApp(principal.user.id, clientId))) throw apiError('notFound', 'OAuth application not found')
  return sendNoContent(event)
})
