defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'getNode',
    summary: 'Get a node',
    description: 'Admin only. One node with its state, lease holder (version, start, last contact), reported capacity and active worker count.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { getNode } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return getNode(validateParams(event, nodeIdParams).nodeId)
})
