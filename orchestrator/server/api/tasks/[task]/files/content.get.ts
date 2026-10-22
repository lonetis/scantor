defineRouteMeta({
  openAPI: {
    tags: ['task-files'],
    operationId: 'readTaskFile',
    summary: 'Read a task file',
    description:
      'Reads one file of a task\'s workspace folder (or, with revision, of that revision\'s snapshot). Content is UTF-8 text (encoding utf8) or base64 for binary files, cut at 1 MiB (truncated); sha256 covers the whole file. Symlinks and folders cannot be read (422 invalidPath).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: true, description: 'File path relative to the task root.', schema: { type: 'string', minLength: 1, maxLength: 1024 } },
      { name: 'revision', in: 'query', required: false, description: 'Read a revision (number, latest or id) instead of the workspace.', schema: { type: 'string', maxLength: 36 } },
    ],
    responses: {
      200: {
        description: 'The file',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['path', 'size', 'sha256', 'encoding', 'content', 'truncated'],
              properties: {
                path: { type: 'string' },
                size: { type: 'integer' },
                sha256: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                content: { type: 'string' },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such task, revision or file', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { readTaskFileQuery, taskParams } from '#shared/schemas/tasks'
import { readTaskFile } from '../../../../services/tasks/files'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const query = validateQuery(event, readTaskFileQuery)
  return readTaskFile(await resolveTask(principal, task), query)
})
