defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'cancelScriptRun',
    summary: 'Cancel a script run',
    description:
      'Cancels a queued, building or running script run: the script receives SIGTERM (ctx.cancelled; open outputs are stored as <name>.partial) and is killed 50 s later. The outputs stored so far and the last checkpoint are kept, so a restart with resume can continue. Cancelling a cancelled run returns it unchanged; a completed or failed one is 409 invalidState.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    'x-destructive': true,
    parameters: [{ name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRun' } } } },
      404: { description: 'No such script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Already finished', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptRunParams } from '#shared/schemas/scripts'
import { cancelScriptRun, scriptRunRepresentation } from '../../../services/script-runs'
import { loadOwnedScriptRun, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId } = validateParams(event, scriptRunParams)
  return scriptRunRepresentation(await cancelScriptRun(await loadOwnedScriptRun(principal, scriptRunId)))
})
