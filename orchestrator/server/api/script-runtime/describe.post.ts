defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeDescribe',
    summary: 'Describe the config and result of a script',
    description:
      'Reports the JSON Schemas of the config model and the result model of the script code (each at most 256 KiB, null when the script has none). They are stored on the script for the pack the run was built from, so the run form and startScriptRun can validate configs while the folder holds that code. The last report wins.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['configSchema', 'resultSchema'],
            additionalProperties: false,
            properties: {
              configSchema: { type: ['object', 'null'], additionalProperties: true },
              resultSchema: { type: ['object', 'null'], additionalProperties: true },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Stored',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['packSha256', 'at'],
              properties: { packSha256: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
            },
          },
        },
      },
      400: { description: 'Invalid schemas', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'The script no longer exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { describeScript } from '../../services/script-runtime/describe'
import { scriptDescribeBody } from '../../services/script-runtime/schemas'
import { requireScriptRun } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const body = await validateBody(event, scriptDescribeBody)
  return describeScript(principal, body)
})
