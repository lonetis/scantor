defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeOutputUrl',
    summary: 'Get a URL of an output file',
    description:
      'Returns a presigned GET of a stored output of the run, or of the run it continues when it was restarted with resume (the outputs listed in the resume block of the bootstrap), for the internal S3 endpoint and valid one hour.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    parameters: [{ name: 'outputId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: {
        description: 'The presigned GET',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url', 'expiresAt', 'name', 'size', 'sha256', 'contentType'],
              properties: {
                url: { type: 'string' },
                expiresAt: { type: 'string', format: 'date-time' },
                name: { type: 'string' },
                size: { type: 'integer' },
                sha256: { type: 'string' },
                contentType: { type: 'string' },
              },
            },
          },
        },
      },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'No such stored output', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { outputUrl } from '../../../../services/script-runtime/outputs'
import { scriptRuntimeOutputParams } from '../../../../services/script-runtime/schemas'
import { requireScriptRun } from '../../../../utils/authz'
import { validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { outputId } = validateParams(event, scriptRuntimeOutputParams)
  return outputUrl(principal, outputId.toLowerCase())
})
