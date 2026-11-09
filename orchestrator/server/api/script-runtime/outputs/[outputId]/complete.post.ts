defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeCompleteOutput',
    summary: 'Complete an output file',
    description:
      'Combines the uploaded parts (partNumber and the ETag each part upload answered with) into the output file and stores it with the SHA-256 the script computed (lowercase hex; the server does not verify it). Idempotent: a stored output is returned again. name stores the output under another name (an interrupted outputs.open completes as <name>.partial; 409 alreadyExists when an output of the run has that name). S3 rejecting the parts is 400.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    parameters: [{ name: 'outputId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['parts', 'sha256'],
            additionalProperties: false,
            properties: {
              parts: {
                type: 'array',
                minItems: 1,
                maxItems: 10000,
                items: {
                  type: 'object',
                  required: ['partNumber', 'etag'],
                  additionalProperties: false,
                  properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, etag: { type: 'string', minLength: 1, maxLength: 256 } },
                },
              },
              sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              name: { type: 'string', minLength: 1, maxLength: 255, description: 'store the output under this name instead' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The stored output',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['output'],
              properties: {
                output: {
                  type: 'object',
                  required: ['id', 'name', 'size', 'sha256', 'contentType', 'createdAt'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    size: { type: 'integer' },
                    sha256: { type: 'string' },
                    contentType: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid parts', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'No such output of the run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The upload of the output no longer exists, or name is taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { completeOutput } from '../../../../services/script-runtime/outputs'
import { completeScriptOutputBody, scriptRuntimeOutputParams } from '../../../../services/script-runtime/schemas'
import { requireScriptRun } from '../../../../utils/authz'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { outputId } = validateParams(event, scriptRuntimeOutputParams)
  const body = await validateBody(event, completeScriptOutputBody)
  return completeOutput(principal, outputId.toLowerCase(), body)
})
