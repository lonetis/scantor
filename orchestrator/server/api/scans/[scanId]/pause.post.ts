defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'pauseScan',
    summary: 'Pause a scan',
    description:
      'Pauses a running scan: its workers drain (in-flight analyses finish within the drain grace, the rest returns to the queue) and stop; queued and delayed analyses stay in the queue. Results already produced are still recorded, and the scan cannot complete while paused. Resume with resumeScan. Pausing a paused scan returns it unchanged; other states are 409 invalidState.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The paused scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The scan is not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scanIdParams } from '#shared/schemas/scans'
import { pauseScan } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const scan = await loadOwnedScan(principal, scanId)
  return scanRepresentation(await pauseScan(scan))
})
