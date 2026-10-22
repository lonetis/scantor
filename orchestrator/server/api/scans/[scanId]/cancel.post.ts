defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'cancelScan',
    summary: 'Cancel a scan',
    description:
      'Cancels a creating, running or paused scan for good: in-flight analyses are aborted, queued and delayed ones are dropped and every worker stops. Results already produced are kept; analyses that never ran count as cancelled. A cancelled scan cannot be resumed; use restartScan to run it again or retryFailedAnalyses for its failed analyses. Cancelling a cancelled scan returns it unchanged.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    'x-destructive': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The cancelled scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The scan already finished', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scanIdParams } from '#shared/schemas/scans'
import { cancelScan } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const scan = await loadOwnedScan(principal, scanId)
  return scanRepresentation(await cancelScan(scan))
})
