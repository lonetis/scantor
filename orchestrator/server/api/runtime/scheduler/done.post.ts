defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'schedulerDone',
    summary: 'Report the end of scheduling',
    description:
      'Schedulers only. Reports that the schedule stream ended (outcome done) or failed non-retryably (outcome failed with a ScantorError, which raises the condition schedulingFailed and makes the scan end failed). Stores the final checkpoint, drains the scheduler worker and checks completion. Idempotent for the same epoch; a superseded epoch gets 409 staleEpoch.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['epoch', 'outcome', 'confirmed', 'tailHash'],
            properties: {
              epoch: { type: 'integer', minimum: 0 },
              outcome: { type: 'string', enum: ['done', 'failed'] },
              confirmed: { type: 'integer', minimum: 0 },
              tailHash: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
              error: { $ref: '#/components/schemas/ScantorError' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The scheduling state after the report',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'scheduling'],
              properties: {
                serverTime: { type: 'integer' },
                scheduling: {
                  type: 'object',
                  required: ['state', 'confirmed'],
                  properties: { state: { type: 'string', enum: ['pending', 'running', 'done', 'retrying', 'failed'] }, confirmed: { type: 'integer' } },
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
import { schedulerDoneBody } from '../../../services/runtime/schemas'
import { recordSchedulingDone } from '../../../services/runtime/scheduler'
import { requireWorker } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateBody } from '../../../utils/zod'

const log = useLogger('runtime')

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event, { role: 'scheduler' })
  const body = await validateBody(event, schedulerDoneBody)
  return recordSchedulingDone(principal, { ...body, error: body.error ?? null }, log)
})
