defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'createNode',
    summary: 'Add a remote node',
    description:
      'Admin only. Creates a remote node record in state pending and returns its node token exactly once, with a ready-to-run docker run command and compose file (NodeJoin). The node joins when its daemon calls hello with that token. pool (default "shared") and labels are matched by scan nodeSelectors; maxWorkers caps the node below its reported capacity. A node sees everything about the scans placed on it; add only machines you trust like the master. 409 alreadyExists when the name is taken.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
              pool: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$', default: 'shared' },
              labels: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 63 } },
              maxWorkers: { type: ['integer', 'null'], minimum: 0 },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The node with its token (shown once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeWithToken' } } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'alreadyExists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createNodeBody } from '#shared/schemas/nodes'
import { createNode } from '../../services/nodes/admin'
import { requireAdmin } from '../../utils/authz'
import { useLogger } from '../../utils/logger'
import { validateBody } from '../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const body = await validateBody(event, createNodeBody)
  const created = await createNode(body, principal.user.id, log)
  setResponseStatus(event, 201)
  return created
})
