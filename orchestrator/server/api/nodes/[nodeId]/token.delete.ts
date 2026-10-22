defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'revokeNodeToken',
    summary: 'Revoke a node token',
    description:
      'Admin only. Revokes the node token: the node becomes revoked, its active workers are marked lost at once (their worker tokens stop working and placement reschedules them elsewhere) and registry pulls are denied. Rotate the token to let the node join again. The built-in node cannot be revoked (409 builtInNode).',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The revoked node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'builtInNode', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { revokeNodeToken } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateParams } from '../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler((event) => {
  requireAdmin(event)
  return revokeNodeToken(validateParams(event, nodeIdParams).nodeId, log)
})
