defineRouteMeta({
  openAPI: {
    tags: ['scans'],
    operationId: 'listScans',
    summary: 'List scans',
    description:
      'Lists your scans, newest first, with progress, live statistics and the number of active conditions. Deleting and deleted scans are hidden unless the state filter names them. Filter by state (comma-separated, for example running,paused) and by task (id or name). Admins see every user\'s scans and may filter with userId. Page with cursor and limit. Use getScan for the full scan with configs, settings, scheduling and conditions.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      {
        name: 'state',
        in: 'query',
        required: false,
        description: 'Comma-separated scan states: creating, running, paused, completed, failed, cancelled, deleting, deleted.',
        schema: { type: 'string', maxLength: 200 },
      },
      { name: 'task', in: 'query', required: false, description: 'A task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'userId', in: 'query', required: false, description: 'Admins only: the owner to list.', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: {
        description: 'A page of scans',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ScanSummary' } }, nextCursor: { type: ['string', 'null'] } },
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
          ScanStats: {
            type: 'object',
            description: 'Analysis counts by status (exact after a recount, otherwise live hints), the expected total and the completion rate.',
            required: ['pending', 'retrying', 'succeeded', 'failed', 'lost', 'cancelled', 'expectedTotal', 'ratePerMin', 'recountedAt'],
            properties: {
              pending: { type: 'integer' },
              retrying: { type: 'integer' },
              succeeded: { type: 'integer' },
              failed: { type: 'integer' },
              lost: { type: 'integer' },
              cancelled: { type: 'integer' },
              expectedTotal: { type: ['integer', 'null'] },
              ratePerMin: { type: 'number' },
              recountedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          ScanProgress: {
            type: 'object',
            description: 'scheduled = confirmed published analyses; terminal = succeeded + failed + lost + cancelled; total = expected total when known.',
            required: ['scheduled', 'terminal', 'total', 'percent', 'etaSeconds'],
            properties: {
              scheduled: { type: 'integer' },
              terminal: { type: 'integer' },
              total: { type: ['integer', 'null'] },
              percent: { type: ['number', 'null'] },
              etaSeconds: { type: ['integer', 'null'] },
            },
          },
          Condition: {
            type: 'object',
            description: 'Why a scan is not progressing (workersPending, crashLoop, imagePullFailed, workerErrors, schedulerRestarting, schedulingFailed, topologyFailed, brokerAlarm, breakerTripped, stalled, clockSkew).',
            required: ['type', 'severity', 'reason', 'message', 'since', 'updatedAt'],
            properties: {
              type: { type: 'string' },
              severity: { type: 'string', enum: ['info', 'warning', 'error'] },
              reason: { type: 'string' },
              message: { type: 'string' },
              since: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              details: { type: 'object', additionalProperties: true },
            },
          },
          ScanSummary: {
            type: 'object',
            required: ['id', 'userId', 'task', 'revision', 'state', 'stateReason', 'settings', 'progress', 'stats', 'conditionsCount', 'createdAt', 'completedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              name: { type: ['string', 'null'] },
              task: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
              revision: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' }, number: { type: 'integer' }, ref: { type: 'string', description: '<task>@<number>' } },
              },
              state: { type: 'string', enum: ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled', 'deleting', 'deleted'] },
              stateReason: { $ref: '#/components/schemas/StateReason' },
              settings: { type: 'object', properties: { workers: { type: 'integer' }, processes: { type: 'integer' } } },
              progress: { $ref: '#/components/schemas/ScanProgress' },
              stats: { $ref: '#/components/schemas/ScanStats' },
              conditionsCount: { type: 'integer' },
              createdAt: { type: 'string', format: 'date-time' },
              completedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          Scan: {
            type: 'object',
            description: 'A scan: one execution of a task revision. Secret config values are "***".',
            required: [
              'id',
              'userId',
              'task',
              'revision',
              'state',
              'stateReason',
              'taskConfig',
              'scanConfig',
              'secretPaths',
              'uploadIds',
              'settings',
              'round',
              'scheduling',
              'stats',
              'progress',
              'workers',
              'conditions',
              'breaker',
              'clonedFrom',
              'createdAt',
              'updatedAt',
              'startedAt',
              'pausedAt',
              'completedAt',
              'deletedAt',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              name: { type: ['string', 'null'] },
              task: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
              revision: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  number: { type: 'integer' },
                  ref: { type: 'string' },
                  language: { type: 'string' },
                  repository: { type: 'string' },
                  digest: { type: 'string' },
                  platform: { type: 'object', properties: { os: { type: 'string' }, arch: { type: 'string' } } },
                  privileged: { type: 'boolean' },
                  schedule: { type: 'object', properties: { kind: { type: 'string', enum: ['template', 'custom'] }, template: { type: 'string' } } },
                },
              },
              state: { type: 'string', enum: ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled', 'deleting', 'deleted'] },
              stateReason: { $ref: '#/components/schemas/StateReason' },
              taskConfig: { type: 'object', additionalProperties: true, description: 'Effective task config (defaults filled, secrets "***").' },
              scanConfig: { type: 'object', additionalProperties: true, description: 'Effective scan config as requested (before template resolution).' },
              secretPaths: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              uploadIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              settings: { $ref: '#/components/schemas/ScanSettings' },
              round: { type: 'integer', minimum: 1, description: 'Retry-failed generation (starts at 1).' },
              scheduling: {
                type: 'object',
                properties: {
                  state: { type: 'string', enum: ['pending', 'running', 'done', 'retrying', 'failed'] },
                  confirmed: { type: 'integer' },
                  tailHash: { type: ['string', 'null'] },
                  epoch: { type: 'integer' },
                  restarts: { type: 'integer' },
                  resolved: { type: 'object', additionalProperties: true, description: 'Template resolutions by key (schedule, call:<n>).' },
                  error: { anyOf: [{ $ref: '#/components/schemas/ScantorError' }, { type: 'null' }] },
                  startedAt: { type: ['string', 'null'], format: 'date-time' },
                  checkpointAt: { type: ['string', 'null'], format: 'date-time' },
                  doneAt: { type: ['string', 'null'], format: 'date-time' },
                },
              },
              stats: { $ref: '#/components/schemas/ScanStats' },
              progress: { $ref: '#/components/schemas/ScanProgress' },
              workers: {
                type: 'object',
                properties: {
                  desired: { type: 'integer' },
                  active: { type: 'integer' },
                  pending: { type: 'integer' },
                  byState: { type: 'object', additionalProperties: { type: 'integer' } },
                },
              },
              conditions: { type: 'array', items: { $ref: '#/components/schemas/Condition' } },
              breaker: {
                type: ['object', 'null'],
                properties: { trippedAt: { type: 'string', format: 'date-time' }, ratio: { type: 'number' }, attempts: { type: 'integer' }, windowMs: { type: 'integer' } },
              },
              clonedFrom: { type: ['string', 'null'], format: 'uuid' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              pausedAt: { type: ['string', 'null'], format: 'date-time' },
              completedAt: { type: ['string', 'null'], format: 'date-time' },
              deletedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listScansQuery } from '#shared/schemas/scans'
import { listScans } from '../../services/scans/queries'
import { requireUser } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler((event) => {
  const principal = requireUser(event)
  return listScans(principal, validateQuery(event, listScansQuery))
})
