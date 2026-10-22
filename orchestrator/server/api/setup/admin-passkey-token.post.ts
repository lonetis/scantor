defineRouteMeta({
  openAPI: {
    tags: ['setup'],
    operationId: 'createSetupPasskeyToken',
    summary: 'Create a passkey setup token',
    description:
      'Starts the passkey-first creation of the first admin. Returns a single-use spk_ token (valid 5 minutes) that the browser passes as the passkey registration context; the admin is created only after a successful WebAuthn ceremony. Needs the setup token; 400 passkeysDisabled when passkeys are unavailable on this deployment.',
    'x-scantor-scope': 'setup',
    'x-mcp': false,
    parameters: [
      { name: 'X-Scantor-Setup-Token', in: 'header', required: true, schema: { type: 'string' }, description: 'The setup token (sst_…) from the setup link' },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['email', 'name'],
            properties: {
              email: { type: 'string', format: 'email', maxLength: 254 },
              name: { type: 'string', minLength: 1, maxLength: 100 },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'The passkey setup token',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'expiresIn'],
              properties: { token: { type: 'string' }, expiresIn: { type: 'integer', description: 'seconds' } },
            },
          },
        },
      },
      400: { description: 'Passkeys disabled or invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Missing or wrong setup token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Setup already completed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createSetupPasskeyTokenBody } from '#shared/schemas/setup'
import { resolvePasskeyConfig } from '../../utils/auth-policy'
import { requireSetup } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { assertNoUsers, createPasskeySetupToken, withSetupMutex } from '../../utils/setup'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  requireSetup(event)
  if (!resolvePasskeyConfig(useConfig()).enabled) throw apiError('passkeysDisabled', 'passkeys are disabled on this deployment')
  const body = await validateBody(event, createSetupPasskeyTokenBody)
  const token = await withSetupMutex(async () => {
    await assertNoUsers()
    return createPasskeySetupToken(body.email, body.name)
  })
  setResponseStatus(event, 201)
  return token
})
