import { toNodeListener } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'
import { ensureGlobalTopology } from '../utils/amqp'
import { deleteUndecryptableJwks, ensureAuthIndexes, useAuth } from '../utils/auth'
import { BootAbortError, registerBootStep, resetBootRegistry, retryUntil } from '../utils/boot'
import { loadBootConfiguration } from '../utils/config'
import {
  EDITOR_HOME_VOLUME,
  ensureEgressNetwork,
  ensureVolume,
  pullImageInBackground,
  scantorImageRef,
  WORKSPACES_VOLUME,
} from '../utils/docker'
import { resetJobKinds } from '../utils/jobs'
import { configureLogger, useLogger } from '../utils/logger'
import { closeLoopbackListener, setLoopbackHandler } from '../utils/loopback'
import { connectMongo, prepareDatabase } from '../utils/mongo'
import { setOpenApiDocumentLoader, type OpenApiDocument, useOperationRegistry } from '../utils/operations'
import { ensureBucket } from '../utils/s3'
import { ensureFirstAdmin } from '../utils/setup'
import { resetUserLockoutHooks } from '../utils/users'
import { resetUserPurgeSteps } from '../utils/user-purge'

// First Nitro plugin: resets the registries (server/utils/boot.ts) and registers the foundation boot steps 1–6 of
// docs/architecture.md §4.1. Domain plugins (20-89) add their steps; server/plugins/99.start.ts runs them.

const processHandlersKey = '__scantorProcessHandlers'

export default defineNitroPlugin((nitroApp) => {
  resetBootRegistry()
  resetJobKinds()
  resetUserPurgeSteps()
  resetUserLockoutHooks()

  setOpenApiDocumentLoader(async () => {
    const response = await nitroApp.localFetch('/api/docs/openapi.json')
    if (!response.ok) throw new Error(`loading the OpenAPI document failed: HTTP ${response.status}`)
    return (await response.json()) as OpenApiDocument
  })

  // The MCP bridge reaches this process's app through the private loopback listener (server/utils/loopback.ts).
  setLoopbackHandler(toNodeListener(nitroApp.h3App))
  nitroApp.hooks.hook('close', closeLoopbackListener)

  const global = globalThis as typeof globalThis & { [processHandlersKey]?: boolean }
  if (!global[processHandlersKey]) {
    global[processHandlersKey] = true
    const log = useLogger('process')
    process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', { err: reason }))
    process.on('uncaughtException', (error) => log.error('uncaught exception', { err: error }))
  }

  registerBootStep({
    name: 'configuration',
    order: 100,
    run({ log }) {
      const { config, warnings, guard } = loadBootConfiguration()
      configureLogger({ level: config.logLevel, format: config.logFormat })
      for (const warning of warnings) log.warn('invalid configuration value', { variable: warning.variable, problem: warning.message })
      if (config.trustProxy && !config.composeProfiles.includes('traefik')) {
        log.warn('SCANTOR_TRUST_PROXY=true without the traefik profile: direct requests can spoof their client IP')
      }
      switch (guard.outcome) {
        case 'abort':
          throw new BootAbortError(guard.message)
        case 'warn':
          for (const name of guard.offenders) log.warn('insecure secret allowed by SCANTOR_ALLOW_INSECURE_DEFAULTS', { variable: name })
          break
        case 'development':
          log.info(guard.message)
          break
        case 'ok':
          break
      }
      log.info('configuration loaded', { components: config.components, publicUrl: config.publicUrl, publicMode: guard.publicMode })
    },
  })

  registerBootStep({
    name: 'mongodb',
    order: 200,
    async run({ log }) {
      await connectMongo({ log })
      await prepareDatabase(log)
    },
  })

  registerBootStep({
    name: 'auth',
    order: 300,
    async run({ log }) {
      await useAuth().$context
      await ensureAuthIndexes(log)
      await deleteUndecryptableJwks(log)
      await ensureFirstAdmin(log)
    },
  })

  registerBootStep({
    name: 's3',
    order: 400,
    async run({ log }) {
      await retryUntil('ensuring the S3 bucket', () => ensureBucket(log), { log })
    },
  })

  registerBootStep({
    name: 'rabbitmq',
    order: 500,
    async run({ log }) {
      await retryUntil('ensuring the RabbitMQ topology', () => ensureGlobalTopology(log), { log })
    },
  })

  registerBootStep({
    name: 'docker-objects',
    order: 630,
    async run({ log }) {
      await retryUntil(
        'ensuring the Docker network and volumes',
        async () => {
          await ensureEgressNetwork(log)
          await ensureVolume(WORKSPACES_VOLUME, log)
          await ensureVolume(EDITOR_HOME_VOLUME, log)
        },
        { log },
      )
    },
  })

  registerBootStep({
    name: 'editor-image',
    order: 640,
    run({ config, log }) {
      // Locally built images (empty prefix) are never pulled.
      if (config.imagePrefix) pullImageInBackground(scantorImageRef('scantor-editor'), log)
    },
  })

  registerBootStep({
    name: 'operation-registry',
    order: 690,
    async run({ log }) {
      const registry = await useOperationRegistry()
      for (const problem of registry.problems) log.error('OpenAPI document problem', { problem })
      for (const operation of registry.operations) {
        if (operation.problems.length > 0) {
          log.error('operation is misconfigured and will answer 403', { operationId: operation.operationId, problems: operation.problems })
        }
      }
      log.info('operation registry built', { operations: registry.operations.length })
    },
  })
})
