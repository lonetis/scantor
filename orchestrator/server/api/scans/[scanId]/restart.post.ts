defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'restartScan',
    summary: 'Restart a scan as a new scan',
    description:
      'Creates a new scan (a clone) of the same revision with the same effective configs (including secrets, copied server-side) and settings, optionally with a new name and different workers/processes. Template inputs such as "latest" lists resolve again. The original scan is untouched and records the restart; the clone has clonedFrom set. Allowed in every state except deleting and deleted. Errors: 409 revisionUnavailable (the revision was deleted), 403 privilegedNotAllowed, 422 scanTooLarge, 503 brokerAlarm.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              settings: {
                type: 'object',
                additionalProperties: false,
                properties: { workers: { type: 'integer', minimum: 1 }, processes: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The new scan (creating)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      400: { description: 'Invalid body or above the instance limits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Privileged revision without canRunPrivileged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan or a referenced upload is gone', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'revisionUnavailable or invalidState', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'scanTooLarge', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'RabbitMQ alarm', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { restartScanBody, scanIdParams } from '#shared/schemas/scans'
import { scanRepresentation } from '../../../services/scans/queries'
import { restartScan } from '../../../services/scans/start'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanIdParams)
  const body = await validateBody(event, restartScanBody)
  const original = await loadOwnedScan(principal, scanId)
  const clone = await restartScan(original, body, useConfig())
  setResponseStatus(event, 201)
  return scanRepresentation(clone)
})
