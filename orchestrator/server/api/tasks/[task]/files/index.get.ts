defineRouteMeta({
  openAPI: {
    tags: ['task-files'],
    operationId: 'listTaskFiles',
    summary: 'List task files',
    description:
      'Lists the files and folders of a task’s workspace folder (or, with revision, of that published revision’s snapshot), sorted by path. path selects a folder ("" = the task root); recursive (default true) lists the whole subtree. Symlinks are listed, never followed. At most 5000 entries (truncated tells when more exist). Use readTaskFile for content.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: false, description: 'Folder relative to the task root ("" = root).', schema: { type: 'string', maxLength: 1024, default: '' } },
      { name: 'recursive', in: 'query', required: false, schema: { type: 'boolean', default: true } },
      { name: 'revision', in: 'query', required: false, description: 'Read a revision (number, latest or id) instead of the workspace.', schema: { type: 'string', maxLength: 36 } },
    ],
    responses: {
      200: {
        description: 'The entries',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['entries', 'truncated'],
              properties: {
                entries: {
                  type: 'array',
                  maxItems: 5000,
                  items: {
                    type: 'object',
                    required: ['path', 'type', 'size', 'mode'],
                    properties: {
                      path: { type: 'string', description: 'relative to the task root, /-separated' },
                      type: { type: 'string', enum: ['file', 'dir', 'symlink'] },
                      size: { type: 'integer' },
                      mode: { type: 'integer' },
                    },
                  },
                },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such task, revision or path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listTaskFilesQuery, taskParams } from '#shared/schemas/tasks'
import { listTaskFiles } from '../../../../services/tasks/files'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const query = validateQuery(event, listTaskFilesQuery)
  return listTaskFiles(await resolveTask(principal, task), query)
})
