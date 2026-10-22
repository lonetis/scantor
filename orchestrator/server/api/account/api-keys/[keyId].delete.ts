defineRouteMeta({
  openAPI: {
    tags: ['api-keys'],
    operationId: 'deleteApiKey',
    summary: 'Delete an API key',
    description: 'Deletes one of your API keys; requests with it fail with 401 from then on. 404 when the key is not yours.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      204: { description: 'Deleted' },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { keyIdParams } from '#shared/schemas/account'
import { requireUser } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { deleteUserApiKey } from '../../../utils/users'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { keyId } = validateParams(event, keyIdParams)
  if (!(await deleteUserApiKey(principal.user.id, keyId))) throw apiError('notFound', 'API key not found')
  return sendNoContent(event)
})
