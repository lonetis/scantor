defineRouteMeta({
  openAPI: {
    tags: ['task-files'],
    operationId: 'deleteTaskFile',
    summary: 'Delete a task file',
    description:
      'Deletes a file (or, with recursive=true, a folder) of a task\'s workspace folder. Deleting a symlink removes the link only. Returns the deleted paths and the new workspace hash. The task root cannot be deleted this way; use deleteTask.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: true, description: 'Path relative to the task root.', schema: { type: 'string', minLength: 1, maxLength: 1024 } },
      { name: 'recursive', in: 'query', required: false, description: 'Allow deleting a non-empty folder.', schema: { type: 'boolean', default: false } },
    ],
    responses: {
      200: {
        description: 'Deleted',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['deleted', 'workspace'],
              properties: {
                deleted: { type: 'array', items: { type: 'string' } },
                workspace: { type: 'object', required: ['packSha256', 'dirty'], properties: { packSha256: { type: 'string' }, dirty: { type: 'boolean' } } },
              },
            },
          },
        },
      },
      404: { description: 'No such task or path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { deleteTaskFileQuery, taskParams } from '#shared/schemas/tasks'
import { deleteTaskFile } from '../../../../services/tasks/files'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const query = validateQuery(event, deleteTaskFileQuery)
  return deleteTaskFile(await resolveTask(principal, task), query)
})
