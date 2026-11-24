defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'listNodes',
    summary: 'List nodes',
    description:
      'Admin only. Lists every compute node (the built-in node first, then by name) with state (pending, online, offline, revoked), cordon flag, pool, labels, reported capacity (CPUs, memory, free disk, DinD mode, max workers), node resolver state (info.resolver), version, last contact and the number of active workers. Filter by state or pool; include=daemonConfig adds the daemon configuration of every node (values, their sources, daemon overrides and whether the daemon applied them). Use it to see why workers stay pending (no online node with capacity, wrong pool or architecture), which nodes are offline or whose node resolver fails.',
    'x-scantor-scope': 'admin',
    'x-mcp': true,
    'x-admin-only': true,
    parameters: [
      { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'online', 'offline', 'revoked'] } },
      { name: 'pool', in: 'query', required: false, schema: { type: 'string', maxLength: 64 } },
      {
        name: 'include',
        in: 'query',
        required: false,
        description: 'daemonConfig adds the daemon configuration of every node',
        schema: { type: 'string', enum: ['daemonConfig'] },
      },
    ],
    responses: {
      200: {
        description: 'Every matching node',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Node: {
            type: 'object',
            description: 'A compute node (docs/data-model.md §4.8) without its token hash; activeWorkers counts workers in states assigned … draining.',
            required: [
              'id', 'name', 'builtIn', 'state', 'endpointProfile', 'tokenPrefix', 'tokenRotatedAt', 'pool', 'labels', 'maxWorkers', 'cordoned',
              'instance', 'info', 'assignmentsRev', 'lastSeenAt', 'createdBy', 'activeWorkers', 'createdAt', 'updatedAt',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              builtIn: { type: 'boolean' },
              state: { type: 'string', enum: ['pending', 'online', 'offline', 'revoked'] },
              endpointProfile: { type: 'string', enum: ['internal', 'public'] },
              tokenPrefix: { type: ['string', 'null'], description: 'first 8 characters of the token, for display' },
              tokenRotatedAt: { type: ['string', 'null'], format: 'date-time' },
              pool: { type: 'string' },
              labels: { type: 'object', additionalProperties: { type: 'string' } },
              maxWorkers: { type: ['integer', 'null'], description: 'admin worker limit; effective capacity = min(info.maxWorkers, maxWorkers)' },
              cordoned: { type: 'boolean', description: 'no new placements; existing workers stay' },
              instance: {
                type: ['object', 'null'],
                description: 'the daemon instance holding the lease',
                properties: {
                  version: { type: 'string' },
                  startedAt: { type: 'string', format: 'date-time' },
                  lastSeenAt: { type: 'string', format: 'date-time' },
                },
              },
              info: {
                type: ['object', 'null'],
                description: 'the last report of the daemon',
                properties: {
                  version: { type: 'string' },
                  hostname: { type: 'string' },
                  os: { type: 'string' },
                  arch: { type: 'string' },
                  kernel: { type: 'string' },
                  dockerVersion: { type: 'string' },
                  cpus: { type: 'integer' },
                  memoryBytes: { type: 'integer' },
                  diskFreeBytes: { type: 'integer' },
                  dindMode: { type: 'string', enum: ['disabled', 'sysbox', 'privileged'] },
                  maxWorkers: { type: 'integer' },
                  egressDenyApplied: { type: 'boolean' },
                  networkIsolated: { type: 'boolean', description: 'absent until a daemon that reports it has connected' },
                  clockOffsetMs: { type: 'integer' },
                  resolver: {
                    type: ['object', 'null'],
                    description: 'the node resolver; absent until a daemon that runs one reported it, null when its report was invalid',
                    required: ['mode', 'state', 'kept', 'error', 'since', 'ipv6', 'upstreamOk', 'stats'],
                    properties: {
                      mode: { type: 'string', enum: ['recursive', 'iterative', 'disabled'] },
                      state: {
                        type: 'string',
                        enum: ['starting', 'ready', 'degraded', 'unreachable', 'failed', 'disabled'],
                        description: 'new workers use the node resolver only while it is ready',
                      },
                      address: { type: 'string', description: 'the IPv4 gateway of the worker network it listens on' },
                      kept: { type: 'boolean', description: 'mode disabled, but the resolver still serves existing workers' },
                      error: {
                        type: ['string', 'null'],
                        description:
                          'a code: noImage, noNetwork, bindInUse, bindUnavailable, bindDenied, foreignResolver, upstreamUnreachable, unhealthy, crashLoop, probeFailed or createFailed',
                      },
                      detail: { type: 'string', description: 'addresses and numbers that explain the error' },
                      since: { type: 'string', format: 'date-time', description: 'when the resolver entered its state' },
                      spec: { type: 'string', description: 'spec hash of the serving resolver container' },
                      ipv6: { type: 'boolean', description: 'whether it uses IPv6 servers, as of its newest health check; false while unknown (stats null)' },
                      upstreamOk: { type: 'boolean', description: 'whether its upstream or root servers answered its newest health check; false while unknown (stats null)' },
                      stats: {
                        type: ['object', 'null'],
                        description: 'counters since the resolver started; failures = SERVFAIL answers, timeouts and overload refusals',
                        properties: {
                          queries: { type: 'integer' },
                          cacheHits: { type: 'integer' },
                          lookups: { type: 'integer' },
                          failures: { type: 'integer' },
                          inflight: { type: 'integer' },
                          qps: { type: 'number' },
                          conntrackUsed: { type: 'number', description: 'nf_conntrack_count / nf_conntrack_max of the host (0 when unknown)' },
                        },
                      },
                    },
                  },
                },
              },
              assignmentsRev: { type: 'integer' },
              lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
              createdBy: { type: ['string', 'null'] },
              activeWorkers: { type: 'integer' },
              daemonConfig: {
                type: ['object', 'null'],
                description:
                  'the daemon configuration of the current daemon instance with its daemon overrides (getNode, the daemon overrides routes, listNodes with include=daemonConfig); null when that instance did not report one',
                required: [
                  'values',
                  'sources',
                  'warnings',
                  'overrides',
                  'overridesRev',
                  'appliedOverridesRev',
                  'pending',
                  'rejected',
                  'overriddenBy',
                  'overriddenAt',
                  'reportedAt',
                ],
                properties: {
                  values: {
                    type: 'object',
                    description: 'the values the daemon runs with (environment or default, with the overrides applied); secrets are never part of it',
                    properties: {
                      url: { type: 'string', description: 'SCANTOR_URL without user information' },
                      builtIn: { type: 'boolean' },
                      maxWorkers: { type: 'integer' },
                      dind: { type: 'string', enum: ['disabled', 'sysbox', 'privileged'] },
                      egressDeny: { type: 'array', items: { type: 'string' } },
                      allowUnisolatedNetworks: { type: 'boolean' },
                      allowInsecureTransport: { type: 'boolean' },
                      caCertificates: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { subject: { type: 'string' }, sha256: { type: 'string' }, notAfter: { type: 'string', format: 'date-time' } },
                        },
                      },
                      pidsLimit: { type: 'integer' },
                      shmSizeBytes: { type: 'integer' },
                      nofile: { type: 'integer' },
                      workerLogMaxSizeBytes: { type: 'integer' },
                      workerLogMaxFiles: { type: 'integer' },
                      imageRetentionMs: { type: 'integer' },
                      pullTimeoutMs: { type: 'integer' },
                      logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
                      logFormat: { type: 'string', enum: ['json', 'text'] },
                      overrides: {
                        type: ['string', 'array'],
                        items: { type: 'string' },
                        description: 'the override keys the node operator allows (SCANTOR_NODE_OVERRIDES): all, none or a list',
                      },
                      dns: {
                        type: 'object',
                        properties: {
                          mode: { type: 'string', enum: ['recursive', 'iterative', 'disabled'] },
                          upstreams: { type: 'array', items: { type: 'string' } },
                          rootServers: { type: 'array', items: { type: 'string' } },
                          localDomains: { type: 'array', items: { type: 'string' } },
                          cacheSizeBytes: { type: 'integer' },
                          maxLookups: { type: 'integer' },
                          upstreamQps: { type: 'integer' },
                          authoritativeQps: { type: 'integer' },
                        },
                      },
                    },
                  },
                  sources: { type: 'object', description: 'env, default or override for each value, nested like values' },
                  warnings: { type: 'array', items: { type: 'string' }, description: 'environment values the daemon replaced by their default' },
                  overrides: { type: 'object', description: 'the daemon overrides of this instance: only overridden keys, dns nested' },
                  overridesRev: { type: 'integer', description: 'revision of the overrides (0 without any)' },
                  appliedOverridesRev: { type: 'integer', description: 'the overrides revision the daemon applied' },
                  pending: { type: 'boolean', description: 'true until the daemon applied overridesRev' },
                  rejected: { type: 'object', description: 'a message for each override the daemon refused, nested like values' },
                  overriddenBy: { type: ['string', 'null'], description: 'the admin who changed the overrides last' },
                  overriddenAt: { type: ['string', 'null'], format: 'date-time' },
                  reportedAt: { type: 'string', format: 'date-time' },
                },
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
          NodeJoin: {
            type: 'object',
            description: 'How to start the node daemon on a Docker host: a one-line docker run command and a compose file.',
            required: ['dockerRun', 'compose', 'env'],
            properties: {
              dockerRun: { type: 'string' },
              compose: { type: 'string' },
              env: {
                type: 'object',
                required: ['SCANTOR_URL', 'SCANTOR_NODE_TOKEN'],
                properties: { SCANTOR_URL: { type: 'string' }, SCANTOR_NODE_TOKEN: { type: 'string' } },
              },
            },
          },
          NodeWithToken: {
            type: 'object',
            description: 'A node with its new token, shown exactly once.',
            required: ['node', 'token', 'join'],
            properties: {
              node: { $ref: '#/components/schemas/Node' },
              token: { type: 'string', pattern: '^snt_[A-Za-z0-9_-]{43}$' },
              join: { $ref: '#/components/schemas/NodeJoin' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listNodesQuery } from '#shared/schemas/nodes'
import { listNodes } from '../../services/nodes/admin'
import { requireAdmin } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listNodes(validateQuery(event, listNodesQuery))
})
