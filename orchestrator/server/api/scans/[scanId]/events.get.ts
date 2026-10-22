defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'listScanEvents',
    summary: 'List scan events',
    description:
      'Lists the timeline of a scan, newest first: state changes with their reasons, scaling, retries, restarts, raised and cleared conditions, template resolutions, the end of scheduling, lost analyses, and worker events (placed, pending, started, stopped, crashed, error, lost). Filter with type, either an exact type (scan.stateChanged) or a prefix ending in a dot (scan., worker.). Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'type', in: 'query', required: false, description: 'An event type or a prefix ending in a dot.', schema: { type: 'string', maxLength: 97 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of events',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Event' } }, nextCursor: { type: ['string', 'null'] } },
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
import { listScanEventsQuery, scanIdParams } from '#shared/schemas/scans'
import { listScanEvents } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const query = validateQuery(event, listScanEventsQuery)
  return listScanEvents(await loadOwnedScan(principal, scanId), query)
})
