defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'listNodeWorkers',
    summary: 'List the workers of a node',
    description:
      'Admin only. Workers whose nodeId is this node, newest first, with their scan, role, state, processes, container restarts and last exit. Filter by state (comma-separated list); page with cursor and limit.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [
      { name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'state', in: 'query', required: false, description: 'comma-separated worker states', schema: { type: 'string' } },
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
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Worker' } },
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
import { listNodeWorkersQuery, nodeIdParams } from '#shared/schemas/nodes'
import { listNodeWorkers } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const { nodeId } = validateParams(event, nodeIdParams)
  return listNodeWorkers(nodeId, validateQuery(event, listNodeWorkersQuery))
})
