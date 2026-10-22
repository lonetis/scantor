defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'downloadRevisionSource',
    summary: 'Download a revision\'s source',
    description:
      'Downloads the stored source snapshot (deterministic tar.gz) of a revision: with redirect=true (default) a 302 to a presigned URL valid for 10 minutes, otherwise {url, expiresAt}.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'revision', in: 'path', required: true, description: 'Revision number, latest or revision id.', schema: { type: 'string', maxLength: 36 } },
      { name: 'redirect', in: 'query', required: false, schema: { type: 'boolean', default: true } },
    ],
    responses: {
      200: {
        description: 'The download location',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['url', 'expiresAt'], properties: { url: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } },
          },
        },
      },
      302: { description: 'Redirect to the presigned URL' },
      404: { description: 'No such task or revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendRedirect } from 'h3'
import { redirectQuery, revisionParams } from '#shared/schemas/tasks'
import { revisionSourceDownload } from '../../../../../services/revisions'
import { requireUser, resolveTask, resolveTaskRevision } from '../../../../../utils/authz'
import { isoDate } from '../../../../../utils/serialize'
import { validateParams, validateQuery } from '../../../../../utils/zod'

const query = redirectQuery(true)

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const params = validateParams(event, revisionParams)
  const { redirect } = validateQuery(event, query)
  const revision = await resolveTaskRevision(await resolveTask(principal, params.task), params.revision)
  const download = await revisionSourceDownload(revision)
  if (redirect) return sendRedirect(event, download.url, 302)
  return { url: download.url, expiresAt: isoDate(download.expiresAt) }
})
