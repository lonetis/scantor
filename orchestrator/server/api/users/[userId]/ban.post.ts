defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'banUser',
    summary: 'Ban a user',
    description:
      "Admin only. Blocks every sign-in and credential of the user: sessions are revoked, API keys and OAuth grants deleted and the editor stopped. Worker tokens of the user's running scans stay valid unless cancelScans is true, which cancels those scans. Not for yourself (400 badRequest).",
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    'x-destructive': true,
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reason: { type: 'string', minLength: 1, maxLength: 500 },
              cancelScans: { type: 'boolean', default: false },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The banned user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Invalid input or yourself', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The user is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { banUserBody, userIdParams } from '#shared/schemas/users'
import { assertUserNotBeingDeleted, getApiUser } from '../../../services/users'
import { requireAdmin } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { banUserAccount, findAuthUser } from '../../../utils/users'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const { userId } = validateParams(event, userIdParams)
  const body = await validateBody(event, banUserBody)
  if (userId === principal.user.id) throw apiError('badRequest', 'you cannot ban yourself')
  if (!(await findAuthUser(userId))) throw apiError('notFound', 'user not found')
  await assertUserNotBeingDeleted(userId)
  await banUserAccount(userId, { reason: body.reason ?? null, cancelScans: body.cancelScans })
  return getApiUser(userId)
})
