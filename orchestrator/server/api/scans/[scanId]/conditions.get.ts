defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'listScanConditions',
    summary: 'List scan conditions',
    description:
      'Lists the active conditions of a scan, most severe first: typed explanations of why it is not progressing, for example workersPending (with the placement reasons), crashLoop (exit code, OOM, log tail), imagePullFailed, workerErrors, schedulerRestarting, schedulingFailed, topologyFailed, brokerAlarm, breakerTripped, stalled or clockSkew. An empty list means the scan is healthy. The same conditions are part of getScan.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: {
        description: 'The active conditions',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Condition' } } },
            },
          },
        },
      },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { emptyQuery } from '#shared/schemas/common'
import { scanIdParams } from '#shared/schemas/scans'
import { scanConditions } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  validateQuery(event, emptyQuery)
  return scanConditions(await loadOwnedScan(principal, scanId))
})
