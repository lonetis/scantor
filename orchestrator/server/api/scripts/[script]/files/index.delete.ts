defineRouteMeta({
  openAPI: {
    tags: ['script-files'],
    operationId: 'deleteScriptFile',
    summary: 'Delete a script file',
    description:
      'Deletes a file (or, with recursive=true, a folder) of a script folder (.scripts/<name>/ in your workspace). Deleting a symlink removes the link only. Returns the deleted paths and the new folder hash. The script root cannot be deleted this way; use deleteScript.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'path', in: 'query', required: true, description: 'Path relative to the script root.', schema: { type: 'string', minLength: 1, maxLength: 1024 } },
      { name: 'recursive', in: 'query', required: false, description: 'Allow deleting a non-empty folder.', schema: { type: 'boolean', default: false } },
    ],
    responses: {
      200: {
        description: 'Deleted',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['deleted', 'workspace'],
              properties: {
                deleted: { type: 'array', items: { type: 'string' } },
                workspace: { type: 'object', required: ['packSha256'], properties: { packSha256: { type: 'string' } } },
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
import { deleteScriptFileQuery, scriptParams } from '#shared/schemas/scripts'
import { deleteScriptFile } from '../../../../services/scripts/files'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const query = validateQuery(event, deleteScriptFileQuery)
  return deleteScriptFile(await resolveScript(principal, script), query)
})
