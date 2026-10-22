defineRouteMeta({
  openAPI: {
    tags: ['editor'],
    operationId: 'getEditor',
    summary: 'Get your editor',
    description:
      'Returns the state of your browser editor (a per-user code-server container): starting, running, stopping or stopped, when it started, its last activity, the idle timeout after which it stops by itself, and the message of the last failed start (null when the last start did not fail). Always acts on your own editor, also for admins.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: { description: 'The editor', content: { 'application/json': { schema: { $ref: '#/components/schemas/Editor' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Editor: {
            type: 'object',
            description: 'The caller\'s browser editor (docs/api.md §4.18).',
            required: ['state', 'startedAt', 'lastActivityAt', 'idleTimeoutMs', 'error'],
            properties: {
              state: { type: 'string', enum: ['starting', 'running', 'stopping', 'stopped'] },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              lastActivityAt: { type: ['string', 'null'], format: 'date-time' },
              idleTimeoutMs: { type: 'integer', description: 'the editor stops after this long without activity' },
              error: { type: ['string', 'null'], description: 'message of the last failed start; cleared when a new start begins' },
            },
          },
          EditorSession: {
            type: 'object',
            description: 'A one-time handoff URL to the editor origin (valid 60 s, single use).',
            required: ['url', 'expiresAt', 'editor'],
            properties: {
              url: { type: 'string', description: '<SCANTOR_EDITOR_URL>/_auth?code=sec_…' },
              expiresAt: { type: 'string', format: 'date-time' },
              editor: {
                type: 'object',
                required: ['state', 'startedAt', 'lastActivityAt'],
                properties: {
                  state: { type: 'string', enum: ['starting', 'running'] },
                  startedAt: { type: ['string', 'null'], format: 'date-time' },
                  lastActivityAt: { type: ['string', 'null'], format: 'date-time' },
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
import { useEditorRuntime } from '../../services/editor'
import { requireUser } from '../../utils/authz'

export default defineEventHandler((event) => {
  const principal = requireUser(event)
  return useEditorRuntime().manager.status(principal.user.id)
})
