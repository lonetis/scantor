defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'createUser',
    summary: 'Create a user',
    description:
      'Admin only. Creates an account. Without a password the user cannot sign in until an admin sets one. role defaults to user, canRunPrivileged to false and maxWorkers to the deployment default. 409 alreadyExists for a taken email.',
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
            required: ['email', 'name'],
            properties: {
              email: { type: 'string', format: 'email', maxLength: 254 },
              name: { type: 'string', minLength: 1, maxLength: 100 },
              password: { type: 'string', minLength: 8, maxLength: 128 },
              role: { type: 'string', enum: ['admin', 'user'], default: 'user' },
              canRunPrivileged: { type: 'boolean', default: false },
              maxWorkers: { type: 'integer', minimum: 0, description: '0 = unlimited' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The created user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Email taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createUserBody } from '#shared/schemas/users'
import { toApiUser } from '../../services/users'
import { requireAdmin } from '../../utils/authz'
import { createUserAccount } from '../../utils/users'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await validateBody(event, createUserBody)
  const user = await createUserAccount(body)
  setResponseStatus(event, 201)
  return toApiUser(user)
})
