import { registerComponentTask } from '../../utils/boot'
import { registerJobKind } from '../../utils/jobs'
import { registerUserPurgeStep } from '../../utils/user-purge'
import { registerUserLockoutHook } from '../../utils/users'
import { ScriptsGc } from '../scripts/gc'
import { cancelActiveScriptRuns } from './cleanup'
import { scriptRunJobKind } from './job'

// Registration of the script-run lifecycle (docs/scripts.md), called synchronously by server/plugins/35.scripts.ts:
//   job kind    scriptRun (api component)
//   reconciler  `scripts-gc` under the `scriptsGc` lease (stale runs, orphan containers, old images, expired runs)
//   userPurge   step 15 cancels the user's active script runs (their data goes in step 65 of the scripts area)
//   lockout     a banned or deleted user's active script runs are cancelled
// The wait watchers need no registration (utils/wait-watchers.ts watches any collection); the events go through
// writeEvent, so the notification sink sees them. No I/O here.

export const USER_LOCKED_OUT = 'the user was locked out'

export function registerScriptRunsDomain(): void {
  registerJobKind('scriptRun', scriptRunJobKind)
  registerUserPurgeStep({
    name: 'cancel-script-runs',
    order: 15,
    async run({ userId }) {
      await cancelActiveScriptRuns({ userId }, USER_LOCKED_OUT)
    },
  })
  registerUserLockoutHook({
    name: 'cancelScriptRuns',
    // with the editor stop (50) and before the scans (60): a locked-out user's runs stop reading at once
    order: 55,
    async run(userId) {
      await cancelActiveScriptRuns({ userId }, USER_LOCKED_OUT)
    },
  })

  let gc: ScriptsGc | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'scripts-gc',
    start({ config, log }) {
      gc = new ScriptsGc(config, log.child({ component: 'scripts-gc' }))
      gc.start()
    },
    async stop() {
      await gc?.stop()
      gc = null
    },
  })
}
