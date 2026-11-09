defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'getScriptRun',
    summary: 'Get a script run',
    description:
      'Returns a script run: state, progress, the BuildErrors of a failed build, the error of a failed run (type scriptError, validation, timeout, crash or platform, with the message and stack), the exit code, the result the script returned, the stored outputs, the last checkpoint and the last log lines (logTail). With wait (seconds) the call returns once the run completed, failed or was cancelled. Use getScriptRunLogs for the whole log and readScriptRunOutput for an output.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the run to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    responses: {
      200: { description: 'The script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRun' } } } },
      404: { description: 'No such script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getScriptRunQuery, scriptRunParams } from '#shared/schemas/scripts'
import { reloadScriptRun, scriptRunRepresentation } from '../../../services/script-runs'
import { isScriptRunSettled } from '../../../services/script-runs/mappers'
import { loadOwnedScriptRun, requireUser } from '../../../utils/authz'
import { useCollections } from '../../../utils/mongo'
import { loadWithWait } from '../../../utils/wait'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId } = validateParams(event, scriptRunParams)
  const { wait } = validateQuery(event, getScriptRunQuery)
  const owned = await loadOwnedScriptRun(principal, scriptRunId)
  const current = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => reloadScriptRun(owned),
    settled: isScriptRunSettled,
    watch: { collection: useCollections().scriptRuns as never, id: owned._id },
  })
  return scriptRunRepresentation(current)
})
