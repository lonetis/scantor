defineRouteMeta({
  openAPI: {
    tags: ['node'],
    operationId: 'postWorkerLogs',
    summary: 'Answer an on-demand worker log request',
    description:
      'Called by the node daemon for each new logRequests entry of its assignments: the last tailBytes of the worker container\'s output, cut on a UTF-8 boundary. Accepted only for workers assigned to the calling node and an open request id; anything else is 404. Requires the instance lease, else 409 nodeInstanceConflict.',
    'x-scantor-scope': 'node',
    'x-mcp': false,
    parameters: [
      { name: 'workerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'X-Scantor-Instance-Id', in: 'header', required: true, schema: { type: 'string' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['requestId', 'text', 'bytes', 'truncated', 'collectedAt'],
            properties: {
              requestId: { type: 'string', format: 'uuid' },
              text: { type: 'string' },
              bytes: { type: 'integer', minimum: 0 },
              truncated: { type: 'boolean' },
              collectedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    responses: {
      204: { description: 'Stored' },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Unknown or revoked node token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not a worker of this node, or no open request with this id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'nodeInstanceConflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, getRequestHeader, sendNoContent } from 'h3'
import { workerIdParams, workerLogsBody } from '#shared/schemas/nodes'
import { INSTANCE_ID_HEADER, requireLeaseHolder } from '../../../../services/nodes/hello'
import { storeWorkerLogs } from '../../../../services/nodes/logs'
import { requireNode } from '../../../../utils/authz'
import { useConfig } from '../../../../utils/config'
import { useLogger } from '../../../../utils/logger'
import { validateBody, validateParams } from '../../../../utils/zod'

const log = useLogger('nodes')

export default defineEventHandler(async (event) => {
  const principal = requireNode(event)
  const { workerId } = validateParams(event, workerIdParams)
  const body = await validateBody(event, workerLogsBody)
  const node = await requireLeaseHolder(principal, getRequestHeader(event, INSTANCE_ID_HEADER), useConfig().nodeOfflineAfterMs)
  await storeWorkerLogs(node, workerId.toLowerCase(), body, log)
  return sendNoContent(event)
})
