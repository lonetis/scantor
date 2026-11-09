defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeProgress',
    summary: 'Report the progress of a script run',
    description:
      'Reports how far the script is: done, an optional total and an optional message of at most 256 characters. Any rate is accepted; the run stores its progress at most once per second (the latest value always, at the latest when the run ends).',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['done'],
            additionalProperties: false,
            properties: {
              done: { type: 'number', minimum: 0 },
              total: { type: ['number', 'null'], minimum: 0 },
              message: { type: ['string', 'null'], maxLength: 256 },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Accepted',
        content: { 'application/json': { schema: { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['running'] } } } } },
      },
      400: { description: 'Invalid progress', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptProgressBody } from '../../services/script-runtime/schemas'
import { reportProgress } from '../../services/script-runtime/state'
import { requireScriptRun } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const body = await validateBody(event, scriptProgressBody)
  return reportProgress(principal, body)
})
