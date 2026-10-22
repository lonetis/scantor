defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'deleteTask',
    summary: 'Delete a task',
    description:
      'Deletes a task with everything that belongs to it: the workspace folder, all revisions with their snapshots, build logs and images, and its test runs. The task disappears at once; a taskDelete job (202, follow it with getJob) removes the data. 409 taskInUse while a scan that is not finished (creating, running, paused) or being deleted uses the task.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      202: {
        description: 'Deletion started',
        content: { 'application/json': { schema: { type: 'object', required: ['job'], properties: { job: { $ref: '#/components/schemas/JobRef' } } } } },
      },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'A scan uses the task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { taskParams } from '#shared/schemas/tasks'
import { requestTaskDeletion } from '../../../services/tasks'
import { requireUser, resolveTask } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const job = await requestTaskDeletion(await resolveTask(principal, task))
  setResponseStatus(event, 202)
  return { job }
})
