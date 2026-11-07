defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'testNotification',
    summary: 'Send a test notification',
    description:
      'Publishes a test message to your saved ntfy topic at once (also while the channel is disabled) and returns what the ntfy server answered: delivered, its HTTP status (null when it could not be reached) and its error message. 409 invalidState when this instance sends no push notifications or no topic is saved; one test every 10 seconds (429 tooManyRequests with details.retryAfterMs).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The answer of the ntfy server',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['delivered', 'status', 'message'],
              properties: {
                delivered: { type: 'boolean' },
                status: { type: ['integer', 'null'] },
                message: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: {
        description: 'Notifications are disabled or no topic is saved',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      429: { description: 'A test was sent less than 10 seconds ago', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { sendTestNotification } from '../../../services/notifications'
import { requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  return sendTestNotification(principal.user.id, useConfig())
})
