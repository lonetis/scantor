defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'listTestRuns',
    summary: 'List test runs',
    description:
      'Lists the test runs of a task, newest first, without their analyses (use getTestRun for those). Test runs are kept for SCANTOR_TEST_RUN_RETENTION_DAYS. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of test runs',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/TestRun' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listTestRunsQuery, taskParams } from '#shared/schemas/tasks'
import { listTestRuns } from '../../../../services/test-runs'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const query = validateQuery(event, listTestRunsQuery)
  return listTestRuns(await resolveTask(principal, task), query)
})
