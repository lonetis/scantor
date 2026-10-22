defineRouteMeta({
  openAPI: {
    tags: ['credentials'],
    operationId: 'updateCredential',
    summary: 'Update a git credential',
    description:
      'Changes the name, host, username or token of a git credential (at least one field). An omitted token keeps the stored one. Tasks imported with the credential keep using it for pulls. 404 when the credential is not yours; 409 alreadyExists for a taken name.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'credentialId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 64 },
              host: { type: 'string', minLength: 1, maxLength: 261 },
              username: { type: 'string', minLength: 1, maxLength: 128 },
              token: { type: 'string', minLength: 1, maxLength: 4096, writeOnly: true },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Credential' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Name taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { credentialParams, updateCredentialBody } from '#shared/schemas/tasks'
import { updateCredential } from '../../services/credentials'
import { requireUser } from '../../utils/authz'
import { validateBody, validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { credentialId } = validateParams(event, credentialParams)
  const body = await validateBody(event, updateCredentialBody)
  return updateCredential(principal, credentialId, body)
})
