defineRouteMeta({
  openAPI: {
    tags: ['exports'],
    operationId: 'getExport',
    summary: 'Get an export',
    description:
      'Returns one background export: state (queued, running, ready, failed), row and byte counts, the error when failed and, when ready, download.url, a presigned link valid 10 minutes (created anew on every call). With wait (seconds) the call returns once the export is ready or failed (header Scantor-Wait: settled|timeout).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'exportId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        name: 'wait',
        in: 'query',
        required: false,
        description: 'Seconds to wait for the export to be ready or failed (0–120).',
        schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
      },
    ],
    responses: {
      200: { description: 'The export', content: { 'application/json': { schema: { $ref: '#/components/schemas/Export' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such export', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { exportIdParams, getExportQuery } from '#shared/schemas/analyses'
import { exportSettled, loadExportForWait, toApiExport } from '../../services/exports/service'
import { loadOwned, requireUser } from '../../utils/authz'
import { useCollections } from '../../utils/mongo'
import { loadWithWait } from '../../utils/wait'
import { validateParams, validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { exportId } = validateParams(event, exportIdParams)
  const { wait } = validateQuery(event, getExportQuery)
  const owned = await loadOwned(useCollections().exports, exportId.toLowerCase(), principal, { what: 'export' })
  const doc = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => loadExportForWait(owned),
    settled: exportSettled,
    watch: { collection: useCollections().exports as never, id: owned._id },
  })
  return toApiExport(doc)
})
