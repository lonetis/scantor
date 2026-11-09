defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'downloadScriptWorkspace',
    summary: 'Download the script folder',
    description:
      'Downloads the deterministic pack (tar.gz) of the script folder .scripts/<name>/: the exact content a new run would snapshot and build (.git/ and .scantor/ excluded, .dockerignore applied). 404 when the folder does not exist.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      200: { description: 'The pack', content: { 'application/gzip': { schema: { type: 'string', contentMediaType: 'application/gzip' } } } },
      404: { description: 'No such script or folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptParams } from '#shared/schemas/scripts'
import { sendScriptWorkspaceArchive } from '../../../../services/scripts/files'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  return sendScriptWorkspaceArchive(event, await resolveScript(principal, script))
})
