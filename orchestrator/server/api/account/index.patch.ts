defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'updateAccount',
    summary: 'Update your profile',
    description: 'Changes the display name of the signed-in user. Email and password changes go through /api/auth (change-email, change-password).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
    responses: {
      200: { description: 'The updated account', content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { updateAccountBody } from '#shared/schemas/account'
import { getApiAccount } from '../../services/account'
import { requireUser } from '../../utils/authz'
import { updateUserAccount } from '../../utils/users'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, updateAccountBody)
  await updateUserAccount(principal.user.id, { name: body.name })
  return getApiAccount(principal.user.id)
})
