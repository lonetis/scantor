defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'setAccountPassword',
    summary: 'Set a password',
    description:
      'Adds a password to an account that has none (for example a passkey-first admin). Browser session only. Use POST /api/auth/change-password to change an existing password (409 alreadyExists here).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    'x-session-only': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['newPassword'],
            properties: { newPassword: { type: 'string', minLength: 8, maxLength: 128 } },
          },
        },
      },
    },
    responses: {
      204: { description: 'Password set' },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Browser session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'A password is already set', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { setAccountPasswordBody } from '#shared/schemas/account'
import { requireSession } from '../../utils/authz'
import { setOwnPassword } from '../../utils/users'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireSession(event)
  const body = await validateBody(event, setAccountPasswordBody)
  await setOwnPassword(principal.user.id, body.newPassword)
  return sendNoContent(event)
})
