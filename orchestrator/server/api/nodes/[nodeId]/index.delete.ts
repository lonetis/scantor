defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'deleteNode',
    summary: 'Delete a node',
    description:
      'Admin only. Revokes the node token, marks every active worker of the node lost (placement replaces them on other nodes) and removes the node record. The daemon then gets 401 and removes its workers after the offline window. The built-in node cannot be deleted (409 builtInNode).',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      204: { description: 'Deleted' },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'builtInNode', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { deleteNode } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateParams } from '../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  await deleteNode(validateParams(event, nodeIdParams).nodeId, principal.user.id, log)
  return sendNoContent(event)
})
