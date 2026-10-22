defineRouteMeta({
  openAPI: {
    tags: ['setup'],
    operationId: 'createSetupAdmin',
    summary: 'Create the first admin',
    description:
      'Creates the first admin account with a password while no user exists. Needs the one-time setup token from the orchestrator log in the X-Scantor-Setup-Token header. Fails with 409 setupCompleted once any user exists and 401 setupTokenInvalid for a missing or wrong token. Sign in afterwards with POST /api/auth/sign-in/email.',
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
            required: ['email', 'name', 'password'],
            properties: {
              email: { type: 'string', format: 'email', maxLength: 254 },
              name: { type: 'string', minLength: 1, maxLength: 100 },
              password: { type: 'string', minLength: 8, maxLength: 128 },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The created admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Missing or wrong setup token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Setup already completed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createSetupAdminBody } from '#shared/schemas/setup'
import { toApiUser } from '../../services/users'
import { requireSetup } from '../../utils/authz'
import { assertNoUsers, discardSetupToken, withSetupMutex } from '../../utils/setup'
import { createUserAccount } from '../../utils/users'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  requireSetup(event)
  const body = await validateBody(event, createSetupAdminBody)
  const user = await withSetupMutex(async () => {
    await assertNoUsers()
    const created = await createUserAccount({ ...body, role: 'admin', canRunPrivileged: false })
    discardSetupToken()
    return created
  })
  setResponseStatus(event, 201)
  return toApiUser(user)
})
