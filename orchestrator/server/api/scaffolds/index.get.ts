defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'listScaffolds',
    summary: 'List scaffolds',
    description: 'Lists the task scaffolds createTask can render: per language, the templates it has a starter for, plus "custom" (a generator stub).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The scaffolds',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['language', 'templates'],
                    properties: { language: { type: 'string' }, templates: { type: 'array', items: { type: 'string' } } },
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
import { listScaffolds } from '../../services/catalog/languages'
import { requireUser } from '../../utils/authz'

export default defineEventHandler(async (event) => {
  requireUser(event)
  return { items: await listScaffolds() }
})
