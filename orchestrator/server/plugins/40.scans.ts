import { defineNitroPlugin } from 'nitropack/runtime'
import { ScansReconciler } from '../services/reconciler'
import { scanDeleteJobKind } from '../services/scans/delete'
import { cancelScansOfUser } from '../services/scans/lifecycle'
import { userPurgeSteps } from '../services/scans/purge'
import { scanRetryFailedJobKind } from '../services/scans/retry-failed'
import { registerComponentTask } from '../utils/boot'
import { registerJobKind } from '../utils/jobs'
import { registerUserPurgeStep } from '../utils/user-purge'
import { registerUserLockoutHook } from '../utils/users'

// The scans area (docs/api.md §4.13, docs/architecture.md §11.2–§11.3): the reconciler component task (topology,
// scheduler supervision, placement, recount/completion, stall detection, conditions, delete recovery), the
// `scanDelete` and `scanRetryFailed` job kinds, the userPurge steps 10 (cancel scans) and 40 (delete scans), and the
// lockout hook that cancels a banned user's scans when the admin asked for it.

export default defineNitroPlugin(() => {
  registerJobKind('scanDelete', scanDeleteJobKind)
  registerJobKind('scanRetryFailed', scanRetryFailedJobKind)
  for (const step of userPurgeSteps) registerUserPurgeStep(step)
  registerUserLockoutHook({
    name: 'cancelScans',
    // after the editor stop (order 50), as in docs/auth.md §5.7
    order: 60,
    async run(userId, { cancelScans }) {
      if (cancelScans) await cancelScansOfUser(userId)
    },
  })

  let reconciler: ScansReconciler | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'scans-reconciler',
    start({ config, log, signal }) {
      reconciler = new ScansReconciler({ config, log: log.child({ component: 'reconciler' }), signal })
      reconciler.start()
    },
    async stop() {
      await reconciler?.stop()
      reconciler = null
    },
  })
})
