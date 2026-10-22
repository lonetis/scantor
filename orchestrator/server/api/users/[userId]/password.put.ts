defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'setUserPassword',
    summary: "Set a user's password",
    description:
      "Admin only. Sets or replaces another user's password and signs that user out everywhere. Not for your own account (400 badRequest); use the account page instead.",
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
            required: ['password'],
            properties: { password: { type: 'string', minLength: 8, maxLength: 128 } },
          },
        },
      },
    },
    responses: {
      204: { description: 'Password set' },
      400: { description: 'Invalid input or your own account', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The user is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { setUserPasswordBody, userIdParams } from '#shared/schemas/users'
import { assertUserNotBeingDeleted } from '../../../services/users'
import { requireAdmin } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { findAuthUser, setUserPassword } from '../../../utils/users'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const { userId } = validateParams(event, userIdParams)
  const body = await validateBody(event, setUserPasswordBody)
  if (userId === principal.user.id) throw apiError('badRequest', 'use the account page to change your own password')
  if (!(await findAuthUser(userId))) throw apiError('notFound', 'user not found')
  await assertUserNotBeingDeleted(userId)
  await setUserPassword(userId, body.password)
  return sendNoContent(event)
})
