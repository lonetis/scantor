defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'runtimeAnalysesStatus',
    summary: 'Get the stored status of redelivered analyses',
    description:
      'Runners only. For redelivered messages the runtime asks for the stored status of up to 1000 seqs of its own scan; seqs without a document answer with nulls. The runtime acks without running when the stored round is newer than the message round, or the same round is already succeeded or failed.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['seqs'],
            properties: { seqs: { type: 'array', maxItems: 1000, items: { type: 'integer', minimum: 0 } } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Stored statuses in request order',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['seq', 'status', 'round', 'attempt'],
                    properties: {
                      seq: { type: 'integer' },
                      status: { type: ['string', 'null'] },
                      round: { type: ['integer', 'null'] },
                      attempt: { type: ['integer', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Invalid worker token or inactive worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Not a runner', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { analysesStatus } from '../../../services/runtime/analyses'
import { analysesStatusBody } from '../../../services/runtime/schemas'
import { requireWorker } from '../../../utils/authz'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireWorker(event, { role: 'runner' })
  const body = await validateBody(event, analysesStatusBody)
  return analysesStatus(principal, body.seqs)
})
