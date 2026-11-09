defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeCreateOutputPart',
    summary: 'Presign a part of an output file',
    description:
      'Returns a presigned PUT for one part (partNumber 1 to 10000, size in bytes) of a pending output, for the internal S3 endpoint and valid SCANTOR_UPLOAD_TIMEOUT. Send exactly the returned headers (Content-Length is signed) and keep the ETag header of the answer for scriptRuntimeCompleteOutput. Every part but the last must be at least 5 MiB. The size is reserved against the storage quota of the owner (403 quotaExceeded) and against SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES for all outputs of the run together (413).',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    parameters: [{ name: 'outputId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['partNumber', 'size'],
            additionalProperties: false,
            properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, size: { type: 'integer', minimum: 1, maximum: 5368709120 } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The presigned part upload',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url', 'method', 'headers', 'expiresAt'],
              properties: {
                url: { type: 'string' },
                method: { type: 'string', enum: ['PUT'] },
                headers: { type: 'object', additionalProperties: { type: 'string' } },
                expiresAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid part', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'Not from a script-run container, or the storage quota is exhausted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'No such output of the run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The output is already stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: {
        description: 'The outputs of the run would exceed SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { presignOutputPart } from '../../../../services/script-runtime/outputs'
import { createScriptOutputPartBody, scriptRuntimeOutputParams } from '../../../../services/script-runtime/schemas'
import { requireScriptRun } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { outputId } = validateParams(event, scriptRuntimeOutputParams)
  const body = await validateBody(event, createScriptOutputPartBody)
  return presignOutputPart(principal, outputId.toLowerCase(), body, useConfig())
})
