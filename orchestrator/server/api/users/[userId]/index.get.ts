defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'getUser',
    summary: 'Get a user',
    description: 'Admin only. Returns one user with usage counters.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { userIdParams } from '#shared/schemas/users'
import { getApiUser } from '../../../services/users'
import { requireAdmin } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return getApiUser(validateParams(event, userIdParams).userId)
})
