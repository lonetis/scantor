defineRouteMeta({
  openAPI: {
    tags: ['script-files'],
    operationId: 'listScriptFiles',
    summary: 'List script files',
    description:
      'Lists the files and folders of a script folder (.scripts/<name>/ in your workspace), sorted by path. path selects a folder ("" = the script root); recursive (default true) lists the whole subtree. Symlinks are listed, never followed. At most 5000 entries (truncated tells when more exist). Use readScriptFile for content.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: false, description: 'Folder relative to the script root ("" = root).', schema: { type: 'string', maxLength: 1024, default: '' } },
      { name: 'recursive', in: 'query', required: false, schema: { type: 'boolean', default: true } },
    ],
    responses: {
      200: {
        description: 'The entries',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['entries', 'truncated'],
              properties: {
                entries: {
                  type: 'array',
                  maxItems: 5000,
                  items: {
                    type: 'object',
                    required: ['path', 'type', 'size', 'mode'],
                    properties: {
                      path: { type: 'string', description: 'relative to the script root, /-separated' },
                      type: { type: 'string', enum: ['file', 'dir', 'symlink'] },
                      size: { type: 'integer' },
                      mode: { type: 'integer' },
                    },
                  },
                },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such script or path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listScriptFilesQuery, scriptParams } from '#shared/schemas/scripts'
import { listScriptFiles } from '../../../../services/scripts/files'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const query = validateQuery(event, listScriptFilesQuery)
  return listScriptFiles(await resolveScript(principal, script), query)
})
