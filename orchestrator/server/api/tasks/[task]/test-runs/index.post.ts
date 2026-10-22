defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'testTask',
    summary: 'Test-run the workspace',
    description:
      'Runs the current workspace of a task on the platform without publishing: builds a draft image (static checks and describe always run; the type check is skipped), validates the configs against the described schemas (defaults filled), then runs schedule limited to limit analyses (default 5, at most 50) and run for each, in one container with internet access. With analysisConfig, schedule is skipped and run is called once with it. maxAttempts (1–5, default 1) and timeoutMs (per analysis, default from the manifest) control retries and timeouts; the whole run is bounded by SCANTOR_TEST_RUN_TIMEOUT. The test run starts queued; with wait (seconds) the call returns when it is completed (whatever the analysis outcomes), failed (build, describe, config or schedule errors, listed in errors) or cancelled. analyses holds results, errors and log tails. Secret config values are "***" in the response.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the test run to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              taskConfig: { type: 'object', additionalProperties: true },
              scanConfig: { type: 'object', additionalProperties: true },
              analysisConfig: { type: 'object', additionalProperties: true, description: 'run once with this analysis config; schedule is skipped' },
              limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
              maxAttempts: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
              timeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000, description: 'per-analysis timeout; default from the manifest' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/TestRun' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'A config exceeds SCANTOR_MAX_SCAN_CONFIG_BYTES', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          TestRunAnalysis: {
            type: 'object',
            description: 'One analysis of a test run (as Analysis, without round and worker fields). Secret values are "***".',
            required: ['id', 'seq', 'status', 'attempt', 'attempts', 'files'],
            properties: {
              id: { type: 'string', description: '<testRunId>-<seq>' },
              seq: { type: 'integer', minimum: 0 },
              status: { type: 'string', enum: ['succeeded', 'failed'] },
              attempt: { type: 'integer', minimum: 0 },
              config: { type: 'object', additionalProperties: true },
              result: { type: ['object', 'null'], additionalProperties: true },
              error: { anyOf: [{ $ref: '#/components/schemas/ScantorError' }, { type: 'null' }] },
              attempts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    attempt: { type: 'integer' },
                    startedAt: { type: ['string', 'null'], format: 'date-time' },
                    finishedAt: { type: ['string', 'null'], format: 'date-time' },
                    durationMs: { type: ['integer', 'null'] },
                    error: { anyOf: [{ $ref: '#/components/schemas/ScantorError' }, { type: 'null' }] },
                    logTail: { type: 'string' },
                  },
                },
              },
              files: { type: 'array', items: { $ref: '#/components/schemas/FileRef' } },
              logTail: { type: 'string' },
              timings: {
                type: 'object',
                properties: {
                  scheduledAt: { type: ['string', 'null'], format: 'date-time' },
                  startedAt: { type: ['string', 'null'], format: 'date-time' },
                  finishedAt: { type: ['string', 'null'], format: 'date-time' },
                  durationMs: { type: ['integer', 'null'] },
                },
              },
            },
          },
          TestRun: {
            type: 'object',
            description: 'A platform test run of a task\'s workspace (draft image, local mode); nothing is published.',
            required: ['id', 'userId', 'taskId', 'taskName', 'state', 'input', 'errors', 'summary', 'createdAt', 'expiresAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string' },
              taskId: { type: 'string', format: 'uuid' },
              taskName: { type: 'string' },
              state: { type: 'string', enum: ['queued', 'building', 'running', 'completed', 'failed', 'cancelled'] },
              input: {
                type: 'object',
                description: 'The request; configs are the effective configs once validated (secrets "***").',
                properties: {
                  taskConfig: { type: 'object', additionalProperties: true },
                  scanConfig: { type: 'object', additionalProperties: true },
                  analysisConfig: { type: 'object', additionalProperties: true },
                  limit: { type: 'integer' },
                  maxAttempts: { type: 'integer' },
                  timeoutMs: { type: 'integer' },
                },
              },
              packSha256: { type: ['string', 'null'], description: 'workspace pack hash that was tested' },
              draftImage: {
                type: ['object', 'null'],
                properties: { ref: { type: 'string' }, digest: { type: 'string' }, cached: { type: 'boolean' } },
              },
              description: { anyOf: [{ $ref: '#/components/schemas/Description' }, { type: 'null' }] },
              errors: { type: 'array', items: { $ref: '#/components/schemas/BuildError' } },
              summary: {
                type: 'object',
                required: ['analyses', 'succeeded', 'failed'],
                properties: { analyses: { type: 'integer' }, succeeded: { type: 'integer' }, failed: { type: 'integer' } },
              },
              analyses: { type: 'array', items: { $ref: '#/components/schemas/TestRunAnalysis' } },
              createdAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { taskParams, testTaskBody, waitQuery } from '#shared/schemas/tasks'
import { reloadTestRun, testRunRepresentation } from '../../../../services/test-runs'
import { createTestRun } from '../../../../services/test-runs/create'
import { isTestRunSettled } from '../../../../services/test-runs/mappers'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { useCollections } from '../../../../utils/mongo'
import { loadWithWait } from '../../../../utils/wait'
import { validateBody, validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const { wait } = validateQuery(event, waitQuery)
  const body = await validateBody(event, testTaskBody)
  const created = await createTestRun(await resolveTask(principal, task), body, useConfig())
  const current = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => reloadTestRun(created),
    settled: isTestRunSettled,
    watch: { collection: useCollections().testRuns as never, id: created._id },
  })
  setResponseStatus(event, 201)
  return testRunRepresentation(current, true)
})
