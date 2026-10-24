defineRouteMeta({
  openAPI: {
    tags: ['health'],
    operationId: 'getHealth',
    summary: 'Get platform health',
    description:
      'Public liveness and dependency check. Reports whether MongoDB, RabbitMQ, the S3 store and the registry answer, plus active RabbitMQ alarms. Answers 503 only when MongoDB is down; any other failed component or an active RabbitMQ alarm makes the status "degraded". No credentials are needed or checked.',
    'x-scantor-scope': 'public',
    'x-mcp': false,
    responses: {
      200: { description: 'Health report', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
      503: { description: 'MongoDB is down', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
    },
    $global: {
      components: {
        schemas: {
          Error: {
            type: 'object',
            description: 'Error envelope of every /api error (docs/api.md §1.7).',
            required: ['error'],
            properties: {
              error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  code: { type: 'string', description: 'camelCase error code, for example notFound or invalidState' },
                  message: { type: 'string' },
                  details: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
          JobRef: {
            type: 'object',
            required: ['id', 'kind', 'state'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: {
                type: 'string',
                enum: ['revisionBuild', 'testRun', 'scanDelete', 'scanRetryFailed', 'export', 'taskDelete', 'userPurge'],
              },
              state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
            },
          },
          ScantorError: {
            type: 'object',
            description: 'The unified error of an analysis or worker (docs/data-model.md §4.6).',
            required: ['type', 'message', 'retryable', 'phase', 'attempt', 'at'],
            properties: {
              type: { type: 'string', enum: ['taskError', 'fatal', 'retry', 'timeout', 'crash', 'validation', 'platform', 'cancelled'] },
              message: { type: 'string', maxLength: 4096 },
              retryable: { type: 'boolean' },
              phase: { type: 'string', enum: ['bootstrap', 'schedule', 'run', 'validate', 'upload', 'publish', 'platform', 'ingest'] },
              attempt: { type: 'integer', minimum: 0 },
              stack: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
              at: { type: 'string', format: 'date-time' },
            },
          },
          BuildError: {
            type: 'object',
            description: 'A structured task-pipeline error; file is relative to the task root, line and column are 1-based.',
            required: ['phase', 'message'],
            properties: {
              phase: { type: 'string', enum: ['pack', 'static', 'build', 'describe', 'check', 'push', 'platform', 'config', 'schedule'] },
              file: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              column: { type: 'integer', minimum: 1 },
              message: { type: 'string', maxLength: 4096 },
            },
          },
          FileRef: {
            type: 'object',
            description: 'A file attached to an analysis; download it with getFileDownload.',
            required: ['id', 'name', 'size', 'sha256', 'contentType'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string', minLength: 1, maxLength: 255 },
              size: { type: 'integer', minimum: 0 },
              sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              contentType: { type: 'string' },
            },
          },
          ScanSettings: {
            type: 'object',
            description: 'Effective platform settings of a scan (docs/data-model.md §4.5.1); resources are per process.',
            required: ['workers', 'processes', 'timeoutMs', 'maxAttempts', 'backoff', 'resources', 'maxAnalysesPerProcess', 'nodeSelector', 'privileged'],
            properties: {
              workers: { type: 'integer', minimum: 1 },
              processes: { type: 'integer', minimum: 1 },
              timeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
              maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
              backoff: {
                type: 'object',
                required: ['initialMs', 'factor', 'maxMs', 'jitter'],
                properties: {
                  initialMs: { type: 'integer', minimum: 1000 },
                  factor: { type: 'number', minimum: 1, maximum: 10 },
                  maxMs: { type: 'integer', maximum: 86400000 },
                  jitter: { type: 'boolean' },
                },
              },
              resources: {
                type: 'object',
                required: ['cpus', 'memoryMiB'],
                properties: { cpus: { type: 'number', minimum: 0.1, maximum: 64 }, memoryMiB: { type: 'integer', minimum: 64, maximum: 65536 } },
              },
              maxAnalysesPerProcess: { type: 'integer', minimum: 1, maximum: 1000000 },
              nodeSelector: {
                type: 'object',
                required: ['pool', 'labels'],
                properties: { pool: { type: 'string' }, labels: { type: 'object', additionalProperties: { type: 'string' } } },
              },
              privileged: { type: 'boolean' },
            },
          },
          Description: {
            type: 'object',
            description: 'The describe output of a revision or draft image: JSON Schemas of the four task types and the schedule kind.',
            required: ['protocolVersion', 'connector', 'schemas', 'schedule', 'secretPaths', 'uploadPaths', 'fileRefPaths', 'warnings'],
            properties: {
              protocolVersion: { type: 'integer' },
              connector: { type: 'object', properties: { language: { type: 'string' }, version: { type: 'string' } } },
              schemas: {
                type: 'object',
                properties: {
                  taskConfig: { type: 'object', additionalProperties: true },
                  scanConfig: { type: 'object', additionalProperties: true },
                  analysisConfig: { type: 'object', additionalProperties: true },
                  result: { type: 'object', additionalProperties: true },
                },
              },
              schedule: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', enum: ['template', 'custom'] }, template: { type: 'string' } },
              },
              secretPaths: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              uploadPaths: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              fileRefPaths: { type: 'array', items: { type: 'string' } },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
          StateReason: {
            type: ['object', 'null'],
            description: 'Why the last state transition happened: user, failureRate, schedulingFailed, completed, stalled, revisionUnavailable.',
            required: ['code', 'message', 'at'],
            properties: { code: { type: 'string' }, message: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
          },
          Worker: {
            type: 'object',
            description: 'One worker container of a scan (role scheduler or runner).',
            required: ['id', 'userId', 'scanId', 'role', 'nodeId', 'epoch', 'state', 'stateReason', 'spec', 'processes', 'container', 'runtime', 'node', 'scan', 'createdAt', 'updatedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              scanId: { type: 'string', format: 'uuid' },
              role: { type: 'string', enum: ['scheduler', 'runner'] },
              nodeId: { type: ['string', 'null'], format: 'uuid' },
              epoch: { type: 'integer' },
              state: { type: 'string', enum: ['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff', 'draining', 'stopped', 'lost'] },
              stateReason: { $ref: '#/components/schemas/StateReason' },
              spec: { type: 'object', additionalProperties: true },
              processes: {
                type: 'object',
                properties: {
                  desired: { type: 'integer' },
                  assigned: { type: 'integer' },
                  applied: { type: ['integer', 'null'] },
                  running: { type: ['integer', 'null'] },
                },
              },
              container: { type: ['object', 'null'], additionalProperties: true },
              runtime: { type: ['object', 'null'], additionalProperties: true },
              logs: { type: ['object', 'null'], additionalProperties: true },
              node: { type: ['object', 'null'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
              scan: { type: 'object', properties: { id: { type: 'string' }, name: { type: ['string', 'null'] } } },
              createdAt: { type: 'string', format: 'date-time' },
              assignedAt: { type: ['string', 'null'], format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              stoppedAt: { type: ['string', 'null'], format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          Event: {
            type: 'object',
            description: 'A timeline event (scan.*, worker.*, revision.*, node.*, security.*).',
            required: ['id', 'at', 'type', 'level', 'userId', 'message'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              at: { type: 'string', format: 'date-time' },
              type: { type: 'string' },
              level: { type: 'string', enum: ['info', 'warning', 'error'] },
              userId: { type: ['string', 'null'], format: 'uuid' },
              scanId: { type: 'string', format: 'uuid' },
              taskId: { type: 'string', format: 'uuid' },
              revisionId: { type: 'string', format: 'uuid' },
              workerId: { type: 'string', format: 'uuid' },
              nodeId: { type: 'string', format: 'uuid' },
              message: { type: 'string' },
              data: { type: 'object', additionalProperties: true },
            },
          },
          FileDownload: {
            type: 'object',
            description: 'A presigned download of one file (docs/architecture.md §11.5).',
            required: ['url', 'expiresAt', 'name', 'size', 'sha256', 'contentType', 'inline'],
            properties: {
              url: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
              name: { type: 'string' },
              size: { type: 'integer', minimum: 0 },
              sha256: { type: 'string' },
              contentType: { type: 'string', description: 'The content type the task declared' },
              inline: { type: 'boolean', description: 'true for png/jpeg/gif/webp images, which the link serves inline' },
            },
          },
          Health: {
            type: 'object',
            required: ['status', 'version', 'components', 'alarms'],
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded'] },
              version: { type: 'string' },
              components: {
                type: 'object',
                properties: {
                  mongo: { type: 'string', enum: ['ok', 'down'] },
                  rabbitmq: { type: 'string', enum: ['ok', 'down'] },
                  s3: { type: 'string', enum: ['ok', 'down'] },
                  registry: { type: 'string', enum: ['ok', 'down'] },
                },
              },
              alarms: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { checkHealth } from '../utils/health'

export default defineEventHandler(async (event) => {
  const health = await checkHealth()
  if (health.components.mongo === 'down') setResponseStatus(event, 503)
  return health
})
