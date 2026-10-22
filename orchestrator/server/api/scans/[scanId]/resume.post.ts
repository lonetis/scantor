defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'resumeScan',
    summary: 'Resume a paused scan',
    description:
      'Resumes a paused scan (paused by you or by the failure-rate circuit breaker, whose breakerTripped condition is cleared): new workers are placed, and a scheduler continues from its checkpoint if scheduling had not finished. Resuming a running scan returns it unchanged. Errors: 409 invalidState (not paused), 409 revisionUnavailable (the revision was deleted), 403 privilegedNotAllowed.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The running scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      403: { description: 'Privileged revision without canRunPrivileged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'invalidState or revisionUnavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scanIdParams } from '#shared/schemas/scans'
import { resumeScan } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const scan = await loadOwnedScan(principal, scanId)
  return scanRepresentation(await resumeScan(scan))
})
