defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'streamTestRun',
    summary: 'Stream a test run',
    description:
      'Server-sent events of a test run until it settles: state {state}, log {seq|null, stream (stdout, stderr or build), text, at}, analysis (a TestRunAnalysis), error (a BuildError) and finally end (the TestRun without analyses). A subscriber first receives the current state, the stored analyses and errors and recent log lines. An open stream counts as one of your SCANTOR_MAX_CONCURRENT_WAITS waits (429 tooManyRequests beyond them); log lines a slow reader misses are dropped and counted in one marker line, and the stream ends when the orchestrator begins to stop.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'testRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
      404: { description: 'No such test run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits and streams', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { testRunParams } from '#shared/schemas/tasks'
import { loadOwnedTestRun } from '../../../services/test-runs'
import { streamTestRun } from '../../../services/test-runs/stream'
import { requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { testRunId } = validateParams(event, testRunParams)
  await streamTestRun(event, await loadOwnedTestRun(principal, testRunId), { userId: principal.user.id })
})
