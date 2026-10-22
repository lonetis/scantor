defineRouteMeta({
  openAPI: {
    tags: ['nodes'],
    operationId: 'listNodes',
    summary: 'List nodes',
    description:
      'Admin only. Lists every compute node (the built-in node first, then by name) with state (pending, online, offline, revoked), cordon flag, pool, labels, reported capacity (CPUs, memory, free disk, DinD mode, max workers), version, last contact and the number of active workers. Filter by state or pool. Use it to see why workers stay pending (no online node with capacity, wrong pool or architecture) or which nodes are offline.',
    'x-scantor-scope': 'admin',
    'x-mcp': true,
    'x-admin-only': true,
    parameters: [
      { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'online', 'offline', 'revoked'] } },
      { name: 'pool', in: 'query', required: false, schema: { type: 'string', maxLength: 64 } },
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
              maxWorkers: { type: ['integer', 'null'], description: 'admin override; effective capacity = min(info.maxWorkers, maxWorkers)' },
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
                  clockOffsetMs: { type: 'integer' },
                },
              },
              assignmentsRev: { type: 'integer' },
              lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
              createdBy: { type: ['string', 'null'] },
              activeWorkers: { type: 'integer' },
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
