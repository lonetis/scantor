defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'listTemplates',
    summary: 'List templates',
    description:
      'Lists the schedule templates (single, list, range, repeat, tranco, crux, cidr): reusable schedule implementations with predefined scan config and analysis config types. A task uses one by passing the template\'s schedule (see the authoring guide); createTask scaffolds a task for a template. Each item has the JSON Schemas of its scan config and analysis config, an example, and resolves = true when non-deterministic inputs (for example "latest" lists) are pinned at scan start.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    responses: {
      200: {
        description: 'The templates',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Template' } } } },
          },
        },
      },
    },
    $global: {
      components: {
        schemas: {
          Template: {
            type: 'object',
            required: ['name', 'title', 'description', 'scanConfigSchema', 'analysisConfigSchema', 'example', 'resolves'],
            properties: {
              name: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              scanConfigSchema: { type: 'object', additionalProperties: true },
              analysisConfigSchema: { type: 'object', additionalProperties: true },
              example: {
                type: 'object',
                properties: { scanConfig: { type: 'object', additionalProperties: true }, analysisConfig: { type: 'object', additionalProperties: true } },
              },
              resolves: { type: 'boolean', description: 'non-deterministic inputs are pinned at scan start' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listTemplates } from '../../services/catalog/templates'
import { requireUser } from '../../utils/authz'

export default defineEventHandler(async (event) => {
  requireUser(event)
  return { items: await listTemplates() }
})
