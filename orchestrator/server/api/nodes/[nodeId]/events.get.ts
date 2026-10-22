defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'listNodeEvents',
    summary: 'List the events of a node',
    description:
      'Admin only. Events that reference this node, newest first: node.online, node.offline, node.revoked, node.tokenRotated, node.instanceConflict and worker events of workers on the node. Filter by type (an exact type, or a prefix ending in ".", for example "worker."); page with cursor and limit.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [
      { name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string', maxLength: 64 } },
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
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Event' } },
                nextCursor: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listNodeEventsQuery, nodeIdParams } from '#shared/schemas/nodes'
import { listNodeEvents } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const { nodeId } = validateParams(event, nodeIdParams)
  return listNodeEvents(nodeId, validateQuery(event, listNodeEventsQuery))
})
