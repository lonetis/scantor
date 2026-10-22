defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'deleteScan',
    summary: 'Delete a scan',
    description:
      'Deletes a completed, failed or cancelled scan with all its analyses, files, exports, workers and events, as a background job; the scan turns deleting and then deleted (a tombstone that is purged after the retention period). This cannot be undone. Cancel a running scan first (409 invalidState otherwise). Returns 202 with the scan and the job; deleting a scan that is already being deleted returns the same job.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      202: {
        description: 'Deletion accepted',
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
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The scan is not terminal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { scanIdParams } from '#shared/schemas/scans'
import { toJobRef } from '../../../services/jobs/mappers'
import { deleteScan } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const scan = await loadOwnedScan(principal, scanId)
  const result = await deleteScan(scan)
  setResponseStatus(event, 202)
  return { scan: await scanRepresentation(result.scan), job: toJobRef(result.job) }
})
