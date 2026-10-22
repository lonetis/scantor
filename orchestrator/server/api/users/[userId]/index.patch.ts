defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'updateUser',
    summary: 'Update a user',
    description:
      'Admin only. Changes name, email, role, privileged-task permission or worker cap (0 = unlimited). Admins cannot demote themselves (400 badRequest), so at least one admin always remains. Role and permission changes reach every credential of the user within 30 seconds.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              email: { type: 'string', format: 'email', maxLength: 254 },
              role: { type: 'string', enum: ['admin', 'user'] },
              canRunPrivileged: { type: 'boolean' },
              maxWorkers: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Invalid input or demoting yourself', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Email taken, or the user is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { updateUserBody, userIdParams } from '#shared/schemas/users'
import { assertUserNotBeingDeleted, getApiUser } from '../../../services/users'
import { requireAdmin } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { findAuthUser, updateUserAccount } from '../../../utils/users'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const { userId } = validateParams(event, userIdParams)
  const body = await validateBody(event, updateUserBody)
  if (!(await findAuthUser(userId))) throw apiError('notFound', 'user not found')
  await assertUserNotBeingDeleted(userId)
  if (userId === principal.user.id && body.role !== undefined && body.role !== 'admin') {
    throw apiError('badRequest', 'you cannot demote yourself')
  }
  await updateUserAccount(userId, body)
  return getApiUser(userId)
})
