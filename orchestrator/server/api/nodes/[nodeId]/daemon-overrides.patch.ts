defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'updateNodeDaemonOverrides',
    summary: 'Change the daemon overrides of a node',
    description:
      'Admin only. Changes values of the daemon configuration of the running node daemon until that daemon stops: the body is a JSON merge patch of the daemon overrides (a value sets an override, null removes it, dns: null removes every dns override, lists replace lists). Overridable: maxWorkers (the daemon side of the capacity; the admin worker limit maxWorkers of updateNode is separate and persistent), the worker container limits pidsLimit, shmSizeBytes, nofile, workerLogMaxSizeBytes and workerLogMaxFiles (for workers created afterwards), imageRetentionMs, pullTimeoutMs, logLevel, and the node resolver values under dns (mode recursive, iterative or disabled; upstreams as ip, ip:port, [v6]:port or host; rootServers as ip, ip:port or [v6]:port; servers are unicast public addresses without zone, private and special-purpose ones (loopback, RFC 1918, link-local, CGNAT and other reserved ranges) can only be configured in the node environment, 400 otherwise; localDomains; cacheSizeBytes; maxLookups; upstreamQps; authoritativeQps). A dns change replaces the node resolver, which starts with an empty cache. The daemon applies the overrides at once and reports them in daemonConfig: pending until it applied them, rejected with a message per key it refused. Read the daemon configuration with listNodes and include=daemonConfig. 409 daemonOverridesUnavailable with details.reason noInstance (no running daemon), notReported (the node has not reported a valid daemon configuration: an old daemon or an invalid report) or notAllowed (details.keys are not allowed by the node operator in SCANTOR_NODE_OVERRIDES). 409 invalidState when other writes changed the overrides concurrently three times in a row; retry.',
    'x-scantor-scope': 'admin',
    'x-mcp': true,
    'x-admin-only': true,
    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              maxWorkers: { type: ['integer', 'null'], minimum: 1, maximum: 100000, description: 'workers the daemon reports as its capacity' },
              pidsLimit: { type: ['integer', 'null'], minimum: 1, maximum: 1073741824, description: 'PidsLimit of new workers' },
              shmSizeBytes: { type: ['integer', 'null'], minimum: 1048576, maximum: 68719476736, description: '/dev/shm size of new workers' },
              nofile: { type: ['integer', 'null'], minimum: 1, maximum: 1073741824, description: 'nofile ulimit of new workers' },
              workerLogMaxSizeBytes: { type: ['integer', 'null'], minimum: 1, maximum: 17179869184, description: 'log file size of new workers' },
              workerLogMaxFiles: { type: ['integer', 'null'], minimum: 1, maximum: 1000, description: 'log files kept per new worker' },
              imageRetentionMs: { type: ['integer', 'null'], minimum: 0, maximum: 31536000000, description: 'how long unused task images stay' },
              pullTimeoutMs: { type: ['integer', 'null'], minimum: 1000, maximum: 86400000, description: 'timeout of one image pull' },
              logLevel: { type: ['string', 'null'], enum: ['debug', 'info', 'warn', 'error', null], description: 'log level of the daemon' },
              dns: {
                type: ['object', 'null'],
                additionalProperties: false,
                description: 'node resolver values; any change replaces the node resolver',
                properties: {
                  mode: { type: ['string', 'null'], enum: ['recursive', 'iterative', 'disabled', null] },
                  upstreams: {
                    type: ['array', 'null'],
                    minItems: 1,
                    maxItems: 16,
                    description:
                      'upstream servers of recursive mode: ip, ip:port, [v6]:port or host (the host nameservers); private and special-purpose addresses only in the node environment',
                    items: { type: 'string', maxLength: 64 },
                  },
                  rootServers: {
                    type: ['array', 'null'],
                    maxItems: 16,
                    description:
                      'root servers of iterative mode: ip, ip:port or [v6]:port (empty: the IANA root servers); private and special-purpose addresses only in the node environment',
                    items: { type: 'string', maxLength: 64 },
                  },
                  localDomains: {
                    type: ['array', 'null'],
                    maxItems: 64,
                    description: 'domains resolved through the host nameservers',
                    items: { type: 'string', maxLength: 253 },
                  },
                  cacheSizeBytes: { type: ['integer', 'null'], minimum: 16777216, maximum: 68719476736 },
                  maxLookups: { type: ['integer', 'null'], minimum: 1, maximum: 20000 },
                  upstreamQps: { type: ['integer', 'null'], minimum: 0, maximum: 1000000, description: '0: no limit' },
                  authoritativeQps: { type: ['integer', 'null'], minimum: 0, maximum: 1000000, description: '0: no limit' },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The node with its daemon configuration', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: {
        description: 'daemonOverridesUnavailable, or invalidState when the overrides changed concurrently',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeIdParams, updateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import { updateNodeDaemonOverrides } from '../../../services/nodes/admin'
import { requireAdmin } from '../../../utils/authz'
import { useLogger } from '../../../utils/logger'
import { validateBody, validateParams } from '../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireAdmin(event)
  const { nodeId } = validateParams(event, nodeIdParams)
  return updateNodeDaemonOverrides(nodeId, await validateBody(event, updateNodeDaemonOverridesBody), principal.user.id, log)
})
