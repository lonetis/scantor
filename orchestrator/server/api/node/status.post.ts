defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'postNodeStatus',
    summary: 'Report node status',
    description:
      'Called by the node daemon every status interval and after local changes. The body is a complete snapshot of the node\'s workers (every worker of its desired set plus every managed worker container that still exists; removed workers are repeated three times) and its capacity, clock offset and free disk. Updates worker states, applied limits and container details, raises crashLoop and imagePullFailed, and keeps the node online. Entries for workers not assigned to this node are ignored. A rev greater than appliedRev tells the daemon to poll assignments now. Requires the instance lease, else 409 nodeInstanceConflict.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    parameters: [{ name: 'X-Scantor-Instance-Id', in: 'header', required: false, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['instanceId', 'appliedRev', 'clockOffsetMs', 'info', 'workers'],
            properties: {
              instanceId: { type: 'string' },
              appliedRev: { type: 'integer' },
              clockOffsetMs: { type: 'integer' },
              info: {
                type: 'object',
                additionalProperties: false,
                required: ['version', 'cpus', 'memoryBytes', 'diskFreeBytes', 'dindMode', 'maxWorkers', 'egressDenyApplied'],
                properties: {
                  version: { type: 'string' },
                  cpus: { type: 'integer' },
                  memoryBytes: { type: 'integer' },
                  diskFreeBytes: { type: 'integer' },
                  dindMode: { type: 'string', enum: ['disabled', 'sysbox', 'privileged'] },
                  maxWorkers: { type: 'integer' },
                  egressDenyApplied: { type: 'boolean' },
                },
              },
              workers: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['workerId', 'state'],
                  properties: {
                    workerId: { type: 'string' },
                    state: { type: 'string', enum: ['pulling', 'starting', 'running', 'backoff', 'stopping', 'removed', 'error'] },
                    containerId: { type: 'string' },
                    startedAt: { type: 'string', format: 'date-time' },
                    restarts: { type: 'integer', minimum: 0 },
                    applied: {
                      type: 'object',
                      properties: { processes: { type: 'integer' }, nanoCpus: { type: 'integer' }, memoryBytes: { type: 'integer' } },
                    },
                    lastExit: {
                      type: 'object',
                      properties: {
                        exitCode: { type: 'integer' },
                        oomKilled: { type: 'boolean' },
                        at: { type: 'string', format: 'date-time' },
                        logTail: { type: 'string', description: 'at most 4 KiB' },
                      },
                    },
                    nextRestartAt: { type: 'string', format: 'date-time' },
                    pull: { type: 'object', properties: { image: { type: 'string' }, startedAt: { type: 'string', format: 'date-time' } } },
                    error: {
                      type: 'object',
                      properties: { code: { type: 'string', enum: ['imagePullFailed', 'createFailed', 'platformMismatch'] }, message: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Accepted',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'rev', 'nextStatusMs'],
              properties: { serverTime: { type: 'integer' }, rev: { type: 'integer' }, nextStatusMs: { type: 'integer' } },
            },
          },
        },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Unknown or revoked node token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'nodeInstanceConflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'Body above 2 MiB', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      426: { description: 'incompatibleVersion', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader } from 'h3'
import { nodeStatusBody } from '#shared/schemas/nodes'
import { INSTANCE_ID_HEADER, requireLeaseHolder } from '../../services/nodes/hello'
import { handleStatus } from '../../services/nodes/status'
import { requireNode } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'
import { validateBody } from '../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireNode(event)
  const body = await validateBody(event, nodeStatusBody)
  const config = useConfig()
  const instanceId = getRequestHeader(event, INSTANCE_ID_HEADER) ?? body.instanceId
  const node = await requireLeaseHolder(principal, instanceId, config.nodeOfflineAfterMs)
  return handleStatus(node, { ...body, instanceId }, { nodeStatusIntervalMs: config.nodeStatusIntervalMs, nodeOfflineAfterMs: config.nodeOfflineAfterMs }, log)
})
