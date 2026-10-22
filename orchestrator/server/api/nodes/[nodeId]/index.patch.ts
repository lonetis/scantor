defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'updateNode',
    summary: 'Update a node',
    description:
      'Admin only. Changes the admin-owned attributes of a node: name, pool, labels, the maxWorkers override (null removes it) and cordoned (a cordoned node gets no new workers; running ones stay). The built-in node keeps its name (409 builtInNode). 409 alreadyExists when the new name is taken.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
              pool: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
              labels: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 63 } },
              maxWorkers: { type: ['integer', 'null'], minimum: 0 },
              cordoned: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The updated node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'alreadyExists or builtInNode', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams, updateNodeBody } from '#shared/schemas/nodes'
import { updateNode } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const { nodeId } = validateParams(event, nodeIdParams)
  return updateNode(nodeId, await validateBody(event, updateNodeBody))
})
