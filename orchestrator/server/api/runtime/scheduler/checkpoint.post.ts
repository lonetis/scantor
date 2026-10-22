defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'schedulerCheckpoint',
    summary: 'Store the scheduler checkpoint',
    description:
      'Schedulers only. Stores the contiguous published-and-confirmed prefix (confirmed) and the hash of its last item (tailHash) when confirmed is greater than the stored value; otherwise the stored values are returned unchanged. A superseded epoch gets 409 staleEpoch with details.currentEpoch, after which the scheduler stops publishing and exits.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['epoch', 'confirmed', 'tailHash'],
            properties: {
              epoch: { type: 'integer', minimum: 0 },
              confirmed: { type: 'integer', minimum: 0 },
              tailHash: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The stored checkpoint',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['confirmed', 'tailHash', 'serverTime'],
              properties: { confirmed: { type: 'integer' }, tailHash: { type: ['string', 'null'] }, serverTime: { type: 'integer' } },
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
import { schedulerCheckpointBody } from '../../../services/runtime/schemas'
import { recordCheckpoint } from '../../../services/runtime/scheduler'
import { requireWorker } from '../../../utils/authz'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event, { role: 'scheduler' })
  const body = await validateBody(event, schedulerCheckpointBody)
  return recordCheckpoint(principal, body)
})
