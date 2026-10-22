defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'getRevision',
    summary: 'Get a revision',
    description:
      'Returns one revision of a task by number, latest (the highest-numbered ready revision) or id: state, structured build errors, the normalised manifest, settings defaults, the image digest and the describe output with the JSON Schemas of the task config, scan config, analysis config and result (use them to build startScan configs). With wait (seconds) the call returns when the revision is ready or failed.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'revision', in: 'path', required: true, description: 'Revision number, latest or revision id.', schema: { type: 'string', maxLength: 36 } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the revision to be ready or failed (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    responses: {
      200: { description: 'The revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Revision' } } } },
      404: { description: 'No such task or revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { revisionParams, waitQuery } from '#shared/schemas/tasks'
import { reloadRevision } from '../../../../../services/revisions'
import { isRevisionSettled, toApiRevision } from '../../../../../services/revisions/mappers'
import { requireUser, resolveTask, resolveTaskRevision } from '../../../../../utils/authz'
import { useCollections } from '../../../../../utils/mongo'
import { loadWithWait } from '../../../../../utils/wait'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const params = validateParams(event, revisionParams)
  const { wait } = validateQuery(event, waitQuery)
  const revision = await resolveTaskRevision(await resolveTask(principal, params.task), params.revision)
  const current = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => reloadRevision(revision),
    settled: isRevisionSettled,
    watch: { collection: useCollections().revisions as never, id: revision._id },
  })
  return toApiRevision(current)
})
