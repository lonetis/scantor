defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'publishRevision',
    summary: 'Publish a revision',
    description:
      'Publishes the current workspace of a task as a new numbered revision. The call snapshots the workspace at once (later edits never reach this revision), then a build runs: static checks (manifest, Dockerfile policy), image build, describe (the JSON Schemas of the configs and the result), type check and push. The revision starts queued; with wait (seconds) the call returns when it is ready or failed, otherwise poll getRevision. A failed revision lists structured errors {phase, file, line, message}. When a queued, building or ready revision already has the same content, that revision is returned instead of building again. Start scans with "<task>@latest" once ready.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the revision to be ready or failed (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', maxLength: 500, description: 'a note on the revision' } } },
        },
      },
    },
    responses: {
      201: { description: 'The revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Revision' } } } },
      404: { description: 'No such task or workspace folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'No workspace helper slot became free', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { publishRevisionBody, taskParams, waitQuery } from '#shared/schemas/tasks'
import { reloadRevision } from '../../../../services/revisions'
import { isRevisionSettled, toApiRevision } from '../../../../services/revisions/mappers'
import { publishRevision } from '../../../../services/revisions/publish'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { useCollections } from '../../../../utils/mongo'
import { loadWithWait } from '../../../../utils/wait'
import { validateBody, validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const { wait } = validateQuery(event, waitQuery)
  const body = await validateBody(event, publishRevisionBody)
  const { revision } = await publishRevision(await resolveTask(principal, task), { message: body.message })
  const current = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => reloadRevision(revision),
    settled: isRevisionSettled,
    watch: { collection: useCollections().revisions as never, id: revision._id },
  })
  setResponseStatus(event, 201)
  return toApiRevision(current)
})
