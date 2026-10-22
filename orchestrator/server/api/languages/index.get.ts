defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'listLanguages',
    summary: 'List languages',
    description:
      'Lists the task languages (python, typescript, javascript, go) from schemas/languages.json: title, base image family, the base image this deployment builds on, the default entry and the allowed entry extensions.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The languages',
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
                    required: ['language', 'title', 'base', 'baseImage', 'entry', 'extensions'],
                    properties: {
                      language: { type: 'string' },
                      title: { type: 'string' },
                      base: { type: 'string', enum: ['python', 'js', 'go'] },
                      baseImage: { type: 'string', description: '<prefix>scantor-base-<base>:<tag> of this deployment' },
                      entry: { type: 'string' },
                      extensions: { type: 'array', items: { type: 'string' } },
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
import { listLanguages } from '../../services/catalog/languages'
import { requireUser } from '../../utils/authz'
import { useConfig } from '../../utils/config'

export default defineEventHandler((event) => {
  requireUser(event)
  return { items: listLanguages(useConfig()) }
})
