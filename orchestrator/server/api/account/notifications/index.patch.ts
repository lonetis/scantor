defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'updateNotificationSettings',
    summary: 'Update your notification settings',
    description:
      'Changes your ntfy push notifications. Omitted fields keep their value: topic is the ntfy topic on the instance server (1-64 letters, digits, - or _; null clears it), token an optional ntfy access token (stored encrypted and never returned; null removes it), enabled turns the channel on (needs a topic) and triggers lists the events you want (scanFinished, scanPaused, scanProblem, revisionBuilt and, for admins only, nodeAvailability). Topics on a public ntfy server are readable by anyone who knows their name, so choose a hard-to-guess one or use a token. Returns the settings.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ntfy: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  enabled: { type: 'boolean' },
                  topic: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_-]{1,64}$' },
                  token: { type: ['string', 'null'], minLength: 1, maxLength: 256, writeOnly: true },
                  triggers: {
                    type: 'array',
                    uniqueItems: true,
                    items: { type: 'string', enum: ['scanFinished', 'scanPaused', 'scanProblem', 'revisionBuilt', 'nodeAvailability'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The updated settings',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationSettings' } } },
      },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { updateNotificationSettingsBody } from '#shared/schemas/notifications'
import { toApiNotificationSettings, updateNotificationSettings } from '../../../services/notifications/settings'
import { requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateBody } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, updateNotificationSettingsBody)
  const settings = await updateNotificationSettings(principal.user.id, body, { isAdmin: principal.isAdmin })
  return toApiNotificationSettings(settings, useConfig())
})
