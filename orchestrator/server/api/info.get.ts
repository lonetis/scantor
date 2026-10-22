defineRouteMeta({
  openAPI: {
    tags: ['instance'],
    operationId: 'getInstanceInfo',
    summary: 'Get instance information',
    description:
      'Returns the instance-specific settings a client needs: version, public, editor and MCP URLs, the registry host, the CLI image, enabled features, platform limits and the caller. Admins also get the admin tool links. Never contains secrets.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: { description: 'Instance information', content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceInfo' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          InstanceInfo: {
            type: 'object',
            required: ['version', 'publicUrl', 'editorUrl', 'mcpUrl', 'registryPublicHost', 'cliImage', 'features', 'limits', 'user'],
            properties: {
              version: { type: 'string' },
              publicUrl: { type: 'string' },
              editorUrl: { type: 'string' },
              mcpUrl: { type: ['string', 'null'] },
              registryPublicHost: { type: 'string' },
              cliImage: { type: 'string' },
              features: {
                type: 'object',
                properties: {
                  passkeys: { type: 'boolean' },
                  mcp: { type: 'boolean' },
                  mcpOAuth: { type: 'boolean' },
                  editor: { type: 'boolean' },
                },
              },
              limits: {
                type: 'object',
                properties: {
                  maxWorkersPerScan: { type: 'integer' },
                  maxProcessesPerWorker: { type: 'integer' },
                  maxResultBytes: { type: 'integer' },
                  maxFileBytes: { type: 'integer' },
                  scanConfirmThreshold: { type: 'integer' },
                  waitMaxSeconds: { type: 'integer' },
                },
              },
              user: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string', enum: ['admin', 'user'] } } },
              adminTools: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        target: { type: 'string', enum: ['rabbitmq', 'mongo-express', 'rustfs', 'traefik'] },
                        title: { type: 'string' },
                        url: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { requireUser } from '../utils/authz'
import { useConfig } from '../utils/config'
import { buildInstanceInfo } from '../utils/instance-info'

export default defineEventHandler((event) => {
  const principal = requireUser(event)
  return buildInstanceInfo(useConfig(), principal)
})
