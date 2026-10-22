defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'schedulerResolved',
    summary: 'Record a template resolution',
    description:
      'Schedulers only. Before publishing the first item, the scheduler records how a template resolved its non-deterministic inputs (for example latest → a concrete Tranco list id) under key schedule (unwrapped template) or call:<n> (n-th wrapped template call). When a resolution for the key already exists it is returned unchanged with stored: false and must be used instead. For key schedule, expectedTotal becomes the scan\'s stats.expectedTotal. A superseded epoch gets 409 staleEpoch.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['epoch', 'key', 'template', 'scanConfig', 'provenance', 'expectedTotal'],
            properties: {
              epoch: { type: 'integer', minimum: 0 },
              key: { type: 'string', pattern: '^(schedule|call:(0|[1-9][0-9]{0,5}))$' },
              template: { type: 'string' },
              scanConfig: { type: 'object', additionalProperties: true },
              provenance: { type: 'object', additionalProperties: true },
              expectedTotal: { type: ['integer', 'null'], minimum: 0 },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The stored resolution',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['stored', 'resolution'],
              properties: {
                stored: { type: 'boolean' },
                resolution: {
                  type: 'object',
                  required: ['template', 'scanConfig', 'provenance', 'expectedTotal', 'at'],
                  properties: {
                    template: { type: 'string' },
                    scanConfig: { type: 'object', additionalProperties: true },
                    provenance: { type: 'object', additionalProperties: true },
                    expectedTotal: { type: ['integer', 'null'] },
                    at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Invalid worker token or inactive worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Not a scheduler', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'staleEpoch (details.currentEpoch)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { schedulerResolvedBody } from '../../../services/runtime/schemas'
import { recordResolution } from '../../../services/runtime/scheduler'
import { requireWorker } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateBody } from '../../../utils/zod'

const log = useLogger('runtime')

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event, { role: 'scheduler' })
  const body = await validateBody(event, schedulerResolvedBody)
  return recordResolution(principal, body, log)
})
