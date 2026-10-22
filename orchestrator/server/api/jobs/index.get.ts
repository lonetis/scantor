defineRouteMeta({
  openAPI: {
    tags: ['jobs'],
    operationId: 'listJobs',
    summary: 'List background jobs',
    description:
      'Lists your background jobs (revision builds, test runs, scan deletions, retry-failed runs, exports, task deletions), newest first, with kind, subject, state (queued, running, succeeded, failed, cancelled), progress, attempts and the error of a failed job. Filter by kind and state; admins see every job (including user deletions) and may filter by userId. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      {
        name: 'kind',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['revisionBuild', 'testRun', 'scanDelete', 'scanRetryFailed', 'export', 'taskDelete', 'userPurge'] },
      },
      { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] } },
      { name: 'userId', in: 'query', required: false, description: 'Admins only: jobs of this user', schema: { type: 'string', format: 'uuid' } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of jobs',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Job' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'userId of another user without admin power', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Job: {
            type: 'object',
            description: 'A resumable background job (docs/data-model.md §4.12).',
            required: ['id', 'kind', 'subject', 'state', 'progress', 'attempts', 'error', 'createdAt', 'startedAt', 'finishedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: {
                type: 'string',
                enum: ['revisionBuild', 'testRun', 'scanDelete', 'scanRetryFailed', 'export', 'taskDelete', 'userPurge'],
              },
              subject: {
                type: 'object',
                required: ['kind', 'id'],
                properties: {
                  kind: { type: 'string', enum: ['revision', 'testRun', 'scan', 'export', 'task', 'user'] },
                  id: { type: 'string' },
                },
              },
              state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
              progress: {
                type: 'object',
                required: ['done', 'total'],
                properties: { done: { type: 'integer', minimum: 0 }, total: { type: ['integer', 'null'], minimum: 0 } },
              },
              attempts: { type: 'integer', minimum: 0 },
              error: {
                type: ['object', 'null'],
                required: ['code', 'message'],
                properties: { code: { type: 'string' }, message: { type: 'string' } },
              },
              createdAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import type { Filter } from 'mongodb'
import { listJobsQuery } from '#shared/schemas/analyses'
import { toApiJob } from '../../services/jobs/mappers'
import type { JobDoc } from '../../types/documents'
import { ownerFilter, requireUser } from '../../utils/authz'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, listJobsQuery)
  // Server-built clauses only, combined with $and (index {userId: 1, createdAt: -1} for users).
  const clauses: Filter<JobDoc>[] = [ownerFilter(principal, query.userId)]
  if (query.kind) clauses.push({ kind: query.kind })
  if (query.state) clauses.push({ state: query.state })
  return findPage(useCollections().jobs, { $and: clauses }, { limit: query.limit, cursor: query.cursor }, toApiJob)
})
