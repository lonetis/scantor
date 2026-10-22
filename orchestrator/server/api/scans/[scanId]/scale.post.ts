defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'scaleScan',
    summary: 'Scale a scan',
    description:
      'Changes the number of runner workers and/or connector processes per worker of a creating, running or paused scan (at least one of workers, processes). More workers are placed on free nodes; fewer workers drain the least busy ones. Processes change live inside running workers. Values above the instance limits are 400 validationFailed; terminal scans are 409 invalidState.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              workers: { type: 'integer', minimum: 1, description: 'Runner workers' },
              processes: { type: 'integer', minimum: 1, description: 'Connector processes per worker' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The scan with its new settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      400: { description: 'Invalid body or above the instance limits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The scan is terminal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scaleScanBody, scanIdParams } from '#shared/schemas/scans'
import { scaleScan } from '../../../services/scans/lifecycle'
import { scanRepresentation } from '../../../services/scans/queries'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const body = await validateBody(event, scaleScanBody)
  const scan = await loadOwnedScan(principal, scanId)
  return scanRepresentation(await scaleScan(scan, body, useConfig()))
})
