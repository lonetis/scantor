defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'runtimePresignUploads',
    summary: 'Presign file uploads of a successful execution',
    description:
      'Runners only. Called once per successful execution with every file the connector registered (fileId is the uuid v4 the runtime generated). The scan comes from the worker token; the server validates the ids and limits, checks the owner\'s storage quota (403 quotaExceeded), generates the keys files/<scanId>/<seq>/<executionId>/<fileId>/<safeName> and returns presigned PUT URLs for the node\'s S3 endpoint. Send exactly the returned headers: Content-Type, Content-Length and the object metadata x-amz-meta-file-id and x-amz-meta-name are signed.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['seq', 'round', 'attempt', 'executionId', 'files'],
            properties: {
              seq: { type: 'integer', minimum: 0 },
              round: { type: 'integer', minimum: 1 },
              attempt: { type: 'integer', minimum: 1 },
              executionId: { type: 'string', format: 'uuid' },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['fileId', 'name', 'size', 'sha256', 'contentType'],
                  properties: {
                    fileId: { type: 'string', format: 'uuid' },
                    name: { type: 'string', minLength: 1, maxLength: 255 },
                    size: { type: 'integer', minimum: 0 },
                    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    contentType: { type: 'string', maxLength: 255 },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Presigned PUTs',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['files'],
              properties: {
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['fileId', 'name', 'url', 'method', 'headers', 'expiresAt'],
                    properties: {
                      fileId: { type: 'string', format: 'uuid' },
                      name: { type: 'string' },
                      url: { type: 'string' },
                      method: { type: 'string', enum: ['PUT'] },
                      headers: { type: 'object', additionalProperties: { type: 'string' } },
                      expiresAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'validationFailed: malformed or duplicate fileId, seq out of range, duplicate names, too many or too large files', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Invalid worker token or inactive worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'quotaExceeded, or a scheduler token (forbidden)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { presignBody } from '../../../services/runtime/schemas'
import { handlePresign } from '../../../services/runtime/uploads'
import { requireWorker } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event, { role: 'runner' })
  const body = await validateBody(event, presignBody)
  return handlePresign(principal, body, useConfig())
})
