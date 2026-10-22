import { defineNitroPlugin } from 'nitropack/runtime'
import { Ingestor } from '../services/ingestor'
import { exportJobKind } from '../services/exports/job'
import { measureRequest } from '../services/metrics/http'
import { tryCompleteScan } from '../services/scans/completion'
import { pauseScanBySystem } from '../services/scans/lifecycle'
import { registerComponentTask } from '../utils/boot'
import { registerJobKind } from '../utils/jobs'

// Results area (docs/architecture.md §4.1): the ingestor component task, the `export` job kind (reconciler
// component) and the HTTP request metrics of /api/metrics. Registration only; nothing runs before boot.

export default defineNitroPlugin((nitroApp) => {
  registerJobKind('export', exportJobKind)

  let ingestor: Ingestor | null = null
  registerComponentTask({
    component: 'ingestor',
    name: 'ingestor',
    async start({ config, log }) {
      ingestor = new Ingestor({ config, log: log.child({ component: 'ingestor' }), hooks: { pauseScanBySystem, tryCompleteScan } })
      await ingestor.start()
    },
    async stop() {
      await ingestor?.stop()
      ingestor = null
    },
  })

  nitroApp.hooks.hook('request', measureRequest)
})
