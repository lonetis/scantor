defineRouteMeta({
  openAPI: {
    tags: ['exports'],
    operationId: 'deleteExport',
    summary: 'Delete an export',
    description:
      'Deletes a background export and its file; an export that is still running is cancelled first. Download links handed out earlier stop working. Returns 204.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'exportId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      204: { description: 'Deleted' },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such export', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, sendNoContent } from 'h3'
import { exportIdParams } from '#shared/schemas/analyses'
import { deleteExport } from '../../services/exports/service'
import { loadOwned, requireUser } from '../../utils/authz'
import { useCollections } from '../../utils/mongo'
import { validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { exportId } = validateParams(event, exportIdParams)
  const doc = await loadOwned(useCollections().exports, exportId.toLowerCase(), principal, { what: 'export' })
  await deleteExport(doc)
  return sendNoContent(event)
})
