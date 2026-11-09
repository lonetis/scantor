defineRouteMeta({
  openAPI: {
    tags: ['script-runtime'],
    operationId: 'scriptRuntimeBootstrap',
    summary: 'Bootstrap a script run',
    description:
      'Called once by the script inside a script-run container with its script-run token. Returns the run (id, script, config, the secrets in clear text, the effective settings including the analysis limit of a sample run, the integer CPU count, start time and deadline), every scan of the run in request order (state, task, revision, newest seq, status counts with a hint flag, the analysis config and result schemas, the paths of embedded FileRefs and of secret values), the checkpoint and stored outputs of the run a resumed run continues, the limits of the script runtime API and the origin of the S3 endpoint the presigned URLs point to. A scan deleted meanwhile is 404.',
    'x-scantor-scope': 'scriptRun',
    'x-mcp': false,
    responses: {
      200: {
        description: 'The bootstrap document',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['scriptRun', 'scans', 'resume', 'limits', 's3Origin'],
              properties: {
                scriptRun: {
                  type: 'object',
                  required: ['id', 'scriptId', 'scriptName', 'config', 'secrets', 'settings', 'cpus', 'startedAt', 'deadline'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    scriptId: { type: 'string', format: 'uuid' },
                    scriptName: { type: 'string' },
                    config: { type: 'object', additionalProperties: true },
                    secrets: { type: 'object', additionalProperties: { type: 'string' } },
                    settings: { type: 'object', additionalProperties: true },
                    cpus: { type: 'integer', minimum: 1 },
                    startedAt: { type: ['string', 'null'], format: 'date-time' },
                    deadline: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
                scans: { type: 'array', items: { type: 'object', additionalProperties: true } },
                resume: { type: ['object', 'null'], additionalProperties: true },
                limits: { type: 'object', additionalProperties: { type: 'integer' } },
                s3Origin: { type: 'string' },
              },
            },
          },
        },
      },
      401: {
        description: 'Invalid script-run token or the run is no longer running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'The request did not come from a script-run container',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      404: { description: 'A scan of the run no longer exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptRuntimeBootstrap } from '../../services/script-runtime/bootstrap'
import { requireScriptRun } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { useLogger } from '../../utils/logger'

const log = useLogger('script-runtime')

export default defineEventHandler((event) => {
  const principal = requireScriptRun(event)
  return scriptRuntimeBootstrap(principal, useConfig(), log)
})
