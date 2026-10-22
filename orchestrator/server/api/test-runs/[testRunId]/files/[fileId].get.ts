defineRouteMeta({
  openAPI: {
    tags: ['test-runs'],
    operationId: 'getTestRunFileDownload',
    summary: 'Download a test-run file',
    description:
      'Returns a presigned download (10 minutes) of a file an analysis of the test run attached (a FileRef id of its result). Images (png, jpeg, gif, webp) are served inline, everything else as an attachment. redirect=true answers 302 to the URL.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'testRunId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'redirect', in: 'query', required: false, schema: { type: 'boolean', default: false } },
    ],
    responses: {
      200: { description: 'The download', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileDownload' } } } },
      302: { description: 'Redirect to the presigned URL' },
      404: { description: 'No such test run or file', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendRedirect } from 'h3'
import { redirectQuery, testRunFileParams } from '#shared/schemas/tasks'
import { loadOwnedTestRun, testRunFileDownload } from '../../../../services/test-runs'
import { requireUser } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

const query = redirectQuery(false)

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { testRunId, fileId } = validateParams(event, testRunFileParams)
  const { redirect } = validateQuery(event, query)
  const download = await testRunFileDownload(await loadOwnedTestRun(principal, testRunId), fileId)
  if (redirect) return sendRedirect(event, download.url, 302)
  return download
})
