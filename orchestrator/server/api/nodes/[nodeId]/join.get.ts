defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'getNodeJoin',
    summary: 'Get the join instructions of a node',
    description:
      'Admin only. The docker run command and compose file that start the node daemon, with the token replaced by the placeholder ${SCANTOR_NODE_TOKEN} (tokens are shown only when created or rotated).',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The join instructions', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeJoin' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { getNodeJoin } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return getNodeJoin(validateParams(event, nodeIdParams).nodeId)
})
