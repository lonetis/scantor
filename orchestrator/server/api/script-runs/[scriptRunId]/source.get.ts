defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'getScriptRunSourceDownload',
    summary: 'Download the source of a script run',
    description:
      'Downloads the snapshot of the script folder the run built (deterministic tar.gz; its uncompressed hash is source.packSha256): with redirect=true a 302 to a presigned URL valid for 10 minutes, otherwise {url, expiresAt}.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'redirect', in: 'query', required: false, schema: { type: 'boolean', default: false } },
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
      404: { description: 'No such script run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendRedirect } from 'h3'
import { scriptRunDownloadQuery, scriptRunParams } from '#shared/schemas/scripts'
import { scriptRunSourceDownload } from '../../../services/script-runs'
import { loadOwnedScriptRun, requireUser } from '../../../utils/authz'
import { isoDate } from '../../../utils/serialize'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId } = validateParams(event, scriptRunParams)
  const { redirect } = validateQuery(event, scriptRunDownloadQuery)
  const download = await scriptRunSourceDownload(await loadOwnedScriptRun(principal, scriptRunId))
  if (redirect) return sendRedirect(event, download.url, 302)
  return { url: download.url, expiresAt: isoDate(download.expiresAt) }
})
