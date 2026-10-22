defineRouteMeta({
  openAPI: {
    tags: ['editor'],
    operationId: 'stopEditor',
    summary: 'Stop your editor',
    description:
      'Stops your browser editor: removes its container, deletes its editor API key and ends every editor session (open editor tabs show that the editor stopped). Files in your workspace stay. Succeeds also when the editor is already stopped.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      204: { description: 'Stopped' },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { useEditorRuntime } from '../../services/editor'
import { requireUser } from '../../utils/authz'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  await useEditorRuntime().manager.stop(principal.user.id, 'user')
  return sendNoContent(event)
})
