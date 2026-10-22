defineRouteMeta({
  openAPI: {
    tags: ['exports'],
    operationId: 'listExports',
    summary: 'List exports',
    description:
      'Lists your background exports, newest first, optionally of one scan (scanId). Each export shows its format, filter, fields, state (queued, running, ready, failed), row and byte counts and expiry; ready exports carry a presigned download link valid 10 minutes. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'scanId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of exports',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Export' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Export: {
            type: 'object',
            description: 'A background export of the analyses of one scan (docs/data-model.md §4.14).',
            required: ['id', 'userId', 'scanId', 'format', 'filter', 'fields', 'afterSeq', 'state', 'bytes', 'rows', 'error', 'jobId', 'createdAt', 'finishedAt', 'updatedAt', 'expiresAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string' },
              scanId: { type: 'string', format: 'uuid' },
              format: { type: 'string', enum: ['jsonl', 'csv'] },
              filter: { type: 'object', additionalProperties: true },
              fields: { type: ['array', 'null'], items: { type: 'string' } },
              afterSeq: { type: ['integer', 'null'] },
              state: { type: 'string', enum: ['queued', 'running', 'ready', 'failed'] },
              bytes: { type: 'integer', minimum: 0 },
              rows: { type: 'integer', minimum: 0 },
              error: {
                type: ['object', 'null'],
                required: ['code', 'message'],
                properties: { code: { type: 'string' }, message: { type: 'string' } },
              },
              jobId: { type: 'string' },
              download: {
                type: 'object',
                description: 'Present when ready: a presigned GET (attachment) valid 10 minutes.',
                required: ['url', 'expiresAt'],
                properties: { url: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } },
              },
              createdAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listExportsQuery } from '#shared/schemas/analyses'
import { listExports } from '../../services/exports/service'
import { ownerFilter, requireUser } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, listExportsQuery)
  return listExports(ownerFilter(principal), query.scanId, { limit: query.limit, cursor: query.cursor })
})
