defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'unbanUser',
    summary: 'Unban a user',
    description: 'Admin only. Clears the ban flag. Deleted sessions, API keys and OAuth grants stay deleted; the user signs in again and creates new keys.',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The user is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { emptyBody } from '#shared/schemas/common'
import { userIdParams } from '#shared/schemas/users'
import { assertUserNotBeingDeleted, getApiUser } from '../../../services/users'
import { requireAdmin } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { findAuthUser, unbanUserAccount } from '../../../utils/users'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const { userId } = validateParams(event, userIdParams)
  await validateBody(event, emptyBody)
  const user = await findAuthUser(userId)
  if (!user) throw apiError('notFound', 'user not found')
  await assertUserNotBeingDeleted(userId)
  if (user.banned) await unbanUserAccount(userId)
  return getApiUser(userId)
})
