defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'retryFailedAnalyses',
    summary: 'Retry failed analyses',
    description:
      'Re-runs every failed or lost analysis that has a stored config in a new round (round + 1), as a background job; cancelled analyses and analyses that never ran are not retried (restart the scan for those). Allowed once scheduling has finished (scheduling.state done or failed) for running, completed, failed and cancelled scans, and only when no retry is already running. The scan becomes running again and completes when the retried analyses are final. Returns 202 with the scan and the job (follow it with getJob). Errors: 409 nothingToRetry, invalidState, revisionUnavailable; 403 privilegedNotAllowed.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      202: {
        description: 'Retry accepted',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['scan', 'job'],
              properties: { scan: { $ref: '#/components/schemas/Scan' }, job: { $ref: '#/components/schemas/JobRef' } },
            },
          },
        },
      },
      403: { description: 'Privileged revision without canRunPrivileged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'nothingToRetry, invalidState or revisionUnavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { scanIdParams } from '#shared/schemas/scans'
import { toJobRef } from '../../../services/jobs/mappers'
import { retryFailedAnalyses } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const scan = await loadOwnedScan(principal, scanId)
  const result = await retryFailedAnalyses(scan)
  setResponseStatus(event, 202)
  return { scan: await scanRepresentation(result.scan), job: toJobRef(result.job) }
})
