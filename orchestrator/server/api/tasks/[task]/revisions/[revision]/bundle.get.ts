defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'getRevisionBundle',
    summary: 'Get a revision bundle',
    description:
      'Returns the bundle of a revision (created with createRevisionBundle): state (queued, running, ready, failed), platform, archive size and SHA-256, the baked runtime version, the error when failed, the recipient commands and, when ready, download.url, a presigned link valid 10 minutes (created anew on every call). 404 when the revision has no bundle or it expired. With wait (seconds) the call returns once the bundle is ready or failed (header Scantor-Wait: settled|timeout).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'revision', in: 'path', required: true, description: 'Revision number, latest or revision id.', schema: { type: 'string', maxLength: 36 } },
      {
        name: 'wait',
        in: 'query',
        required: false,
        description: 'Seconds to wait for the bundle to be ready or failed (0–120).',
        schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
      },
    ],
    responses: {
      200: { description: 'The bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bundle' } } } },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such task, revision or bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getRevisionBundleQuery } from '#shared/schemas/bundles'
import { revisionParams } from '#shared/schemas/tasks'
import { isBundleSettled, toApiBundle } from '../../../../../services/bundles/mappers'
import { loadBundle, reloadBundle } from '../../../../../services/bundles/service'
import { requireUser, resolveTask, resolveTaskRevision } from '../../../../../utils/authz'
import { useCollections } from '../../../../../utils/mongo'
import { loadWithWait } from '../../../../../utils/wait'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const params = validateParams(event, revisionParams)
  const { wait } = validateQuery(event, getRevisionBundleQuery)
  const revision = await resolveTaskRevision(await resolveTask(principal, params.task), params.revision)
  const bundle = await loadBundle(revision)
  const current = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => reloadBundle(bundle),
    settled: isBundleSettled,
    watch: { collection: useCollections().bundles as never, id: bundle._id },
  })
  return toApiBundle(current)
})
