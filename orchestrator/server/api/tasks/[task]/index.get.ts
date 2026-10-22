defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'getTask',
    summary: 'Get a task',
    description:
      'Returns one task by id or name: language, source (scaffold, upload or git), the cached workspace status (dirty = unpublished changes), revision count, latest revision and latest ready revision. Use getTaskWorkspace for a freshly computed workspace hash.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      200: { description: 'The task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { taskParams } from '#shared/schemas/tasks'
import { toApiTask } from '../../../services/tasks/mappers'
import { requireUser, resolveTask } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  return toApiTask(await resolveTask(principal, task))
})
