defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeFinish',
    summary: 'Report the outcome of a script run',
    description:
      'Reports the outcome of the script right before it exits: exactly one of result (any JSON value, at most SCANTOR_MAX_RESULT_BYTES serialized, 413 above; object keys must not start with $) or error (type scriptError or validation, message at most 16 KiB, optional stack at most 64 KiB). It is stored on the run, and a later call replaces it. The run ends when the container exits: completed with the result on exit code 0, failed with the reported error otherwise.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { type: 'object', required: ['result'], additionalProperties: false, properties: { result: { description: 'Any JSON value' } } },
              {
                type: 'object',
                required: ['error'],
                additionalProperties: false,
                properties: {
                  error: {
                    type: 'object',
                    required: ['type', 'message'],
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string', enum: ['scriptError', 'validation'] },
                      message: { type: 'string', maxLength: 16384 },
                      stack: { type: 'string', maxLength: 65536 },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Stored',
        content: {
          'application/json': { schema: { type: 'object', required: ['received'], properties: { received: { type: 'string', enum: ['result', 'error'] } } } },
        },
      },
      400: { description: 'Invalid outcome', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      413: { description: 'The result exceeds SCANTOR_MAX_RESULT_BYTES', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { finishScriptRun } from '../../services/script-runtime/finish'
import { scriptFinishBody } from '../../services/script-runtime/schemas'
import { requireScriptRun } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const body = await validateBody(event, scriptFinishBody)
  return finishScriptRun(principal, body, useConfig())
})
