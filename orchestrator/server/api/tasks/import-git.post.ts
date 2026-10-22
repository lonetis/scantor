defineRouteMeta({
  openAPI: {
    tags: ['git'],
    operationId: 'importGitTask',
    summary: 'Import tasks from git',
    description:
      'Imports task folders from an https git repository (shallow fetch of ref; no submodules). Every scantor.yaml under path is a candidate. One valid candidate is imported at once (201 with imported). Several candidates return 200 with imported: [] and the candidates; call again with select listing the candidate paths to import. Each imported task records its git source so pullGitTask can update it; nothing is published. Private repositories need credentialId, a git credential for exactly the URL\'s host. The URL must be https without credentials and resolve to public addresses. 409 alreadyExists when a task of that name exists; 422 gitFailed (clone or fetch failed, details.message) or manifestInvalid.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: {
              url: { type: 'string', maxLength: 2048, description: 'https URL of the repository' },
              ref: { type: 'string', maxLength: 255, default: 'HEAD', description: 'branch, tag, full commit hash or HEAD' },
              path: { type: 'string', maxLength: 1024, default: '.', description: 'folder of the repository to search' },
              credentialId: { type: 'string', format: 'uuid' },
              select: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 1024 }, description: 'candidate paths to import' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Several candidates; select some', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitImport' } } } },
      201: { description: 'Imported', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitImport' } } } },
      400: { description: 'Invalid input or URL', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Name taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'git failed or invalid manifest', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          GitImport: {
            type: 'object',
            required: ['imported', 'candidates'],
            properties: {
              imported: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['path', 'name', 'language', 'exists'],
                  properties: {
                    path: { type: 'string' },
                    name: { type: 'string' },
                    language: { type: 'string' },
                    exists: { type: 'boolean', description: 'a task of this name exists already' },
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

import { defineEventHandler, setResponseStatus } from 'h3'
import { importGitBody } from '#shared/schemas/tasks'
import { importGitTask } from '../../services/tasks/git'
import { toApiTask } from '../../services/tasks/mappers'
import { requireUser } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, importGitBody)
  const outcome = await importGitTask(principal, body)
  setResponseStatus(event, outcome.imported.length > 0 ? 201 : 200)
  return { imported: outcome.imported.map(toApiTask), candidates: outcome.candidates }
})
