defineRouteMeta({
  openAPI: {
    tags: ['uploads'],
    operationId: 'listUploads',
    summary: 'List uploads',
    description: 'Lists your uploaded list files, newest first. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of uploads',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Upload' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listUploadsQuery } from '#shared/schemas/tasks'
import { listUploads } from '../../services/uploads'
import { requireUser } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  return listUploads(principal, validateQuery(event, listUploadsQuery))
})
