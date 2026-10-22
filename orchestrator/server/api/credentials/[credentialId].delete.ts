defineRouteMeta({
  openAPI: {
    tags: ['credentials'],
    operationId: 'deleteCredential',
    summary: 'Delete a git credential',
    description:
      'Deletes a git credential. Tasks imported with it pull without credentials afterwards, which fails for private repositories (422 gitFailed). 404 when the credential is not yours.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'credentialId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'No such credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { credentialParams } from '#shared/schemas/tasks'
import { deleteCredential } from '../../services/credentials'
import { requireUser } from '../../utils/authz'
import { validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { credentialId } = validateParams(event, credentialParams)
  await deleteCredential(principal, credentialId)
  return sendNoContent(event)
})
