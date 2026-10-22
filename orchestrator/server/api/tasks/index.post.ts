defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'createTask',
    summary: 'Create a task from a scaffold',
    description:
      'Creates a task and renders the starter scaffold of a language and template into your workspace (folder <name>/). template is a template name from listTemplates (default single: no schedule, one analysis) or "custom" (a generator stub). The scaffold publishes unchanged. Next steps: edit files (writeTaskFiles or the editor), run testTask, then publishRevision. Get the authoring guide with getAuthoringGuide. 409 alreadyExists when the name is taken; 400 for an unknown language or template or a reserved name (upload, import-git, new, latest).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'language'],
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$', description: 'slug unique among your tasks; immutable' },
              language: { type: 'string', enum: ['python', 'typescript', 'javascript', 'go'] },
              template: { type: 'string', default: 'single', description: 'a template name of listTemplates or "custom"' },
              description: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Name taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'No workspace helper slot became free', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createTaskBody } from '#shared/schemas/tasks'
import { createTask } from '../../services/tasks'
import { requireUser } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, createTaskBody)
  const task = await createTask(principal, body)
  setResponseStatus(event, 201)
  return task
})
