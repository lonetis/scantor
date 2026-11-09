defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'getScriptRunLogs',
    summary: 'Read the log of a script run',
    description:
      'Returns up to limit lines (1–1000, default 200) of a script run’s log after afterLine (default: from the first retained line): the build output (stream build), the script’s stdout and stderr and platform lines (system), numbered from 1. Pass nextLine as afterLine to continue; complete is true once the run finished and no line follows. Lines over 16 KiB are cut; a long log keeps its first 1 MiB and its newest lines (droppedLines on the run counts the rest).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'afterLine', in: 'query', required: false, description: 'Return the lines after this line number.', schema: { type: 'integer', minimum: 0 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
    ],
    responses: {
      200: {
        description: 'A page of log lines',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['lines', 'firstLine', 'nextLine', 'complete'],
              properties: {
                lines: { type: 'array', items: { $ref: '#/components/schemas/ScriptRunLogLine' } },
                firstLine: { type: 'integer', description: 'the first retained line' },
                nextLine: { type: 'integer', description: 'pass as afterLine to continue' },
                complete: { type: 'boolean', description: 'the run finished and no line follows' },
              },
            },
          },
        },
      },
      404: { description: 'No such script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getScriptRunLogsQuery, scriptRunParams } from '#shared/schemas/scripts'
import { readScriptRunLogs } from '../../../services/script-runs/logs'
import { loadOwnedScriptRun, requireUser } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId } = validateParams(event, scriptRunParams)
  const query = validateQuery(event, getScriptRunLogsQuery)
  return readScriptRunLogs(await loadOwnedScriptRun(principal, scriptRunId), query)
})
