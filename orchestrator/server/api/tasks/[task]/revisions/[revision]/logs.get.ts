defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'getRevisionBuildLog',
    summary: 'Read a revision build log',
    description:
      'Returns the build log of a revision: one line per task-pipeline event (line = event seq + 1) after afterLine, at most limit lines. Log lines carry stream (pipeline, build, stdout, stderr, check), level and text; error lines a BuildError; the last line is the result. complete is true once the build finished and every line was returned; poll with afterLine = nextLine until then.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'revision', in: 'path', required: true, description: 'Revision number, latest or revision id.', schema: { type: 'string', maxLength: 36 } },
      { name: 'afterLine', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 } },
    ],
    responses: {
      200: {
        description: 'Log lines',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['lines', 'nextLine', 'complete'],
              properties: {
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['line', 'at', 'phase', 'type'],
                    properties: {
                      line: { type: 'integer', minimum: 1 },
                      at: { type: 'string', format: 'date-time' },
                      phase: { type: 'string', enum: ['pack', 'static', 'build', 'describe', 'check', 'push', 'platform'] },
                      type: { type: 'string', enum: ['log', 'error', 'result'] },
                      stream: { type: 'string', enum: ['pipeline', 'build', 'stdout', 'stderr', 'check'] },
                      level: { type: 'string', enum: ['info', 'warning'] },
                      text: { type: 'string' },
                      error: { $ref: '#/components/schemas/BuildError' },
                      result: { type: 'object', additionalProperties: true },
                    },
                  },
                },
                nextLine: { type: 'integer', minimum: 0 },
                complete: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such task or revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { buildLogQuery, revisionParams } from '#shared/schemas/tasks'
import { readBuildLog } from '../../../../../services/revisions/build-log'
import { requireUser, resolveTask, resolveTaskRevision } from '../../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const params = validateParams(event, revisionParams)
  const query = validateQuery(event, buildLogQuery)
  const revision = await resolveTaskRevision(await resolveTask(principal, params.task), params.revision)
  return readBuildLog(revision, query.afterLine, query.limit)
})
