defineRouteMeta({
  openAPI: {
    tags: ['uploads'],
    operationId: 'createUpload',
    summary: 'Upload a list file',
    description:
      'Uploads a file for the list template (one item per line; body text/plain or application/octet-stream, at most SCANTOR_MAX_UPLOAD_BYTES). Reference the returned id in a config field annotated "x-scantor": "upload" (for example the list template’s scan config). Identical content you uploaded before returns the existing upload with 200 instead of 201. lines counts the non-empty lines.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'name', in: 'query', required: false, description: 'Original file name (metadata only).', schema: { type: 'string', maxLength: 255 } },
      { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['list'], default: 'list' } },
    ],
    requestBody: {
      required: true,
      content: {
        'text/plain': { schema: { type: 'string' } },
        'application/octet-stream': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } },
      },
    },
    responses: {
      200: { description: 'The existing upload with the same content', content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } },
      201: { description: 'The upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } },
      413: { description: 'Too large', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      415: { description: 'Unsupported media type', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Upload: {
            type: 'object',
            description: 'An uploaded list file, referenced by id from configs (fields annotated "x-scantor": "upload").',
            required: ['id', 'kind', 'name', 'contentType', 'bytes', 'sha256', 'lines', 'lastUsedAt', 'createdAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: { type: 'string', enum: ['list'] },
              name: { type: 'string' },
              contentType: { type: 'string' },
              bytes: { type: 'integer' },
              sha256: { type: 'string' },
              lines: { type: 'integer', description: 'non-empty lines' },
              lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, getRequestHeader, setResponseStatus } from 'h3'
import { createUploadQuery } from '#shared/schemas/tasks'
import { createUpload, uploadContentType } from '../../services/uploads'
import { requireUser } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, createUploadQuery)
  const contentType = uploadContentType(getRequestHeader(event, 'content-type'))
  const maxBytes = typeof event.context.bodyLimit === 'number' ? event.context.bodyLimit : useConfig().maxUploadBytes
  const { upload, created } = await createUpload(principal, {
    body: event.node.req,
    contentType,
    name: query.name ?? 'upload.txt',
    kind: query.kind,
    maxBytes,
  })
  setResponseStatus(event, created ? 201 : 200)
  return upload
})
