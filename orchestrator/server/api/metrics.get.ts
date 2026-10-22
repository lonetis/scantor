defineRouteMeta({
  openAPI: {
    tags: ['metrics'],
    operationId: 'getMetrics',
    summary: 'Get Prometheus metrics',
    description:
      'Admin only. Returns the orchestrator metrics in the Prometheus text format 0.0.4: scans by state, per-scan queue depths, ingest throughput, lag, flush and batch histograms, dead letters, breaker trips, completed analyses, workers, nodes and their heartbeat age, RabbitMQ alarms, jobs, editors, workspace helpers, HTTP requests and registry garbage collection. Scrape it every 30 s with an admin API key (Authorization: Bearer sk_scantor_…).',
    'x-scantor-scope': 'admin',
    'x-mcp': false,
    'x-admin-only': true,
    responses: {
      200: {
        description: 'Prometheus text exposition',
        content: { 'text/plain': { schema: { type: 'string' } } },
      },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseHeader } from 'h3'
import { emptyQuery } from '#shared/schemas/common'
import { renderMetrics } from '../services/metrics/collect'
import { requireAdmin } from '../utils/authz'
import { validateQuery } from '../utils/zod'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  validateQuery(event, emptyQuery)
  setResponseHeader(event, 'Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  return renderMetrics()
})
