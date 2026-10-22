defineRouteMeta({
  openAPI: {
    tags: ['uploads'],
    operationId: 'deleteUpload',
    summary: 'Delete an upload',
    description: 'Deletes one of your uploads. 409 uploadInUse while a scan (in any state but deleted) references it.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'uploadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'No such upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'A scan references the upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { uploadParams } from '#shared/schemas/tasks'
import { deleteUpload } from '../../services/uploads'
import { requireUser } from '../../utils/authz'
import { validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { uploadId } = validateParams(event, uploadParams)
  await deleteUpload(principal, uploadId)
  return sendNoContent(event)
})
