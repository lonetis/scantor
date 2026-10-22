defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'getNodeAssignments',
    summary: 'Long-poll the desired worker set of a node',
    description:
      'Called by the node daemon. Returns the complete desired worker set of the calling node (one assignment per worker in states assigned … backoff, with image@digest, limits, capabilities and the worker environment) plus open on-demand log requests. Returns at once when the node\'s assignments revision is greater than rev, otherwise after wait seconds (0–60) with the current set. Every managed container not listed must be stopped and removed. Requires the instance lease (X-Scantor-Instance-Id), else 409 nodeInstanceConflict.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    parameters: [
      { name: 'rev', in: 'query', required: false, description: 'the revision the daemon last applied', schema: { type: 'integer' } },
      { name: 'wait', in: 'query', required: false, description: 'seconds to wait for a newer revision', schema: { type: 'integer', minimum: 0, maximum: 60, default: 0 } },
      { name: 'X-Scantor-Instance-Id', in: 'header', required: true, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'The complete desired set',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'rev', 'workers', 'logRequests'],
              properties: {
                serverTime: { type: 'integer' },
                rev: { type: 'integer' },
                workers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['workerId', 'scanId', 'userId', 'role', 'specHash', 'image', 'baseImage', 'processes', 'resources', 'privileged', 'dindMode', 'capAdd', 'env'],
                    properties: {
                      workerId: { type: 'string', format: 'uuid' },
                      scanId: { type: 'string', format: 'uuid' },
                      userId: { type: 'string', format: 'uuid' },
                      role: { type: 'string', enum: ['scheduler', 'runner'] },
                      specHash: { type: 'string' },
                      image: { type: 'string', description: '<registry host>/tasks/<taskId>@sha256:<digest>' },
                      baseImage: { type: ['string', 'null'] },
                      processes: { type: 'integer', minimum: 1 },
                      resources: {
                        type: 'object',
                        required: ['nanoCpus', 'memoryBytes'],
                        properties: { nanoCpus: { type: 'integer' }, memoryBytes: { type: 'integer' } },
                      },
                      privileged: { type: 'boolean' },
                      dindMode: { type: ['string', 'null'], enum: ['sysbox', 'privileged', null] },
                      capAdd: { type: 'array', items: { type: 'string', enum: ['NET_BIND_SERVICE', 'NET_RAW'] } },
                      env: {
                        type: 'object',
                        required: ['SCANTOR_URL', 'SCANTOR_WORKER_TOKEN'],
                        properties: { SCANTOR_URL: { type: 'string' }, SCANTOR_WORKER_TOKEN: { type: 'string' } },
                      },
                    },
                  },
                },
                logRequests: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['requestId', 'workerId', 'tailBytes'],
                    properties: { requestId: { type: 'string', format: 'uuid' }, workerId: { type: 'string', format: 'uuid' }, tailBytes: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Unknown or revoked node token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'nodeInstanceConflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      426: { description: 'incompatibleVersion', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader } from 'h3'
import { nodeAssignmentsQuery } from '#shared/schemas/nodes'
import { buildNodeAssignments, waitForAssignments } from '../../services/nodes/assignments'
import { INSTANCE_ID_HEADER, requireLeaseHolder } from '../../services/nodes/hello'
import { checkLeaseHolder } from '../../services/nodes/lease'
import { requireNode } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireNode(event)
  const query = validateQuery(event, nodeAssignmentsQuery)
  const config = useConfig()
  const instanceId = getRequestHeader(event, INSTANCE_ID_HEADER)
  const node = await requireLeaseHolder(principal, instanceId, config.nodeOfflineAfterMs)
  const rev = query.rev ?? -1
  const waitMs = (query.wait ?? 0) * 1000
  let current = node
  if (node.assignmentsRev <= rev && waitMs > 0) {
    const abort = new AbortController()
    event.node.res.once('close', () => abort.abort())
    const waited = await waitForAssignments(node._id, { rev, waitMs, signal: abort.signal })
    // Revoked, rotated or deleted while the request waited.
    if (!waited || waited.state === 'revoked' || waited.tokenHash !== node.tokenHash) throw apiError('unauthorized', 'unknown or revoked node token')
    const lease = checkLeaseHolder(waited.instance, instanceId, new Date(), config.nodeOfflineAfterMs)
    if (!lease.ok) throw apiError('nodeInstanceConflict', 'another daemon instance holds the lease of this node', { retryAfterMs: lease.retryAfterMs })
    current = waited
  }
  return buildNodeAssignments(current, config)
})
