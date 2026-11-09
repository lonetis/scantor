defineRouteMeta({
  openAPI: {
    tags: ['script-files'],
    operationId: 'readScriptFile',
    summary: 'Read a script file',
    description:
      'Reads one file of a script folder (.scripts/<name>/ in your workspace). Content is UTF-8 text (encoding utf8) or base64 for binary files, cut at 1 MiB (truncated); sha256 covers the whole file. Symlinks and folders cannot be read (422 invalidPath).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: true, description: 'File path relative to the script root.', schema: { type: 'string', minLength: 1, maxLength: 1024 } },
    ],
    responses: {
      200: {
        description: 'The file',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['path', 'size', 'sha256', 'encoding', 'content', 'truncated'],
              properties: {
                path: { type: 'string' },
                size: { type: 'integer' },
                sha256: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                content: { type: 'string' },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such script or file', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { readScriptFileQuery, scriptParams } from '#shared/schemas/scripts'
import { readScriptFile } from '../../../../services/scripts/files'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const query = validateQuery(event, readScriptFileQuery)
  return readScriptFile(await resolveScript(principal, script), query)
})
