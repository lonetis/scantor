defineRouteMeta({
  openAPI: {
    tags: ['exports'],
    operationId: 'exportScan',
    summary: 'Export the analyses of a scan',
    description:
      'Starts a background export of the analyses of one scan to a downloadable file: format jsonl (one masked analysis document per line, or only the given fields) or csv (columns = fields, default id, seq, status, attempt, round, error.type, error.message, timings.durationMs, config, result; nested values JSON-encoded). Narrow it with filter (the same MongoDB filter rules as queryAnalyses, for example {"status": "succeeded"}) and afterSeq. Returns 201 with the export in state queued; it becomes running, then ready (download.url is a presigned link valid 10 minutes; call getExport for a fresh one) or failed. With wait (seconds) the call returns once the export is ready or failed (header Scantor-Wait: settled|timeout). Exports expire after the retention period.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        name: 'wait',
        in: 'query',
        required: false,
        description: 'Seconds to wait for the export to be ready or failed (0–120).',
        schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['format'],
            additionalProperties: false,
            properties: {
              format: { type: 'string', enum: ['jsonl', 'csv'] },
              filter: { type: 'object', additionalProperties: true, description: 'MongoDB filter over the scan\'s analyses (queryAnalyses rules); omit for all' },
              fields: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'string', maxLength: 256 },
                description: 'Dot paths of the Analysis representation to include, for example ["seq", "status", "result.title"]',
              },
              afterSeq: { type: 'integer', maximum: 9007199254740991, description: 'Only analyses with a larger seq (-1 or more)' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The export', content: { 'application/json': { schema: { $ref: '#/components/schemas/Export' } } } },
      400: { description: 'Invalid or rejected filter', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The scan is being deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { exportScanBody, exportScanQuery, scanResultsParams } from '#shared/schemas/analyses'
import { createExport, exportSettled, loadExportForWait, toApiExport } from '../../../services/exports/service'
import { loadOwnedScan, requireUser } from '../../../utils/authz'
import { useConfig } from '../../../utils/config'
import { useCollections } from '../../../utils/mongo'
import { loadWithWait } from '../../../utils/wait'
import { validateBody, validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { scanId } = validateParams(event, scanResultsParams)
  const { wait } = validateQuery(event, exportScanQuery)
  const body = await validateBody(event, exportScanBody)
  const scan = await loadOwnedScan(principal, scanId)
  const created = await createExport(scan, body, useConfig())
  const doc = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load: () => loadExportForWait(created),
    settled: exportSettled,
    watch: { collection: useCollections().exports as never, id: created._id },
  })
  setResponseStatus(event, 201)
  return toApiExport(doc)
})
