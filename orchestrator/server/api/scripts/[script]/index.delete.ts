defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'deleteScript',
    summary: 'Delete a script',
    description:
      'Deletes a script with everything that belongs to it: the folder .scripts/<name>/, all its runs with their outputs, logs and source snapshots, and its images. Active runs are cancelled. The script disappears at once; a scriptDelete job (202, follow it with getJob) removes the data.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } }],
    responses: {
      202: {
        description: 'Deletion started',
        content: { 'application/json': { schema: { type: 'object', required: ['job'], properties: { job: { $ref: '#/components/schemas/JobRef' } } } } },
      },
      404: { description: 'No such script', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { scriptParams } from '#shared/schemas/scripts'
import type { DeleteScriptResult } from '#shared/types/scripts'
import { requestScriptDeletion } from '../../../services/scripts'
import { requireUser, resolveScript } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event): Promise<DeleteScriptResult> => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const job = await requestScriptDeletion(await resolveScript(principal, script))
  setResponseStatus(event, 202)
  return { job }
})
