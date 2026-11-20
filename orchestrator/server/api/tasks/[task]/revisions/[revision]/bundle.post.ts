defineRouteMeta({
  openAPI: {
    tags: ['revisions'],
    operationId: 'createRevisionBundle',
    summary: 'Create a revision bundle',
    description:
      'Creates the bundle of a ready revision: a gzip Docker image archive of the revision with the runtime, the describe output and the settings defaults baked in, which runs with only Docker (docker load, then docker run with the working directory mounted at /work). One bundle exists per revision: a queued or running bundle is returned as is (200), and so is a ready one built with the current runtime unless rebuild=true; a failed, expired or outdated bundle is replaced (201). The bundle starts queued, becomes running and ends ready (download.url is a presigned link valid 10 minutes; call getRevisionBundle for a fresh one) or failed. With wait (seconds) the call returns once the bundle is ready or failed. Privileged revisions cannot be bundled (409 bundleUnsupported). Bundles expire after the retention period.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'task', in: 'path', required: true, description: 'Task id or one of your task names.', schema: { type: 'string', maxLength: 64 } },
      { name: 'revision', in: 'path', required: true, description: 'Revision number, latest or revision id.', schema: { type: 'string', maxLength: 36 } },
      {
        name: 'wait',
        in: 'query',
        required: false,
        description: 'Seconds to wait for the bundle to be ready or failed (0–120).',
        schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
      },
      { name: 'rebuild', in: 'query', required: false, description: 'Replace a ready bundle with a new one.', schema: { type: 'boolean', default: false } },
    ],
    responses: {
      200: { description: 'The existing bundle of the revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bundle' } } } },
      201: { description: 'The new bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bundle' } } } },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such task or revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: {
        description: 'The revision is not ready (revisionNotReady) or cannot be bundled (bundleUnsupported, details.reason privileged)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          Bundle: {
            type: 'object',
            description: 'The bundle of a revision: a gzip Docker image archive that runs with only Docker (docs/data-model.md §4.21).',
            required: [
              'id',
              'revision',
              'state',
              'image',
              'platform',
              'bytes',
              'sha256',
              'scantorVersion',
              'error',
              'createdAt',
              'startedAt',
              'finishedAt',
              'expiresAt',
              'download',
              'commands',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              revision: {
                type: 'object',
                required: ['id', 'number', 'ref'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  number: { type: 'integer', minimum: 1 },
                  ref: { type: 'string', description: '<task>@<number>' },
                },
              },
              state: { type: 'string', enum: ['queued', 'running', 'ready', 'failed'] },
              image: { type: 'string', description: 'The image name inside the archive: localhost/scantor/<task>:<number>.' },
              platform: {
                type: 'object',
                description: 'The single platform of the archive (the revision image).',
                required: ['os', 'arch'],
                properties: { os: { type: 'string' }, arch: { type: 'string' }, variant: { type: 'string' } },
              },
              bytes: { type: ['integer', 'null'], minimum: 0, description: 'Archive size; set when ready.' },
              sha256: { type: ['string', 'null'], description: 'Archive SHA-256 (hex); set when ready.' },
              scantorVersion: { type: ['string', 'null'], description: 'Version of the runtime baked into the image; set when ready.' },
              error: {
                type: ['object', 'null'],
                required: ['code', 'message'],
                properties: { code: { type: 'string' }, message: { type: 'string' } },
              },
              createdAt: { type: 'string', format: 'date-time' },
              startedAt: { type: ['string', 'null'], format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time' },
              download: {
                type: ['object', 'null'],
                description: 'Set when ready: a presigned GET (application/gzip attachment named fileName) valid 10 minutes, created anew on every call.',
                required: ['url', 'expiresAt', 'fileName'],
                properties: {
                  url: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time' },
                  fileName: { type: 'string', description: '<task>-<number>-<os>-<arch>.bundle.tar.gz' },
                },
              },
              commands: {
                type: 'object',
                description: 'The recipient commands: load the archive once, run it with the working directory at /work, describe it.',
                required: ['load', 'run', 'describe'],
                properties: { load: { type: 'string' }, run: { type: 'string' }, describe: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createRevisionBundleQuery } from '#shared/schemas/bundles'
import { revisionParams } from '#shared/schemas/tasks'
import { isBundleSettled, toApiBundle } from '../../../../../services/bundles/mappers'
import { createBundle, reloadBundle } from '../../../../../services/bundles/service'
import { requireUser, resolveTask, resolveTaskRevision } from '../../../../../utils/authz'
import { useConfig } from '../../../../../utils/config'
import { useCollections } from '../../../../../utils/mongo'
import { loadWithWait, reserveWaitFor } from '../../../../../utils/wait'
import { validateParams, validateQuery } from '../../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const params = validateParams(event, revisionParams)
  const { wait, rebuild } = validateQuery(event, createRevisionBundleQuery)
  // Reserved before the bundle is created, so a 429 means nothing was created.
  const reservation = reserveWaitFor(principal.user.id, wait)
  try {
    const revision = await resolveTaskRevision(await resolveTask(principal, params.task), params.revision)
    const { bundle, created } = await createBundle(revision, { rebuild }, useConfig())
    const current =
      (wait ?? 0) > 0
        ? await loadWithWait(event, {
            waitSeconds: wait,
            userId: principal.user.id,
            load: () => reloadBundle(bundle),
            settled: isBundleSettled,
            watch: { collection: useCollections().bundles as never, id: bundle._id },
            reserved: reservation !== null,
          })
        : bundle
    setResponseStatus(event, created ? 201 : 200)
    return toApiBundle(current)
  } finally {
    reservation?.()
  }
})
