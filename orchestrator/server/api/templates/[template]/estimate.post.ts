defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'estimateTemplate',
    summary: 'Estimate a template scan',
    description:
      'Estimates how many analyses a template schedule produces for a scan config, without side effects (defaults are filled first). expectedTotal is null when unknown; exact tells whether it is exact; confirmationRequired = above SCANTOR_SCAN_CONFIRM_THRESHOLD (startScan then needs confirm: true); tooLarge = above SCANTOR_MAX_ANALYSES_PER_SCAN (startScan would refuse it). 422 configInvalid with details.issues when the template rejects the scan config.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    'x-read-only': true,
    parameters: [{ name: 'template', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z][a-z0-9]{0,31}$' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: false, properties: { scanConfig: { type: 'object', additionalProperties: true, default: {} } } },
        },
      },
    },
    responses: {
      200: {
        description: 'The estimate',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedTotal', 'exact', 'confirmationRequired', 'tooLarge'],
              properties: {
                expectedTotal: { type: ['integer', 'null'] },
                exact: { type: 'boolean' },
                confirmationRequired: { type: 'boolean' },
                tooLarge: { type: 'boolean' },
              },
            },
          },
        },
      },
      404: { description: 'No such template or upload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Scan config rejected', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { estimateTemplateBody, templateParams } from '#shared/schemas/tasks'
import { estimateTemplate } from '../../../services/catalog/estimate'
import { requireUser } from '../../../utils/authz'
import { validateBody, validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { template } = validateParams(event, templateParams)
  const body = await validateBody(event, estimateTemplateBody)
  return estimateTemplate(template, body.scanConfig, { userId: principal.user.id })
})
