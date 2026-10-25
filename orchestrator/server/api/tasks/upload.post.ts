defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'uploadTask',
    summary: 'Upload a task folder',
    description:
      'Uploads a task folder as a tar.gz (body application/gzip, at most SCANTOR_TASK_MAX_PACK_BYTES; this is what `scantor push` does). The manifest name selects your task of that name or creates it. The workspace folder is replaced atomically unless it has changes that exist only there (edits since the last publish, upload, git import or pull): then 409 workspaceDirty, retry with force=true to replace them. Unless publish=false, a revision is published from the uploaded content (returned in revision; with wait the call returns when it is ready or failed). Archives may contain only regular files and directories. 422 manifestInvalid lists the manifest errors; 422 invalidPath names a rejected path; 413 for size caps; 400 badRequest when the body sends nothing for 30 s; 429 tooManyRequests while too many workspace operations of yours run.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'publish', in: 'query', required: false, description: 'Publish a revision after the upload.', schema: { type: 'boolean', default: true } },
      { name: 'force', in: 'query', required: false, description: 'Replace unpublished workspace changes.', schema: { type: 'boolean', default: false } },
      { name: 'message', in: 'query', required: false, description: 'Revision message.', schema: { type: 'string', maxLength: 500 } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the revision to be ready or failed (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    requestBody: {
      required: true,
      content: { 'application/gzip': { schema: { type: 'string', contentMediaType: 'application/gzip', description: 'tar.gz of the task folder' } } },
    },
    responses: {
      201: {
        description: 'The task and the published revision',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['task', 'revision', 'created'],
              properties: {
                task: { $ref: '#/components/schemas/Task' },
                revision: { anyOf: [{ $ref: '#/components/schemas/Revision' }, { type: 'null' }] },
                created: { type: 'boolean', description: 'true when the upload created the task' },
              },
            },
          },
        },
      },
      400: { description: 'The upload stalled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The workspace has unpublished changes', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'Upload or workspace too large', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      415: { description: 'Not application/gzip', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid manifest or path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent workspace operations', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader, setResponseStatus } from 'h3'
import { uploadTaskQuery } from '#shared/schemas/tasks'
import { reloadRevision } from '../../services/revisions'
import { isRevisionSettled, toApiRevision } from '../../services/revisions/mappers'
import { toApiTask } from '../../services/tasks/mappers'
import { loadTask } from '../../services/tasks/store'
import { assertTaskUploadContentType, uploadTask } from '../../services/tasks/upload'
import { requireUser } from '../../utils/authz'
import { closeConnectionOnFailure } from '../../utils/byte-cap'
import { useCollections } from '../../utils/mongo'
import { loadWithWait } from '../../utils/wait'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, uploadTaskQuery)
  assertTaskUploadContentType(getRequestHeader(event, 'content-type'))
  const limit = typeof event.context.bodyLimit === 'number' ? event.context.bodyLimit : Number.POSITIVE_INFINITY
  const outcome = await closeConnectionOnFailure(event.node.req, event.node.res, () =>
    uploadTask(principal, { body: event.node.req, maxBytes: limit, publish: query.publish, force: query.force, message: query.message }),
  )
  let revision = outcome.revision
  if (revision) {
    const published = revision
    revision = await loadWithWait(event, {
      waitSeconds: query.wait,
      userId: principal.user.id,
      load: () => reloadRevision(published),
      settled: isRevisionSettled,
      watch: { collection: useCollections().revisions as never, id: published._id },
    })
  }
  const task = (await loadTask(outcome.task._id)) ?? outcome.task
  setResponseStatus(event, 201)
  return { task: toApiTask(task), revision: revision ? toApiRevision(revision) : null, created: outcome.created }
})
