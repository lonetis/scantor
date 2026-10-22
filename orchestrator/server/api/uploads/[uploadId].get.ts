defineRouteMeta({
  openAPI: {
    tags: ['uploads'],
    operationId: 'getUpload',
    summary: 'Get an upload',
    description: 'Returns one of your uploads: name, size, content hash and number of non-empty lines.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'uploadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } },
      404: { description: 'No such upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { uploadParams } from '#shared/schemas/tasks'
import { getUpload } from '../../services/uploads'
import { requireUser } from '../../utils/authz'
import { validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { uploadId } = validateParams(event, uploadParams)
  return getUpload(principal, uploadId)
})
