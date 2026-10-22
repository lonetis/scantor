defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'getScan',
    summary: 'Get a scan',
    description:
      'Returns one scan: state and its reason, effective configs (secrets "***"), settings, scheduling (confirmed analyses, template resolutions, error), exact or live statistics, progress with ETA, worker counts and active conditions explaining why it is not progressing. With wait (seconds) the call returns as soon as the scan is no longer creating or running (header Scantor-Wait: settled|timeout). Deleted scans are returned as tombstones with state deleted until purged.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'wait', in: 'query', required: false, description: 'Seconds to wait for the scan to settle (0–120).', schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 } },
    ],
    responses: {
      200: { description: 'The scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { getScanQuery, scanIdParams } from '#shared/schemas/scans'
import { scanRepresentation, scanSettled } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { useCollections } from '../../../utils/mongo'
import { loadWithWait } from '../../../utils/wait'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const { wait } = validateQuery(event, getScanQuery)
  const owned = await loadOwnedScan(principal, scanId)
  const scan = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: async () => (await useCollections().scans.findOne({ _id: owned._id })) ?? owned,
    settled: scanSettled,
    watch: { collection: useCollections().scans as never, id: owned._id },
  })
  return scanRepresentation(scan)
})
