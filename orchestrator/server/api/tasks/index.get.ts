defineRouteMeta({
  openAPI: {
    tags: ['tasks'],
    operationId: 'listTasks',
    summary: 'List tasks',
    description:
      'Lists your tasks, newest first. Each task carries its cached workspace status (workspace.dirty = the workspace differs from the latest published revision), its latest revision and its latest ready revision (the target of "<name>@latest"). Filter with q (substring of name or description) and language. Admins see every user’s tasks and may filter with userId. Page with cursor and limit.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'q', in: 'query', required: false, description: 'Case-insensitive substring of the name or description.', schema: { type: 'string', maxLength: 64 } },
      { name: 'language', in: 'query', required: false, schema: { type: 'string', enum: ['python', 'typescript', 'javascript', 'go'] } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'userId', in: 'query', required: false, description: 'Admins only: the owner to list.', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: {
        description: 'A page of tasks',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Task' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'userId of another user without admin power', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          RevisionPointer: {
            type: 'object',
            required: ['id', 'number', 'state', 'packSha256', 'createdAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              number: { type: 'integer', minimum: 1 },
              state: { type: 'string', enum: ['queued', 'building', 'ready', 'failed'] },
              packSha256: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
          Task: {
            type: 'object',
            description:
              'A task: a folder in your workspace (manifest scantor.yaml, Dockerfile, entry file) identified by a name unique among your tasks. Revisions are immutable published builds of it.',
            required: ['id', 'userId', 'name', 'language', 'source', 'workspace', 'revisionCount', 'latestRevision', 'latestReadyRevision', 'privileged', 'createdAt', 'updatedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string' },
              name: { type: 'string', description: 'slug, immutable; equals the manifest name' },
              language: { type: 'string', enum: ['python', 'typescript', 'javascript', 'go'] },
              description: { type: ['string', 'null'] },
              source: {
                type: 'object',
                required: ['kind'],
                properties: {
                  kind: { type: 'string', enum: ['scaffold', 'upload', 'git'] },
                  template: { type: 'string' },
                  git: {
                    type: 'object',
                    properties: {
                      url: { type: 'string' },
                      ref: { type: 'string' },
                      path: { type: 'string' },
                      credentialId: { type: ['string', 'null'] },
                      commit: { type: 'string' },
                      packSha256: { type: 'string', description: 'workspace pack hash right after the last import or pull' },
                      pulledAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
              workspace: {
                type: 'object',
                description: 'Cached workspace status, refreshed whenever a helper computes it (getTaskWorkspace computes it fresh).',
                required: ['packSha256', 'fileCount', 'bytes', 'dirty', 'lastSyncSha256', 'checkedAt'],
                properties: {
                  packSha256: { type: ['string', 'null'] },
                  fileCount: { type: 'integer' },
                  bytes: { type: 'integer' },
                  dirty: { type: 'boolean', description: 'true when the workspace differs from the latest revision (or no revision exists)' },
                  lastSyncSha256: { type: ['string', 'null'], description: 'pack hash after the last upload, git import or pull' },
                  checkedAt: { type: ['string', 'null'], format: 'date-time' },
                },
              },
              revisionCount: { type: 'integer', minimum: 0 },
              latestRevision: { anyOf: [{ $ref: '#/components/schemas/RevisionPointer' }, { type: 'null' }] },
              latestReadyRevision: { anyOf: [{ $ref: '#/components/schemas/RevisionPointer' }, { type: 'null' }] },
              privileged: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listTasksQuery } from '#shared/schemas/tasks'
import { listTasks } from '../../services/tasks'
import { requireUser } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, listTasksQuery)
  return listTasks(principal, query)
})
