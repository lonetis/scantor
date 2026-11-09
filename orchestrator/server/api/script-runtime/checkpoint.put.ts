defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeCheckpoint',
    summary: 'Save the checkpoint of a script run',
    description:
      'Saves any JSON value as the checkpoint of the run (at most 1 MiB serialized, 413 above; object keys must not start with $). A run restarted with resume receives it in its bootstrap. Any rate is accepted; the run stores its checkpoint at most once per 10 seconds (the latest value always, at the latest when the run ends). savedAt is the time the value was accepted.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { description: 'Any JSON value' } } },
        },
      },
    },
    responses: {
      200: {
        description: 'Accepted',
        content: {
          'application/json': { schema: { type: 'object', required: ['savedAt'], properties: { savedAt: { type: 'string', format: 'date-time' } } } },
        },
      },
      400: { description: 'Invalid or unstorable state', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      413: { description: 'The state exceeds 1 MiB of JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptCheckpointBody } from '../../services/script-runtime/schemas'
import { saveCheckpoint } from '../../services/script-runtime/state'
import { requireScriptRun } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const body = await validateBody(event, scriptCheckpointBody)
  return saveCheckpoint(principal, body)
})
