defineRouteMeta({
  openAPI: {
    tags: ['script-runs'],
    operationId: 'getScriptRunOutputDownload',
    summary: 'Download an output of a script run',
    description:
      'Returns a presigned download (10 minutes) of a stored output file of the script run. Images (png, jpeg, gif, webp) are served inline, everything else as an attachment. redirect=true answers 302 to the URL. Pending uploads are not downloadable.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scriptRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'outputId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'redirect', in: 'query', required: false, schema: { type: 'boolean', default: false } },
    ],
    responses: {
      200: { description: 'The download', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileDownload' } } } },
      302: { description: 'Redirect to the presigned URL' },
      404: { description: 'No such script run or output', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendRedirect } from 'h3'
import { scriptRunDownloadQuery, scriptRunOutputParams } from '#shared/schemas/scripts'
import { scriptRunOutputDownload } from '../../../../../services/script-runs'
import { loadOwnedScriptRun, requireUser } from '../../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scriptRunId, outputId } = validateParams(event, scriptRunOutputParams)
  const { redirect } = validateQuery(event, scriptRunDownloadQuery)
  const download = await scriptRunOutputDownload(await loadOwnedScriptRun(principal, scriptRunId), outputId)
  if (redirect) return sendRedirect(event, download.url, 302)
  return download
})
