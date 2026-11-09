defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeFileUrl',
    summary: 'Get a fresh URL of an analysis file for a script run',
    description:
      'Returns a new presigned GET of one stored file of an analysis of a scan of the run, for the internal S3 endpoint and valid one hour, with the FileRef fields. Used when a URL from the analysis stream expired before the script read the file.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    parameters: [
      {
        name: 'analysisId',
        in: 'path',
        required: true,
        description: '"<scanId>-<seq>"',
        schema: { type: 'string', pattern: '^[0-9a-fA-F-]{36}-[0-9]{1,16}$' },
      },
      { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: {
        description: 'The presigned GET',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url', 'expiresAt', 'name', 'size', 'sha256', 'contentType'],
              properties: {
                url: { type: 'string' },
                expiresAt: { type: 'string', format: 'date-time' },
                name: { type: 'string' },
                size: { type: 'integer' },
                sha256: { type: 'string' },
                contentType: { type: 'string' },
              },
            },
          },
        },
      },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: {
        description: 'No such analysis or stored file in a scan of the run',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { runFileUrl } from '../../../../../services/script-runtime/reads'
import { scriptRuntimeFileParams } from '../../../../../services/script-runtime/schemas'
import { loadRunAnalysis, requireScriptRun } from '../../../../../utils/authz'
import { validateParams } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { analysisId, fileId } = validateParams(event, scriptRuntimeFileParams)
  const { analysis } = await loadRunAnalysis(principal, analysisId)
  return runFileUrl(analysis, fileId.toLowerCase())
})
