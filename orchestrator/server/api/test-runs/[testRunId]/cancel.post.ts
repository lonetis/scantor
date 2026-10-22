defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'cancelTestRun',
    summary: 'Cancel a test run',
    description:
      'Cancels a queued, building or running test run: its container is stopped and the analyses recorded so far are kept. Cancelling a cancelled test run returns it unchanged; a completed or failed one is 409 invalidState.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    'x-destructive': true,
    parameters: [{ name: 'testRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/TestRun' } } } },
      404: { description: 'No such test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Already finished', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { testRunParams } from '#shared/schemas/tasks'
import { cancelTestRun, loadOwnedTestRun } from '../../../services/test-runs'
import { toApiTestRun } from '../../../services/test-runs/mappers'
import { requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { testRunId } = validateParams(event, testRunParams)
  return toApiTestRun(await cancelTestRun(await loadOwnedTestRun(principal, testRunId)))
})
