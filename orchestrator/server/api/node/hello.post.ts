defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'nodeHello',
    summary: 'Register a node daemon instance',
    description:
      'Called by the node daemon (scantor node) at start with its node token. Registers the daemon instance (instanceId = Docker engine id + ":" + boot nonce) under the node lease, stores the reported host info, sets the node online and returns its identity, endpoint profile and the orchestrator-side intervals. A live lease of a different Docker engine answers 409 nodeInstanceConflict with details.retryAfterMs; a restarted daemon on the same engine takes the lease over. Versions outside the supported window get 426 incompatibleVersion.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['instanceId', 'version', 'info'],
            properties: {
              instanceId: { type: 'string', maxLength: 200 },
              version: { type: 'string', maxLength: 64 },
              info: {
                type: 'object',
                additionalProperties: false,
                required: ['hostname', 'os', 'arch', 'kernel', 'dockerVersion', 'cpus', 'memoryBytes', 'diskFreeBytes', 'dindMode', 'maxWorkers', 'egressDenyApplied'],
                properties: {
                  hostname: { type: 'string' },
                  os: { type: 'string' },
                  arch: { type: 'string' },
                  kernel: { type: 'string' },
                  dockerVersion: { type: 'string' },
                  cpus: { type: 'integer', minimum: 0 },
                  memoryBytes: { type: 'integer', minimum: 0 },
                  diskFreeBytes: { type: 'integer', minimum: 0 },
                  dindMode: { type: 'string', enum: ['disabled', 'sysbox', 'privileged'] },
                  maxWorkers: { type: 'integer', minimum: 0 },
                  egressDenyApplied: { type: 'boolean' },
                },
              },
              containers: {
                type: 'array',
                description: 'Managed worker containers found at daemon start (for adoption).',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['workerId', 'containerId', 'state', 'specHash'],
                  properties: {
                    workerId: { type: 'string' },
                    containerId: { type: 'string' },
                    state: { type: 'string' },
                    specHash: { type: 'string' },
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
        description: 'The node identity and configuration',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverTime', 'node', 'config'],
              properties: {
                serverTime: { type: 'integer', description: 'epoch milliseconds' },
                node: {
                  type: 'object',
                  required: ['id', 'name', 'builtIn', 'endpointProfile', 'pool', 'labels'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    builtIn: { type: 'boolean' },
                    endpointProfile: { type: 'string', enum: ['internal', 'public'] },
                    pool: { type: 'string' },
                    labels: { type: 'object', additionalProperties: { type: 'string' } },
                  },
                },
                config: {
                  type: 'object',
                  required: ['statusIntervalMs', 'assignmentsWaitSeconds', 'offlineAfterMs', 'drainGraceMs', 'registry', 'minFreeDiskBytes'],
                  properties: {
                    statusIntervalMs: { type: 'integer' },
                    assignmentsWaitSeconds: { type: 'integer' },
                    offlineAfterMs: { type: 'integer' },
                    drainGraceMs: { type: 'integer' },
                    registry: { type: 'object', required: ['host', 'username'], properties: { host: { type: 'string' }, username: { type: 'string', enum: ['node'] } } },
                    minFreeDiskBytes: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Unknown or revoked node token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'nodeInstanceConflict: another engine holds the lease', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      426: { description: 'incompatibleVersion', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { nodeHelloBody } from '#shared/schemas/nodes'
import { handleHello } from '../../services/nodes/hello'
import { requireNode } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'
import { validateBody } from '../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireNode(event)
  const body = await validateBody(event, nodeHelloBody)
  return handleHello(principal, body, useConfig(), log)
})
