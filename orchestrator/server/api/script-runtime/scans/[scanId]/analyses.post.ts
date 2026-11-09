defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeStreamAnalyses',
    summary: 'Stream the analyses of a scan to a script run',
    description:
      'Streams the analyses of one scan of the run as NDJSON in seq order after afterSeq (and up to untilSeq). Each line is one object: {"analysis": {...}, "urls": {"<fileId>": "<presigned GET>"}} per analysis (masked like every read; urls only for stored files when fileUrls is true, valid one hour, for the internal S3 endpoint), {"checkpoint": {"afterSeq": N}} after every seq window and after 10 seconds of silence (every match up to N was sent), then exactly one {"end": {"afterSeq": N, "count": n, "limited": bool}}. On a failure the last line is {"error": {"code", "message", "retryable"}} instead of end; resume a retryable one after the last seq received. fields absent sends id, seq, status, attempt, round, config, result, error and files; "all" sends the full representation; with fileUrls files is always sent. filter and fields follow the export rules. A sample run (settings.limit) ends after limit analyses with limited true. At most 4 streams and aggregations per run at once (429).',
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
            additionalProperties: false,
            properties: {
              status: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', enum: ['pending', 'retrying', 'succeeded', 'failed', 'lost', 'cancelled'] },
              },
              filter: { type: 'object', additionalProperties: true, description: 'A MongoDB filter with the query allowlist' },
              fields: {
                anyOf: [
                  { type: 'string', enum: ['all'] },
                  { type: 'array', minItems: 1, items: { type: 'string' } },
                ],
              },
              afterSeq: { type: 'integer', description: 'Start after this seq; absent or -1 starts at the beginning' },
              untilSeq: { type: 'integer', minimum: 0, description: 'End with this seq (greater than afterSeq)' },
              fileUrls: { type: 'boolean', default: true },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'NDJSON lines (see the description)', content: { 'application/x-ndjson': { schema: { type: 'string' } } } },
      400: { description: 'Invalid or rejected filter or fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
    },
  },
})

import { defineEventHandler } from 'h3'
import { planStream, sendAnalysisStream } from '../../../../services/script-runtime/stream'
import { scriptRuntimeScanParams, streamAnalysesBody } from '../../../../services/script-runtime/schemas'
import { loadRunScan, requireScriptRun } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireScriptRun(event)
  const { scanId } = validateParams(event, scriptRuntimeScanParams)
  const body = await validateBody(event, streamAnalysesBody)
  const scan = await loadRunScan(principal, scanId)
  const plan = planStream(scan, body, principal.scriptRun.limit)
  await sendAnalysisStream(event, principal, scan, plan, useConfig())
})
