defineRouteMeta({
  openAPI: {
    tags: ['users'],
    operationId: 'deleteUser',
    summary: 'Delete a user',
    description:
      "Admin only. Locks the user out at once (sessions, API keys, OAuth grants, editor) and starts a userPurge job that cancels the user's scans and deletes every resource of the user, then the account. Poll the returned job with getJob. Not for yourself (400 badRequest).",
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      202: {
        description: 'Deletion accepted',
        content: {
          'application/json': { schema: { type: 'object', required: ['job'], properties: { job: { $ref: '#/components/schemas/JobRef' } } } },
        },
      },
      400: { description: 'Yourself', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { userIdParams } from '#shared/schemas/users'
import { toJobRef } from '../../../services/jobs/mappers'
import { requireAdmin } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { createJob } from '../../../utils/jobs'
import { findAuthUser, lockOutDeletedUser } from '../../../utils/users'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const { userId } = validateParams(event, userIdParams)
  if (userId === principal.user.id) throw apiError('badRequest', 'you cannot delete yourself')
  if (!(await findAuthUser(userId))) throw apiError('notFound', 'user not found')
  await lockOutDeletedUser(userId)
  const { job } = await createJob({ kind: 'userPurge', userId, subject: { kind: 'user', id: userId } })
  setResponseStatus(event, 202)
  return { job: toJobRef(job) }
})
