defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'listScanWorkers',
    summary: 'List scan workers',
    description:
      'Lists the worker containers of a scan, newest first: role (scheduler or runner), state with its reason (for example why a worker is pending), node, processes desired / assigned / applied / running, container restarts and last exit, runtime version and last report. Filter by state (comma-separated, for example running,backoff); page with cursor and limit. Stopped and lost workers are kept for 7 days.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        name: 'state',
        in: 'query',
        required: false,
        description: 'Comma-separated worker states: pending, assigned, pulling, starting, running, backoff, draining, stopped, lost.',
        schema: { type: 'string', maxLength: 200 },
      },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of workers',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Worker' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listScanWorkersQuery, scanIdParams } from '#shared/schemas/scans'
import { listScanWorkers } from '../../../../services/scans/workers'
import { loadOwnedScan, requireUser } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const query = validateQuery(event, listScanWorkersQuery)
  return listScanWorkers(await loadOwnedScan(principal, scanId), query)
})
