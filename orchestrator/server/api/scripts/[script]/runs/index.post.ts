defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'startScriptRun',
    summary: 'Run a script',
    description:
      'Starts a run of the script on 1 to 20 of the script owner’s scans. The script folder is snapshotted now (later edits do not change this run), built into a local image and run in one container on the master that reads the scans’ analyses and files through the script runtime API. config is the run’s config object (validated against the config schema the script last reported for this exact content, with defaults filled; 422 configInvalid lists the issues). secrets maps uppercase names to values the script reads from ctx.secrets: stored encrypted, returned by name only, at most 32 values of 8 KiB. settings: timeoutMs (total duration, default from the manifest, at most SCANTOR_SCRIPT_RUN_TIMEOUT), resources.cpus and resources.memoryMiB of the container (defaults from the manifest, capped by SCANTOR_SCRIPT_RUN_MAX_CPUS and SCANTOR_SCRIPT_RUN_MAX_MEMORY), and limit: a sample run whose every analysis stream ends after limit analyses. Try a script on a sample first. Through MCP a run without settings.limit returns 422 confirmationRequired with the scans’ sizes: ask the user, then repeat with confirm: true. The run starts queued; with wait (seconds) the call returns once it completed, failed or was cancelled. Follow it with getScriptRun and getScriptRunLogs.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the run to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['scans'],
            properties: {
              scans: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'uuid' }, description: 'ids of scans of the script owner; ctx.scans keeps this order' },
              config: { type: 'object', additionalProperties: true, default: {} },
              secrets: {
                type: 'object',
                maxProperties: 32,
                propertyNames: { pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
                additionalProperties: { type: 'string', maxLength: 8192 },
                description: 'NAME → value, read by the script from ctx.secrets; never returned',
              },
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
                  limit: { type: 'integer', minimum: 1, description: 'a sample run: every analysis stream ends after this many analyses' },
                },
              },
              confirm: { type: 'boolean', description: 'confirms a run over all analyses (MCP)' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScriptRun' } } } },
      400: { description: 'Invalid input or settings above the instance limits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such script or scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'The config exceeds SCANTOR_MAX_SCAN_CONFIG_BYTES', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'configInvalid or confirmationRequired', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          ScriptRunLogLine: {
            type: 'object',
            required: ['line', 'at', 'stream', 'text'],
            properties: {
              line: { type: 'integer', minimum: 1, description: 'numbered from 1 in the order the lines were stored' },
              at: { type: 'string', format: 'date-time' },
              stream: { type: 'string', enum: ['build', 'stdout', 'stderr', 'system'] },
              text: { type: 'string', description: 'at most 16 KiB, redacted' },
            },
          },
          ScriptRun: {
            type: 'object',
            description: 'One run of a script on a snapshot of its folder. Secret values never appear (secrets lists their names).',
            required: ['id', 'userId', 'scriptId', 'scriptName', 'scans', 'state', 'input', 'secrets', 'source', 'restartedFrom', 'image', 'errors', 'error', 'exitCode', 'progress', 'checkpoint', 'result', 'outputs', 'log', 'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'expiresAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', description: 'the script owner' },
              scriptId: { type: 'string', format: 'uuid' },
              scriptName: { type: 'string' },
              scans: {
                type: 'array',
                items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] } } },
              },
              state: { type: 'string', enum: ['queued', 'building', 'running', 'completed', 'failed', 'cancelled'] },
              input: {
                type: 'object',
                required: ['config', 'settings'],
                properties: {
                  config: { type: 'object', additionalProperties: true },
                  settings: {
                    type: 'object',
                    description: 'the effective settings once the run was built; before that the explicit values (null = not given)',
                    required: ['timeoutMs', 'resources', 'limit'],
                    properties: {
                      timeoutMs: { type: ['integer', 'null'] },
                      resources: { type: 'object', properties: { cpus: { type: ['number', 'null'] }, memoryMiB: { type: ['integer', 'null'] } } },
                      limit: { type: ['integer', 'null'] },
                    },
                  },
                },
              },
              secrets: { type: 'array', items: { type: 'string' }, description: 'the names of the secrets the run received' },
              source: {
                type: 'object',
                required: ['packSha256', 'packBytes', 'fileCount'],
                properties: { packSha256: { type: 'string' }, packBytes: { type: 'integer' }, fileCount: { type: 'integer' } },
              },
              restartedFrom: {
                type: ['object', 'null'],
                properties: { id: { type: 'string', format: 'uuid' }, resume: { type: 'boolean' } },
              },
              image: { type: ['object', 'null'], properties: { ref: { type: 'string' }, cached: { type: 'boolean' } } },
              errors: { type: 'array', items: { $ref: '#/components/schemas/BuildError' }, description: 'build, config and platform errors' },
              error: {
                type: ['object', 'null'],
                description: 'why the run failed (or why the platform cancelled it)',
                properties: {
                  type: { type: 'string', enum: ['scriptError', 'validation', 'timeout', 'crash', 'platform'] },
                  message: { type: 'string' },
                  stack: { type: 'string' },
                },
              },
              exitCode: { type: ['integer', 'null'] },
              progress: {
                anyOf: [
                  {
                    type: 'object',
                    required: ['done', 'total', 'message', 'updatedAt'],
                    properties: {
                      done: { type: 'number' },
                      total: { type: ['number', 'null'] },
                      message: { type: ['string', 'null'] },
                      updatedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                  { type: 'null' },
                ],
              },
              checkpoint: {
                type: ['object', 'null'],
                description: 'the last checkpoint the script saved (a restart with resume hands it to the new run)',
                properties: { savedAt: { type: 'string', format: 'date-time' }, bytes: { type: 'integer' } },
              },
              result: { description: 'the JSON result the script returned' },
              outputs: {
                type: 'array',
                description: 'the stored output files (readScriptRunOutput, getScriptRunOutputDownload)',
                items: {
                  type: 'object',
                  required: ['id', 'name', 'size', 'sha256', 'contentType', 'createdAt'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    size: { type: 'integer' },
                    sha256: { type: 'string', description: 'as reported by the script' },
                    contentType: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              log: {
                type: 'object',
                required: ['lines', 'firstLine', 'droppedLines'],
                properties: { lines: { type: 'integer' }, firstLine: { type: 'integer' }, droppedLines: { type: 'integer' } },
              },
              logTail: { type: 'array', items: { $ref: '#/components/schemas/ScriptRunLogLine' }, description: 'the last lines of the log (at most 50 lines, 16 KiB)' },
              createdAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: ['string', 'null'], format: 'date-time', description: 'when the finished run is deleted (null: kept)' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { scriptParams, startScriptRunBody, startScriptRunQuery } from '#shared/schemas/scripts'
import { reloadScriptRun, scriptRunRepresentation } from '../../../../services/script-runs'
import { isScriptRunSettled } from '../../../../services/script-runs/mappers'
import { startScriptRun } from '../../../../services/script-runs/start'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { useCollections } from '../../../../utils/mongo'
import { loadWithWait, reserveWaitFor } from '../../../../utils/wait'
import { validateBody, validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const { wait } = validateQuery(event, startScriptRunQuery)
  const body = await validateBody(event, startScriptRunBody)
  // Reserved before the run is created, so a 429 means nothing was queued.
  const reservation = reserveWaitFor(principal.user.id, wait)
  try {
    const created = await startScriptRun(principal, await resolveScript(principal, script), body, useConfig())
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
