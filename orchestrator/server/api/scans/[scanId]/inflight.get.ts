defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'listInflightAnalyses',
    summary: 'List in-flight analyses',
    description:
      'Lists the analyses the runner workers of a scan are processing right now, from their latest state polls (kept in memory, refreshed every few seconds, never stored): analysis id, seq, round, attempt, start time, worker, node and the progress value the task reported. updatedAt is the time of the newest report, null when no worker reported recently. Useful to see what a slow scan is busy with.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: {
        description: 'The in-flight analyses',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'updatedAt'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['analysisId', 'seq', 'round', 'attempt', 'startedAt', 'workerId', 'nodeId', 'progress'],
                    properties: {
                      analysisId: { type: 'string', description: '<scanId>-<seq>' },
                      seq: { type: 'integer' },
                      round: { type: 'integer' },
                      attempt: { type: 'integer' },
                      startedAt: { type: 'string', format: 'date-time' },
                      workerId: { type: 'string', format: 'uuid' },
                      nodeId: { type: 'string', format: 'uuid' },
                      progress: { description: 'The last progress value reported by the task, or null.' },
                    },
                  },
                },
                updatedAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
          },
        },
      },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { emptyQuery } from '#shared/schemas/common'
import { scanIdParams } from '#shared/schemas/scans'
import type { InflightList } from '#shared/types/scans'
import { getScanInflight } from '../../../services/inflight'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event): Promise<InflightList> => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  validateQuery(event, emptyQuery)
  const scan = await loadOwnedScan(principal, scanId)
  return getScanInflight(scan._id)
})
