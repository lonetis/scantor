import { registerComponentTask } from '../../utils/boot'
import { flushAllScriptRunState } from './state'

// Registration of the script runtime API's background parts (docs/scripts.md), called synchronously by
// server/plugins/35.scripts.ts. The throttled progress and checkpoint writers (./state.ts) need no loop of their own:
// their timers write a pending value when its interval ends. The `script-runtime-state` task writes every pending
// value when the api component stops, so a restart loses none. No I/O here.

export function registerScriptRuntimeDomain(): void {
  registerComponentTask({
    component: 'api',
    name: 'script-runtime-state',
    start() {},
    async stop() {
      await flushAllScriptRunState()
    },
  })
}
