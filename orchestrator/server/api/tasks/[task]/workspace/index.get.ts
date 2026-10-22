defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'getTaskWorkspace',
    summary: 'Get the workspace status',
    description:
      'Computes the pack hash of the task\'s workspace folder now (the hash a publish would record) and refreshes the cached status. dirty = the workspace differs from the latest revision; lastSyncSha256 is the hash after the last upload, git import or pull. 404 when the workspace folder does not exist.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      200: {
        description: 'The workspace status',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['packSha256', 'fileCount', 'bytes', 'dirty', 'latestRevisionPackSha256', 'lastSyncSha256', 'checkedAt'],
              properties: {
                packSha256: { type: 'string' },
                fileCount: { type: 'integer' },
                bytes: { type: 'integer' },
                dirty: { type: 'boolean' },
                latestRevisionPackSha256: { type: ['string', 'null'] },
                lastSyncSha256: { type: ['string', 'null'] },
                checkedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      404: { description: 'No such task or workspace folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'No workspace helper slot became free', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { taskParams } from '#shared/schemas/tasks'
import { getWorkspaceStatus } from '../../../../services/tasks'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  return getWorkspaceStatus(await resolveTask(principal, task))
})
