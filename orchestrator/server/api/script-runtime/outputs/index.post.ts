defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeCreateOutput',
    summary: 'Start an output file of a script run',
    description:
      'Starts the upload of an output file of the run (name of 1 to 255 characters without /, backslash or NUL; contentType defaults to application/octet-stream) as an S3 multipart upload and returns the output with the recommended part size. Upload the parts through scriptRuntimeCreateOutputPart, then call scriptRuntimeCompleteOutput. Idempotent on the name: the pending output of the same name and content type is returned again (200); a stored output of that name, or a pending one of another type, is 409 alreadyExists. At most SCANTOR_SCRIPT_RUN_MAX_OUTPUTS outputs per run (400).',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1, maxLength: 255 }, contentType: { type: 'string', maxLength: 255 } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The pending output of that name',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRuntimeOutputStarted' } } },
      },
      201: { description: 'The new pending output', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRuntimeOutputStarted' } } } },
      400: { description: 'Invalid name or too many outputs', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      409: {
        description: 'An output of that name is stored or uses another type',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    $global: {
      components: {
        schemas: {
          ScriptRuntimeOutputStarted: {
            type: 'object',
            description: 'A pending output of a script run and the recommended part size.',
            required: ['output', 'partBytes'],
            properties: {
              output: {
                type: 'object',
                required: ['id', 'name', 'contentType'],
                properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, contentType: { type: 'string' } },
              },
              partBytes: { type: 'integer' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createOutput } from '../../../services/script-runtime/outputs'
import { createScriptOutputBody } from '../../../services/script-runtime/schemas'
import { requireScriptRun } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const body = await validateBody(event, createScriptOutputBody)
  const { created, body: result } = await createOutput(principal, body, useConfig())
  setResponseStatus(event, created ? 201 : 200)
  return result
})
