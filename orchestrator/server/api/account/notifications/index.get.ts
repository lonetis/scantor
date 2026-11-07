defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'getNotificationSettings',
    summary: 'Get your notification settings',
    description:
      'Returns your push notification settings: whether this instance sends push notifications (available), the ntfy server of the instance, your topic, whether an access token is stored (the token itself is never returned), whether the channel is enabled, the triggers you subscribed to and the outcome of the last delivery.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The notification settings',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationSettings' } } },
      },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          NotificationSettings: {
            type: 'object',
            required: ['available', 'ntfy'],
            properties: {
              available: { type: 'boolean', description: 'false when the operator disabled push notifications (SCANTOR_NTFY_URL is empty)' },
              ntfy: {
                type: 'object',
                required: ['server', 'enabled', 'topic', 'tokenSet', 'triggers', 'lastDelivery'],
                properties: {
                  server: { type: ['string', 'null'], description: 'the ntfy server of this instance; subscribe to <server>/<topic>' },
                  enabled: { type: 'boolean' },
                  topic: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_-]{1,64}$' },
                  tokenSet: { type: 'boolean', description: 'whether an access token is stored; the token is never returned' },
                  triggers: {
                    type: 'array',
                    items: { type: 'string', enum: ['scanFinished', 'scanPaused', 'scanProblem', 'revisionBuilt', 'nodeAvailability'] },
                  },
                  lastDelivery: {
                    type: ['object', 'null'],
                    description: 'the outcome of the last delivery or test message',
                    required: ['at', 'ok', 'status', 'message'],
                    properties: {
                      at: { type: 'string', format: 'date-time' },
                      ok: { type: 'boolean' },
                      status: { type: ['integer', 'null'], description: 'HTTP status of the ntfy answer; null when the server could not be reached' },
                      message: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { findNotificationSettings, toApiNotificationSettings } from '../../../services/notifications/settings'
import { requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  return toApiNotificationSettings(await findNotificationSettings(principal.user.id), useConfig())
})
