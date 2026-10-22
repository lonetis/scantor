defineRouteMeta({
  openAPI: {
    tags: ['task-files'],
    operationId: 'writeTaskFiles',
    summary: 'Write task files',
    description:
      'Creates or overwrites up to 200 files in a task\'s workspace folder in one call: files maps a relative path to UTF-8 text or {base64}. Parent folders are created. Paths must be relative, /-separated, without .. or backslashes (422 invalidPath). Returns the written paths and the new workspace hash; dirty tells whether the workspace now differs from the latest revision. Run testTask to try the change and publishRevision to publish it. 413 when the task or workspace caps are exceeded.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['files'],
            properties: {
              files: {
                type: 'object',
                minProperties: 1,
                maxProperties: 200,
                description: 'path → UTF-8 text, or {"base64": "<data>"} for binary content',
                additionalProperties: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'object', additionalProperties: false, required: ['base64'], properties: { base64: { type: 'string', contentEncoding: 'base64' } } },
                  ],
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Written',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['written', 'workspace'],
              properties: {
                written: { type: 'array', items: { type: 'string' } },
                workspace: { type: 'object', required: ['packSha256', 'dirty'], properties: { packSha256: { type: 'string' }, dirty: { type: 'boolean' } } },
              },
            },
          },
        },
      },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'Caps exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { taskParams, writeTaskFilesBody } from '#shared/schemas/tasks'
import { writeTaskFiles } from '../../../../services/tasks/files'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const body = await validateBody(event, writeTaskFilesBody)
  return writeTaskFiles(await resolveTask(principal, task), body.files)
})
