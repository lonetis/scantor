defineRouteMeta({
  openAPI: {
    tags: ['exports'],
    operationId: 'exportScanInline',
    summary: 'Stream the analyses of a scan',
    description:
      'Streams the analyses of one scan in seq order as a download: format jsonl (application/x-ndjson, one masked analysis document per line, or only fields) or csv (text/csv; columns = fields, default id, seq, status, attempt, round, error.type, error.message, timings.durationMs, config, result; nested values JSON-encoded; cells that could be read as spreadsheet formulas are prefixed with an apostrophe). Narrow it with status (comma-separated), filter (URL-encoded JSON, queryAnalyses rules) and afterSeq (resume after the last seq you received). At most SCANTOR_EXPORT_INLINE_MAX analyses: above that 409 exportTooLarge, use exportScan for a background export.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['jsonl', 'csv'], default: 'jsonl' } },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'Comma-separated statuses: pending, retrying, succeeded, failed, lost, cancelled',
        schema: { type: 'string', maxLength: 128 },
      },
      {
        name: 'filter',
        in: 'query',
        required: false,
        description: 'URL-encoded JSON MongoDB filter (queryAnalyses rules)',
        schema: { type: 'string', maxLength: 65536 },
      },
      {
        name: 'fields',
        in: 'query',
        required: false,
        description: 'Comma-separated dot paths of the Analysis representation (JSONL: the fields of each line; CSV: the columns)',
        schema: { type: 'string', maxLength: 4096 },
      },
      { name: 'afterSeq', in: 'query', required: false, description: 'Only analyses with a larger seq (-1 or more)', schema: { type: 'integer', maximum: 9007199254740991 } },
    ],
    responses: {
      200: {
        description: 'The selected analyses in seq order',
        content: {
          'application/x-ndjson': { schema: { type: 'string', description: 'One JSON object per line' } },
          'text/csv': { schema: { type: 'string', description: 'A header row, then one row per analysis' } },
        },
      },
      400: { description: 'Invalid query or rejected filter', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'More analyses than an inline export allows', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent queries and exports', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      504: { description: 'Query timeout', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { exportInlineQuery, scanResultsParams } from '#shared/schemas/analyses'
import { streamInlineExport } from '../../../services/exports/inline'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanResultsParams)
  const query = validateQuery(event, exportInlineQuery)
  const scan = await loadOwnedScan(principal, scanId)
  await streamInlineExport(event, scan, query, principal.user.id, useConfig())
})
