import { defineNitroPlugin } from 'nitropack/runtime'
import { closeAssignmentWaiters } from '../services/nodes/assignments'
import { upsertBuiltinNode } from '../services/nodes/builtin'
import { detectOfflineNodes, OfflineDetector } from '../services/nodes/offline'
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
//   reconciler  node offline detection (workers → lost; placement replaces them), every 10 s under `reconciler`; silence
//               counts only after the detector's grace (OfflineDetector: lock acquired, late tick, MongoDB outage) and
//               never once the shutdown began
//   reconciler  registry garbage collection every SCANTOR_REGISTRY_GC_INTERVAL under `registryGc`
//   api         assignment long-poll waiters (the long-polls answer when the shutdown begins; the change stream closes on stop)

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
  let offlineDetector: OfflineDetector | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'node-offline-detection',
    start({ config, log, signal }) {
      const detector = new OfflineDetector({
        offlineAfterMs: config.nodeOfflineAfterMs,
        tickMs: OFFLINE_TICK_MS,
        detect: () => detectOfflineNodes(config.nodeOfflineAfterMs, log),
        log,
      })
      offlineDetector = detector
      offlineLock = new LeaseLock(useCollections().locks, 'reconciler', {
        logger: log,
        onAcquired: () => detector.acquired(),
        onLost: () => detector.lost(),
      })
      offlineLock.start()
      offlineTimer = setInterval(() => {
        // The signal aborts when the shutdown begins: from then on this process may receive no status.
        if (offlineLock?.held && !signal.aborted) detector.tick()
      }, OFFLINE_TICK_MS)
    },
    async stop() {
      if (offlineTimer) clearInterval(offlineTimer)
      offlineTimer = null
      await offlineDetector?.stop()
      offlineDetector = null
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
