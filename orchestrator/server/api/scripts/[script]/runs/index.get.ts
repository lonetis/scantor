defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'listScriptRuns',
    summary: 'List the runs of a script',
    description: 'Lists the runs of a script, newest first, without their log tails. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of script runs',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ScriptRun' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      404: { description: 'No such script', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listScriptRunsQuery, scriptParams } from '#shared/schemas/scripts'
import { listScriptRuns } from '../../../../services/script-runs'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const query = validateQuery(event, listScriptRunsQuery)
  return listScriptRuns(await resolveScript(principal, script), query)
})
