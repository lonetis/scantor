defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'removeAccountPassword',
    summary: 'Remove your password',
    description:
      'Removes the password so that only passkeys can sign in. Browser session only. Refused with 409 lastCredential when no passkey is registered, so every account keeps a way to sign in.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    'x-session-only': true,
    responses: {
      204: { description: 'Password removed' },
      403: { description: 'Browser session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'No passkey is registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { requireSession } from '../../utils/authz'
import { removeOwnPassword } from '../../utils/users'

export default defineEventHandler(async (event) => {
  await removeOwnPassword(requireSession(event).user.id)
  return sendNoContent(event)
})
