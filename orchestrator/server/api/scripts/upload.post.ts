defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'uploadScript',
    summary: 'Upload a script folder',
    description:
      'Uploads a script folder as a tar.gz (body application/gzip, at most SCANTOR_TASK_MAX_PACK_BYTES; this is what `scantor scripts push` does). The name in scantor-script.yaml selects your script of that name or creates it; the manifest also sets its language and description. The folder .scripts/<name>/ is replaced atomically unless it has changes that exist only there (edits since the last upload, or the untouched scaffold): then 409 workspaceDirty, retry with force=true to replace them. Archives may contain only regular files and directories. 422 manifestInvalid lists the manifest errors; 422 invalidPath names a rejected path; 413 for size caps; 400 badRequest when the body sends nothing for 30 s; 429 tooManyRequests while too many workspace operations of yours run.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'force', in: 'query', required: false, description: 'Replace changes that exist only in the script folder.', schema: { type: 'boolean', default: false } },
    ],
    requestBody: {
      required: true,
      content: { 'application/gzip': { schema: { type: 'string', contentMediaType: 'application/gzip', description: 'tar.gz of the script folder' } } },
    },
    responses: {
      201: {
        description: 'The script',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['script', 'created'],
              properties: {
                script: { $ref: '#/components/schemas/Script' },
                created: { type: 'boolean', description: 'true when the upload created the script' },
              },
            },
          },
        },
      },
      400: { description: 'The upload stalled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The folder has changes that were never uploaded, or the script is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'Upload or workspace too large', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      415: { description: 'Not application/gzip', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid manifest or path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent workspace operations', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader, setResponseStatus } from 'h3'
import type { UploadScriptResult } from '#shared/types/scripts'
import { uploadScriptQuery } from '#shared/schemas/scripts'
import { toApiScript } from '../../services/scripts/mappers'
import { assertScriptUploadContentType, uploadScript } from '../../services/scripts/upload'
import { requireUser } from '../../utils/authz'
import { closeConnectionOnFailure } from '../../utils/byte-cap'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event): Promise<UploadScriptResult> => {
  const principal = requireUser(event)
  const query = validateQuery(event, uploadScriptQuery)
  assertScriptUploadContentType(getRequestHeader(event, 'content-type'))
  const limit = typeof event.context.bodyLimit === 'number' ? event.context.bodyLimit : Number.POSITIVE_INFINITY
  const outcome = await closeConnectionOnFailure(event.node.req, event.node.res, () =>
    uploadScript(principal, { body: event.node.req, maxBytes: limit, force: query.force }),
  )
  setResponseStatus(event, 201)
  return { script: toApiScript(outcome.script), created: outcome.created }
})
