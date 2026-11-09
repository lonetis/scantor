defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'restartScriptRun',
    summary: 'Restart a script run',
    description:
      'Starts a new run of the script’s CURRENT folder with the original run’s scans, config, secrets and settings; config replaces the config, settings override single settings (settings.limit: null removes a sample limit). resume: true needs a finished original and hands its last checkpoint (ctx.resume_state) and its outputs (ctx.resume_outputs) to the new run, so a script that checkpoints continues where it stopped. The same checks as startScriptRun apply (through MCP a run without a limit needs confirm: true). With wait (seconds) the call returns once the new run settled.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the new run to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              resume: { type: 'boolean', default: false, description: 'continue from the original run’s checkpoint and outputs' },
              config: { type: 'object', additionalProperties: true },
              settings: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  timeoutMs: { type: 'integer', minimum: 1000 },
                  resources: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { cpus: { type: 'number', exclusiveMinimum: 0 }, memoryMiB: { type: 'integer', minimum: 256 } },
                  },
                  limit: { type: ['integer', 'null'], minimum: 1 },
                },
              },
              confirm: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The new script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRun' } } } },
      400: { description: 'Invalid input or settings above the instance limits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such script run, script or scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'resume of a run that has not finished', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'The config exceeds SCANTOR_MAX_SCAN_CONFIG_BYTES', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'configInvalid or confirmationRequired', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits (wait, or a resume that waits for a stopping original)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { restartScriptRunBody, scriptRunParams, startScriptRunQuery } from '#shared/schemas/scripts'
import { reloadScriptRun, scriptRunRepresentation } from '../../../services/script-runs'
import { isScriptRunSettled } from '../../../services/script-runs/mappers'
import { reserveRestartWait, restartScriptRun } from '../../../services/script-runs/start'
import { loadOwnedScriptRun, requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { useCollections } from '../../../utils/mongo'
import { loadWithWait } from '../../../utils/wait'
import { validateBody, validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId } = validateParams(event, scriptRunParams)
  const { wait } = validateQuery(event, startScriptRunQuery)
  const body = await validateBody(event, restartScriptRunBody)
  const original = await loadOwnedScriptRun(principal, scriptRunId)
  // Also held by a resume that waits for a stopping original, so that wait counts against the user's budget.
  const reservation = reserveRestartWait(principal.user.id, original, body, wait)
  try {
    const created = await restartScriptRun(principal, original, body, useConfig())
    const current = await loadWithWait(event, {
      waitSeconds: wait,
      userId: principal.user.id,
      load: () => reloadScriptRun(created),
      settled: isScriptRunSettled,
      watch: { collection: useCollections().scriptRuns as never, id: created._id },
      reserved: reservation !== null,
    })
    setResponseStatus(event, 201)
    return scriptRunRepresentation(current)
  } finally {
    reservation?.()
  }
})
