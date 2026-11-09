import { registerJobKind } from '../../utils/jobs'
import { registerUserPurgeStep } from '../../utils/user-purge'
import { scriptDeleteJobKind } from './delete'
import { scriptPurgeSteps } from './purge'

// Registration of the scripts area (docs/scripts.md), called synchronously by server/plugins/35.scripts.ts: the
// scriptDelete job kind (reconciler) and the user purge step 65 (script runs, images and scripts). No I/O here.

export function registerScriptsDomain(): void {
  registerJobKind('scriptDelete', scriptDeleteJobKind)
  for (const step of scriptPurgeSteps) registerUserPurgeStep(step)
}
