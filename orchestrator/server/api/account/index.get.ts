defineRouteMeta({
  openAPI: {
    tags: ['account'],
    operationId: 'getAccount',
    summary: 'Get your account',
    description:
      'Returns the signed-in user: profile, role, privileged-task permission, worker cap (0 = unlimited) and a summary of sign-in credentials (whether a password is set and how many passkeys exist).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: { description: 'The account', content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Account: {
            type: 'object',
            required: ['id', 'email', 'name', 'role', 'canRunPrivileged', 'maxWorkers', 'credentials', 'createdAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'user'] },
              canRunPrivileged: { type: 'boolean' },
              maxWorkers: { type: 'integer', description: '0 = unlimited' },
              credentials: {
                type: 'object',
                properties: { hasPassword: { type: 'boolean' }, passkeyCount: { type: 'integer' } },
              },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
          ApiKey: {
            type: 'object',
            required: ['id', 'name', 'start', 'configId', 'enabled', 'createdAt', 'expiresAt', 'lastRequest'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: ['string', 'null'] },
              start: { type: ['string', 'null'], description: 'first characters of the key, for recognition' },
              configId: { type: 'string', enum: ['default', 'editor'] },
              enabled: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: ['string', 'null'], format: 'date-time' },
              lastRequest: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          OAuthApp: {
            type: 'object',
            required: ['clientId', 'name', 'uri', 'scopes', 'createdAt'],
            properties: {
              clientId: { type: 'string' },
              name: { type: ['string', 'null'] },
              uri: { type: ['string', 'null'] },
              scopes: { type: 'array', items: { type: 'string' } },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getApiAccount } from '../../services/account'
import { requireUser } from '../../utils/authz'

export default defineEventHandler((event) => getApiAccount(requireUser(event).user.id))
