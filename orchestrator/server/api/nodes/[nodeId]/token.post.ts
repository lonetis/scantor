defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'rotateNodeToken',
    summary: 'Rotate a node token',
    description:
      'Admin only. Replaces the node token and returns the new one exactly once with fresh join instructions. The old token fails at once: the running daemon gets 401 and must be restarted with the new token (its workers keep running until then, or are lost after the offline window). A revoked node returns to pending. The built-in node\'s token is derived from SCANTOR_SECRET and cannot be rotated (409 builtInNode).',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    'x-destructive': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The node with its new token (shown once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeWithToken' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'builtInNode', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { rotateNodeToken } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateParams } from '../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler((event) => {
  requireAdmin(event)
  return rotateNodeToken(validateParams(event, nodeIdParams).nodeId, log)
})
