defineRouteMeta({
  openAPI: {
    tags: ['setup'],
    operationId: 'getSetupStatus',
    summary: 'Get setup status',
    description:
      'Public. Tells whether the first admin still has to be created (needsSetup), whether passkeys are available on this deployment and the MCP URL (null when MCP is disabled). The web UI redirects to /setup while needsSetup is true.',
    'x-scantor-scope': 'public',
    'x-mcp': false,
    responses: {
      200: { description: 'Setup status', content: { 'application/json': { schema: { $ref: '#/components/schemas/SetupStatus' } } } },
    },
    $global: {
      components: {
        schemas: {
          SetupStatus: {
            type: 'object',
            required: ['needsSetup', 'passkeysEnabled', 'mcpUrl'],
            properties: {
              needsSetup: { type: 'boolean' },
              passkeysEnabled: { type: 'boolean' },
              mcpUrl: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { setupStatus } from '../../services/setup'

export default defineEventHandler(() => setupStatus())
