defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeAggregate',
    summary: 'Aggregate the analyses of a scan for a script run',
    description:
      'Runs a MongoDB aggregation pipeline over the analyses of one scan of the run, with the rules of aggregateAnalyses: the same allowed stages and rejected operators (400 queryRejected), no references to secret fields, the scan scope added in front, at most limit items (default and maximum SCANTOR_QUERY_MAX_DOCS) and SCANTOR_QUERY_MAX_TIME. Suited to counts and groupings on status and seq; evaluate large result sets with the analysis stream. At most 4 streams and aggregations per run at once (429).',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    'x-read-only': true,
    parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['pipeline'],
            additionalProperties: false,
            properties: {
              pipeline: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } },
              limit: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Aggregation output',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'truncated'],
              properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } }, truncated: { type: 'boolean' } },
            },
          },
        },
      },
      400: { description: 'Invalid or rejected pipeline', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'Not a scan of the run, or it was deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: {
        description: 'Too many open streams and aggregations of the run',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      504: { description: 'Query timeout', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { aggregateRunAnalyses } from '../../../../services/script-runtime/reads'
import { scriptRuntimeAggregateBody, scriptRuntimeScanParams } from '../../../../services/script-runtime/schemas'
import { loadRunScan, requireScriptRun } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { scanId } = validateParams(event, scriptRuntimeScanParams)
  const body = await validateBody(event, scriptRuntimeAggregateBody)
  const scan = await loadRunScan(principal, scanId)
  return aggregateRunAnalyses(principal, scan, body, useConfig())
})
