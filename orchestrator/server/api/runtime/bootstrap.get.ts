defineRouteMeta({
  openAPI: {
    tags: ['runtime'],
    operationId: 'runtimeBootstrap',
    summary: 'Bootstrap a worker runtime',
    description:
      'Called by the runtime inside a worker container with its worker token. Returns everything the worker needs for its node\'s endpoint profile: identity and epoch, the effective task config (and scan config for the scheduler) with writeOnly secrets in clear text, the revision entry, per-scan AMQP credentials and queue names, upload and size limits, intervals, and for the scheduler its restart count, checkpoint, stored template resolutions, presigned upload GETs and data-source URLs. action is stop when the scan no longer runs (the runtime exits 0). The first bootstrap moves the worker to running and pending scheduling to running.',
    'x-scantor-scope': 'worker',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The bootstrap document (only serverTime, action and worker when action is stop)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'action'],
              properties: {
                serverTime: { type: 'integer' },
                action: { type: 'string', enum: ['run', 'stop'] },
                worker: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    role: { type: 'string', enum: ['scheduler', 'runner'] },
                    scanId: { type: 'string', format: 'uuid' },
                    nodeId: { type: 'string', format: 'uuid' },
                    epoch: { type: 'integer' },
                  },
                },
                scan: { type: 'object', additionalProperties: true },
                revision: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    number: { type: 'integer' },
                    entry: { type: 'string' },
                    protocolVersion: { type: 'integer' },
                    schedule: { type: 'object', properties: { kind: { type: 'string', enum: ['template', 'custom'] }, template: { type: 'string' } } },
                  },
                },
                amqp: { type: 'object', additionalProperties: true },
                uploads: { type: 'object', additionalProperties: true },
                limits: { type: 'object', additionalProperties: true },
                intervals: { type: 'object', additionalProperties: true },
                scheduler: { type: ['object', 'null'], additionalProperties: true },
              },
            },
          },
        },
      },
      401: { description: 'Invalid worker token or inactive worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      426: { description: 'incompatibleVersion', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader } from 'h3'
import { handleBootstrap } from '../../services/runtime/bootstrap'
import { requireWorker } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'

const log = useLogger('runtime')

export default defineEventHandler((event) => {
  const principal = requireWorker(event)
  const version = getRequestHeader(event, 'x-scantor-version')?.slice(0, 64) ?? null
  return handleBootstrap(principal, version, useConfig(), log)
})
