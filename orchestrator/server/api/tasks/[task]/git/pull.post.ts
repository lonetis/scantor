defineRouteMeta({
  openAPI: {
    tags: ['git'],
    operationId: 'pullGitTask',
    summary: 'Pull a git task',
    description:
      'Updates the workspace of a task imported from git to the current remote state of its ref (fast-forward only). 409 gitDiverged when the workspace changed since the last import or pull, or when the remote history is not a fast-forward; force=true overwrites the workspace anyway. Pull never publishes; call publishRevision afterwards. Returns the previous and the new commit and whether the content changed. 409 invalidState for tasks not imported from git; 422 gitFailed.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean', default: false } } },
        },
      },
    },
    responses: {
      200: {
        description: 'Pulled',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['task', 'previousCommit', 'commit', 'changed'],
              properties: {
                task: { $ref: '#/components/schemas/Task' },
                previousCommit: { type: 'string' },
                commit: { type: 'string' },
                changed: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Diverged or not a git task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'git failed or invalid manifest', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { pullGitBody, taskParams } from '#shared/schemas/tasks'
import { pullGitTask } from '../../../../services/tasks/git'
import { toApiTask } from '../../../../services/tasks/mappers'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const body = await validateBody(event, pullGitBody)
  const outcome = await pullGitTask(await resolveTask(principal, task), { force: body.force })
  return { task: toApiTask(outcome.task), previousCommit: outcome.previousCommit, commit: outcome.commit, changed: outcome.changed }
})
