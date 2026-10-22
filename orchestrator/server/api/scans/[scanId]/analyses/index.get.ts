defineRouteMeta({
  openAPI: {
    tags: ['analyses'],
    operationId: 'listAnalyses',
    summary: 'List the analyses of a scan',
    description:
      'Lists the analyses of a scan in seq order, optionally filtered by status (comma-separated). Resume with afterSeq: nextCursor is the decimal seq of the last item, pass it as afterSeq to get the next page. With fields (comma-separated dot paths such as id,seq,status,error.type,result.title) only those fields plus id and seq are returned, which keeps large results out of tables. Secret (writeOnly) values are "***". For filters on result values use queryAnalyses.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'Comma-separated statuses: pending, retrying, succeeded, failed, lost, cancelled',
        schema: { type: 'string', maxLength: 128 },
      },
      { name: 'afterSeq', in: 'query', required: false, description: 'Only analyses with a larger seq (-1 or more)', schema: { type: 'integer', maximum: 9007199254740991 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } },
      {
        name: 'fields',
        in: 'query',
        required: false,
        description: 'Comma-separated dot paths of the Analysis representation to return',
        schema: { type: 'string', maxLength: 4096 },
      },
    ],
    responses: {
      200: {
        description: 'A page of analyses (complete, or projected to fields)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: {
                items: { type: 'array', items: { type: 'object', additionalProperties: true } },
                nextCursor: { type: ['string', 'null'], description: 'The seq to pass as afterSeq for the next page' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listAnalysesQuery, scanResultsParams } from '#shared/schemas/analyses'
import { listAnalyses } from '../../../../services/analyses/list'
import { loadOwnedScan, requireUser } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanResultsParams)
  const query = validateQuery(event, listAnalysesQuery)
  const scan = await loadOwnedScan(principal, scanId)
  return listAnalyses(scan, query)
})
