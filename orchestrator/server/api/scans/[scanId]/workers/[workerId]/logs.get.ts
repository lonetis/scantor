defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'getWorkerLogs',
    summary: 'Get worker logs',
    description:
      'Requests a fresh tail of a worker container\'s output (runtime and connector logs) from the node that runs it and returns the latest collected tail. With wait (seconds, at most 30) the call returns as soon as the node delivered the tail (header Scantor-Wait: settled|timeout); otherwise pending is true and the tail collected for the previous request (if any) is returned. tailBytes sets the size (default 65536, at most 262144); truncated tells whether older output was cut. Workers without a container (pending, stopped, lost) return their last collected tail.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'workerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the tail (0–30).', schema: { type: 'integer', minimum: 0, maximum: 30, default: 0 } },
      { name: 'tailBytes', in: 'query', required: false, schema: { type: 'integer', minimum: 1024, maximum: 262144, default: 65536 } },
    ],
    responses: {
      200: {
        description: 'The latest log tail',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['text', 'collectedAt', 'requestedAt', 'pending', 'truncated'],
              properties: {
                text: { type: 'string' },
                collectedAt: { type: ['string', 'null'], format: 'date-time' },
                requestedAt: { type: ['string', 'null'], format: 'date-time' },
                pending: { type: 'boolean', description: 'true while the node has not answered the latest request' },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan or worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { WORKER_LOGS_DEFAULT_TAIL_BYTES, workerLogsParams, workerLogsQuery } from '#shared/schemas/scans'
import { getWorkerLogs } from '../../../../../services/scans/worker-logs'
import { loadOwnedScan, requireUser } from '../../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId, workerId } = validateParams(event, workerLogsParams)
  const query = validateQuery(event, workerLogsQuery)
  const scan = await loadOwnedScan(principal, scanId)
  return getWorkerLogs(event, scan, workerId, {
    tailBytes: query.tailBytes ?? WORKER_LOGS_DEFAULT_TAIL_BYTES,
    waitSeconds: query.wait,
    userId: principal.user.id,
  })
})
