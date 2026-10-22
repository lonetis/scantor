import { defineNitroPlugin } from 'nitropack/runtime'
import { closeAssignmentWaiters } from '../services/nodes/assignments'
import { upsertBuiltinNode } from '../services/nodes/builtin'
import { detectOfflineNodes } from '../services/nodes/offline'
import { plaintextPublicEndpoints } from '../services/nodes/transport'
import { writeRegistryAuthFiles } from '../services/registry/files'
import { RegistryGcLoop } from '../services/registry/gc'
import { registerBootStep, registerComponentTask } from '../utils/boot'
import { useKeys } from '../utils/keys'
import { LeaseLock } from '../utils/locks'
import { useCollections } from '../utils/mongo'

// Nodes, runtime and registry (docs/nodes.md, docs/architecture.md §4.1):
//   boot 610  jwks.json + http-secret into the scantor-registry-auth volume
//   boot 620  built-in node upsert (tokenHash of the derived built-in node token)
//   boot 625  warning about plaintext public endpoints that remote nodes would refuse (docs/nodes.md §11)
//   reconciler  node offline detection (workers → lost; placement replaces them), every 10 s under `reconciler`
//   reconciler  registry garbage collection every SCANTOR_REGISTRY_GC_INTERVAL under `registryGc`
//   api         assignment long-poll waiters (closed on stop)

const OFFLINE_TICK_MS = 10_000

export default defineNitroPlugin(() => {
  registerBootStep({
    name: 'registry-auth-files',
    order: 610,
    async run({ log }) {
      await writeRegistryAuthFiles(useKeys(), log)
    },
  })

  registerBootStep({
    name: 'builtin-node',
    order: 620,
    async run({ log }) {
      await upsertBuiltinNode(useKeys(), log)
    },
  })

  registerBootStep({
    name: 'node-endpoints',
    order: 625,
    async run({ config, log }) {
      if (config.allowInsecureTransport) return
      for (const endpoint of await plaintextPublicEndpoints(config)) {
        if (endpoint.address === null) {
          log.info('a plaintext public endpoint does not resolve from the orchestrator; remote nodes refuse plaintext to public hosts', { variable: endpoint.variable })
          continue
        }
        log.warn('a public endpoint is plaintext on a public address: remote nodes and their workers refuse it unless they run with SCANTOR_ALLOW_INSECURE_TRANSPORT=true; serve it over TLS (Traefik)', {
          variable: endpoint.variable,
          address: endpoint.address,
        })
      }
    },
  })

  let offlineTimer: NodeJS.Timeout | null = null
  let offlineLock: LeaseLock | null = null
  let offlineTick: Promise<unknown> | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'node-offline-detection',
    start({ config, log }) {
      offlineLock = new LeaseLock(useCollections().locks, 'reconciler', { logger: log })
      offlineLock.start()
      offlineTimer = setInterval(() => {
        if (!offlineLock?.held || offlineTick) return
        offlineTick = detectOfflineNodes(config.nodeOfflineAfterMs, log)
          .catch((error: unknown) => log.error('node offline detection failed', { err: error }))
          .finally(() => {
            offlineTick = null
          })
      }, OFFLINE_TICK_MS)
    },
    async stop() {
      if (offlineTimer) clearInterval(offlineTimer)
      offlineTimer = null
      await offlineTick
      await offlineLock?.stop()
      offlineLock = null
    },
  })

  let gcLoop: RegistryGcLoop | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'registry-gc',
    start({ config, log }) {
      const { locks, jobs } = useCollections()
      gcLoop = new RegistryGcLoop(config.registryGcIntervalMs, { locks, jobs, log })
      gcLoop.start()
    },
    async stop() {
      await gcLoop?.stop()
      gcLoop = null
    },
  })

  registerComponentTask({
    component: 'api',
    name: 'node-assignment-waiters',
    start() {},
    async stop() {
      await closeAssignmentWaiters()
    },
  })
})
