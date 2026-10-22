defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'listRevisions',
    summary: 'List revisions',
    description:
      'Lists the revisions of a task, highest number first: number and ref (<task>@<N>), state (queued, building, ready, failed), source kind and pack hash, privileged flag and the number of build errors. Filter by state; page with cursor and limit. Use getRevision for schemas, settings defaults and errors.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['queued', 'building', 'ready', 'failed'] } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: {
        description: 'A page of revisions',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/RevisionSummary' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      404: { description: 'No such task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          RevisionSummary: {
            type: 'object',
            required: ['id', 'number', 'ref', 'state', 'source', 'privileged', 'errorsCount', 'createdAt', 'finishedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              number: { type: 'integer', minimum: 1 },
              ref: { type: 'string', description: '<task>@<number>' },
              state: { type: 'string', enum: ['queued', 'building', 'ready', 'failed'] },
              source: {
                type: 'object',
                required: ['kind', 'packSha256'],
                properties: { kind: { type: 'string', enum: ['workspace', 'upload', 'git'] }, packSha256: { type: 'string' } },
              },
              privileged: { type: 'boolean' },
              errorsCount: { type: 'integer', minimum: 0 },
              createdAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          Revision: {
            type: 'object',
            description:
              'An immutable, numbered build of a task (<task>@<N>): its stored source snapshot, the normalised manifest, the image by digest and the describe output (JSON Schemas of the task, scan and analysis configs and of the result, the schedule kind). Scans pin a ready revision.',
            required: ['id', 'userId', 'taskId', 'taskName', 'number', 'ref', 'state', 'source', 'image', 'description', 'privileged', 'errors', 'createdAt', 'updatedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string' },
              taskId: { type: 'string', format: 'uuid' },
              taskName: { type: 'string' },
              number: { type: 'integer', minimum: 1 },
              ref: { type: 'string', description: '<task>@<number>' },
              state: { type: 'string', enum: ['queued', 'building', 'ready', 'failed'] },
              message: { type: ['string', 'null'] },
              source: {
                type: 'object',
                required: ['kind', 'packSha256', 'packBytes', 'fileCount'],
                properties: {
                  kind: { type: 'string', enum: ['workspace', 'upload', 'git'] },
                  packSha256: { type: 'string', description: 'SHA-256 of the uncompressed deterministic tar' },
                  packBytes: { type: 'integer' },
                  fileCount: { type: 'integer' },
                  git: {
                    type: 'object',
                    properties: { url: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' }, commit: { type: 'string' }, dirty: { type: 'boolean' } },
                  },
                },
              },
              manifest: { type: ['object', 'null'], additionalProperties: true, description: 'normalised scantor.yaml' },
              language: { type: ['string', 'null'] },
              baseImage: { type: ['object', 'null'], properties: { ref: { type: 'string' }, digest: { type: 'string' } } },
              image: {
                type: ['object', 'null'],
                properties: {
                  repository: { type: 'string' },
                  tag: { type: 'string' },
                  digest: { type: 'string' },
                  bytes: { type: 'integer' },
                  platform: { type: 'object', properties: { os: { type: 'string' }, arch: { type: 'string' } } },
                },
              },
              description: { anyOf: [{ $ref: '#/components/schemas/Description' }, { type: 'null' }] },
              settingsDefaults: {
                type: ['object', 'null'],
                description: 'ScanSettings without nodeSelector, normalised from the manifest defaults',
                additionalProperties: true,
              },
              privileged: { type: 'boolean' },
              errors: { type: 'array', items: { $ref: '#/components/schemas/BuildError' } },
              createdAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listRevisionsQuery, taskParams } from '#shared/schemas/tasks'
import { listRevisions } from '../../../../services/revisions'
import { requireUser, resolveTask } from '../../../../utils/authz'
import { validateParams, validateQuery } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { task } = validateParams(event, taskParams)
  const query = validateQuery(event, listRevisionsQuery)
  return listRevisions(await resolveTask(principal, task), query)
})
