defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'runtimeReportError',
    summary: 'Report a worker-level error',
    description:
      'Called by any worker runtime for errors that are not analysis outcomes (connector start failures, platform errors, an unhealthy worker). Stored as the worker\'s runtime.lastError, recorded as a worker.error event and raised as the scan condition workerErrors. For the scheduler, a schedule-phase or retryable error counts as a restart; above SCANTOR_SCHEDULER_MAX_RESTARTS scheduling fails. fatal: true means the runtime exits non-zero next.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['fatal', 'error'],
            properties: {
              fatal: { type: 'boolean' },
              error: { $ref: '#/components/schemas/ScantorError' },
              context: { type: 'object', properties: { stderrTail: { type: 'string', description: 'at most 4 KiB' } } },
            },
          },
        },
      },
    },
    responses: {
      202: {
        description: 'Recorded',
        content: { 'application/json': { schema: { type: 'object', required: ['recorded'], properties: { recorded: { type: 'boolean' } } } } },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Invalid worker token or inactive worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { recordRuntimeError } from '../../services/runtime/errors'
import { runtimeErrorBody } from '../../services/runtime/schemas'
import { requireWorker } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'
import { validateBody } from '../../utils/zod'

const log = useLogger('runtime')

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event)
  const body = await validateBody(event, runtimeErrorBody)
  const result = await recordRuntimeError(
    principal,
    { fatal: body.fatal, error: body.error, ...(body.context ? { context: body.context } : {}) },
    useConfig().schedulerMaxRestarts,
    log,
  )
  setResponseStatus(event, 202)
  return result
})
