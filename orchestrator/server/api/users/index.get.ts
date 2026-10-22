defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'listUsers',
    summary: 'List users',
    description:
      'Admin only. Lists every user, newest first, with role, ban state, privileged-task permission, worker cap and usage counters. Filter with q (case-insensitive substring of email or name); page with cursor and limit.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [
      { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 254 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of users',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/User' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          User: {
            type: 'object',
            required: ['id', 'email', 'name', 'role', 'banned', 'banReason', 'canRunPrivileged', 'maxWorkers', 'createdAt', 'updatedAt', 'usage'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'user'] },
              banned: { type: 'boolean' },
              banReason: { type: ['string', 'null'] },
              canRunPrivileged: { type: 'boolean' },
              maxWorkers: { type: 'integer', description: '0 = unlimited' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              usage: {
                type: 'object',
                properties: { activeWorkers: { type: 'integer' }, tasks: { type: 'integer' }, scans: { type: 'integer' } },
              },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listUsersQuery } from '#shared/schemas/users'
import { listApiUsers } from '../../services/users'
import { requireAdmin } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listApiUsers(validateQuery(event, listUsersQuery))
})
