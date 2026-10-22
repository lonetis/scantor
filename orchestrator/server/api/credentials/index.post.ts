defineRouteMeta({
  openAPI: {
    tags: ['credentials'],
    operationId: 'createCredential',
    summary: 'Create a git credential',
    description:
      'Stores an HTTPS token for git import and pull, encrypted at rest. host is host[:port] without scheme; the token is sent only to that exact host as Basic auth with username (default x-access-token, which works for GitHub and most forges). The token is never returned again. 409 alreadyExists when the name is taken.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'name', 'host', 'token'],
            properties: {
              kind: { type: 'string', enum: ['gitToken'] },
              name: { type: 'string', minLength: 1, maxLength: 64 },
              host: { type: 'string', minLength: 1, maxLength: 261, description: 'host[:port], for example github.com' },
              username: { type: 'string', minLength: 1, maxLength: 128, default: 'x-access-token' },
              token: { type: 'string', minLength: 1, maxLength: 4096, writeOnly: true },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Credential' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Name taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createCredentialBody } from '#shared/schemas/tasks'
import { createCredential } from '../../services/credentials'
import { requireUser } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, createCredentialBody)
  const credential = await createCredential(principal, body)
  setResponseStatus(event, 201)
  return credential
})
