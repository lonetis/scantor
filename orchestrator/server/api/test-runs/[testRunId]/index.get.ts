defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'getTestRun',
    summary: 'Get a test run',
    description:
      'Returns a test run: state, errors (build, describe, config or schedule failures with phase, file and line), the describe output of the draft image, the summary and, unless analyses=false, every analysis with its config, result, error and log tail. With wait (seconds) the call returns when the test run is completed, failed or cancelled.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'testRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the test run to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
      { name: 'analyses', in: 'query', required: false, schema: { type: 'boolean', default: true } },
    ],
    responses: {
      200: { description: 'The test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/TestRun' } } } },
      404: { description: 'No such test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getTestRunQuery, testRunParams } from '#shared/schemas/tasks'
import { loadOwnedTestRun, reloadTestRun, testRunRepresentation } from '../../../services/test-runs'
import { isTestRunSettled } from '../../../services/test-runs/mappers'
import { requireUser } from '../../../utils/authz'
import { useCollections } from '../../../utils/mongo'
import { loadWithWait } from '../../../utils/wait'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { testRunId } = validateParams(event, testRunParams)
  const query = validateQuery(event, getTestRunQuery)
  const owned = await loadOwnedTestRun(principal, testRunId)
  const current = await loadWithWait(event, {
    waitSeconds: query.wait,
    userId: principal.user.id,
    load: () => reloadTestRun(owned),
    settled: isTestRunSettled,
    watch: { collection: useCollections().testRuns as never, id: owned._id },
  })
  return testRunRepresentation(current, query.analyses)
})
