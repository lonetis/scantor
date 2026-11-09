defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'getScript',
    summary: 'Get a script',
    description:
      'Returns one script by id or name: language, description, the cached folder status (workspace.packSha256 = the content a new run would build), describe (the config and result JSON Schemas its code reported for the content describe.packSha256; build the run config from configSchema while it matches workspace.packSha256), the latest run and recentRuns (the 10 newest runs with state and progress). Use getScriptRun for the result, errors, outputs and log tail of a run.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      200: { description: 'The script with recentRuns', content: { 'application/json': { schema: { $ref: '#/components/schemas/Script' } } } },
      404: { description: 'No such script', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptParams } from '#shared/schemas/scripts'
import { scriptRepresentation } from '../../../services/scripts'
import { requireUser, resolveScript } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  return scriptRepresentation(await resolveScript(principal, script))
})
