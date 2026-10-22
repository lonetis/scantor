defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'startScan',
    summary: 'Start a scan',
    description:
      'Starts a scan of a ready task revision. revision is "<task>@<N>", "<task>@latest", "<task>" (= latest) or a revision id. taskConfig and scanConfig are validated against the revision\'s schemas with defaults filled (422 configInvalid lists every issue as a JSON pointer); omit fields to use their defaults. settings (workers, processes, timeoutMs, maxAttempts, backoff, resources per process, maxAnalysesPerProcess, nodeSelector) are merged over the revision\'s defaults. For template schedules the number of analyses is estimated first: above the instance threshold the request must repeat with confirm: true (422 confirmationRequired with details.expectedTotal), above the instance maximum it is refused (422 scanTooLarge). Returns the new scan in state creating; poll getScan (with wait) to follow it. Other errors: 404 unknown revision or upload, 409 revisionNotReady, 403 privilegedNotAllowed, 503 brokerAlarm.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/StartScan' } } },
    },
    responses: {
      201: { description: 'The new scan (creating)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } },
      400: { description: 'Invalid body or settings out of bounds', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Privileged revision without canRunPrivileged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Unknown revision or upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The revision is not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: {
        description: 'configInvalid, confirmationRequired or scanTooLarge',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      503: { description: 'RabbitMQ alarm (brokerAlarm) or the broker is unreachable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          StartScan: {
            type: 'object',
            required: ['revision'],
            additionalProperties: false,
            properties: {
              revision: { type: 'string', minLength: 1, maxLength: 200, description: '<task>@<N>, <task>@latest, <task> or a revision id' },
              name: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional label' },
              taskConfig: { type: 'object', additionalProperties: true, description: 'Task config; validated with defaults against the revision schema' },
              scanConfig: { type: 'object', additionalProperties: true, description: 'Scan config (for templates: the template\'s scan config)' },
              settings: {
                type: 'object',
                additionalProperties: false,
                description: 'Partial scan settings merged over the revision defaults',
                properties: {
                  workers: { type: 'integer', minimum: 1, description: 'Runner workers (≤ the instance limit)' },
                  processes: { type: 'integer', minimum: 1, description: 'Connector processes per worker (≤ the instance limit)' },
                  timeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
                  maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
                  backoff: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      initialMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
                      factor: { type: 'number', minimum: 1, maximum: 10 },
                      maxMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
                      jitter: { type: 'boolean' },
                    },
                  },
                  resources: {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Per connector process',
                    properties: { cpus: { type: 'number', minimum: 0.1, maximum: 64 }, memoryMiB: { type: 'integer', minimum: 64, maximum: 65536 } },
                  },
                  maxAnalysesPerProcess: { type: 'integer', minimum: 1, maximum: 1000000 },
                  nodeSelector: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      pool: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
                      labels: { type: 'object', additionalProperties: { type: 'string', maxLength: 63 } },
                    },
                  },
                },
              },
              confirm: { type: 'boolean', description: 'Required true when the estimate exceeds the confirmation threshold' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { startScanBody } from '#shared/schemas/scans'
import { scanRepresentation } from '../../services/scans/queries'
import { startScan } from '../../services/scans/start'
import { requireUser } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, startScanBody)
  const scan = await startScan(principal, body, useConfig())
  setResponseStatus(event, 201)
  return scanRepresentation(scan)
})
