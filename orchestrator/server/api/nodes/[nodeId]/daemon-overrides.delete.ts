defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'deleteNodeDaemonOverrides',
    summary: 'Reset the daemon overrides of a node',
    description:
      'Admin only. Removes every daemon override of the running node daemon, which returns to the values of its environment at once (removing a dns override replaces the node resolver). Idempotent: a node without overrides is returned unchanged. Overrides also end when the daemon stops. 409 invalidState when other writes changed the overrides concurrently three times in a row; retry.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The node with its daemon configuration', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: {
        description: 'invalidState: the overrides changed concurrently',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams } from '#shared/schemas/nodes'
import { deleteNodeDaemonOverrides } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateParams } from '../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler((event) => {
  const principal = requireAdmin(event)
  return deleteNodeDaemonOverrides(validateParams(event, nodeIdParams).nodeId, principal.user.id, log)
})
