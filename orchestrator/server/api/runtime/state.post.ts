defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'runtimeState',
    summary: 'Report runtime state and receive the desired action',
    description:
      'Called by every worker runtime every ~5 s. Reports open and busy processes, the in-flight analyses (busy[], kept in memory for listInflightAnalyses), the clock offset and free work space. Returns the action (run, drain or stop), the number of processes the worker may run (the node-applied value while scaling up, the desired value at once while scaling down), the scan state and the next poll interval.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['processes', 'busy', 'consuming', 'clockOffsetMs', 'tmpFreeBytes'],
            properties: {
              processes: {
                type: 'object',
                required: ['running', 'busy'],
                properties: { running: { type: 'integer', minimum: 0 }, busy: { type: 'integer', minimum: 0 } },
              },
              busy: {
                type: 'array',
                maxItems: 1024,
                items: {
                  type: 'object',
                  required: ['seq', 'round', 'attempt', 'executionId', 'startedAt'],
                  properties: {
                    seq: { type: 'integer', minimum: 0 },
                    round: { type: 'integer', minimum: 1 },
                    attempt: { type: 'integer', minimum: 0 },
                    executionId: { type: 'string', format: 'uuid' },
                    startedAt: { type: 'string', format: 'date-time' },
                    progress: {},
                  },
                },
              },
              consuming: { type: 'boolean' },
              clockOffsetMs: { type: 'integer' },
              tmpFreeBytes: { type: 'integer', minimum: 0 },
              counters: { type: 'object', additionalProperties: { type: 'integer' } },
              scheduler: { type: ['object', 'null'], additionalProperties: true },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The desired action',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'action', 'processes', 'scanState', 'nextPollMs'],
              properties: {
                serverTime: { type: 'integer' },
                action: { type: 'string', enum: ['run', 'drain', 'stop'] },
                processes: { type: 'integer' },
                scanState: { type: 'string' },
                nextPollMs: { type: 'integer' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Invalid worker token or inactive worker (treat as stop)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { runtimeStateBody } from '../../services/runtime/schemas'
import { handleRuntimeState } from '../../services/runtime/state'
import { requireWorker } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'
import { validateBody } from '../../utils/zod'

const log = useLogger('runtime')

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event)
  const body = await validateBody(event, runtimeStateBody)
  return handleRuntimeState(principal, body, useConfig(), log)
})
