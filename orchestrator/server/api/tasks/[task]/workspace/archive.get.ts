defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'downloadTaskWorkspace',
    summary: 'Download the workspace',
    description:
      'Downloads the deterministic pack (tar.gz) of the task\'s workspace folder: the exact content a publish would snapshot (.git/ and .scantor/ excluded, .dockerignore applied). 404 when the workspace folder does not exist.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      200: { description: 'The pack', content: { 'application/gzip': { schema: { type: 'string', contentMediaType: 'application/gzip' } } } },
      404: { description: 'No such task or workspace folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { taskParams } from '#shared/schemas/tasks'
import { sendWorkspaceArchive } from '../../../../services/tasks/files'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  return sendWorkspaceArchive(event, await resolveTask(principal, task))
})
