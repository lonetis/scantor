import { defineNitroPlugin } from 'nitropack/runtime'
import { registerScriptRunsDomain } from '../services/script-runs/register'
import { registerScriptRuntimeDomain } from '../services/script-runtime/register'
import { registerScriptsDomain } from '../services/scripts/register'
import { registerBootStep } from '../utils/boot'
import { useScriptNetwork } from '../utils/script-network'

// The scripts area (docs/scripts.md): scripts, script runs and the script runtime API.
//   boot 650    the subnets of the Docker network scantor-scripts for the peer restriction of /api/script-runtime/*;
//               a missing network is a warning, and the API refuses every request until it exists (fail closed)
//   domains     job kinds scriptRun (api) and scriptDelete (reconciler), the `scripts-gc` component task under
//               `scriptsGc`, user purge steps, the lockout hook, wait watchers and event sink bits
// Registration only; nothing runs before boot.

export default defineNitroPlugin(() => {
  registerBootStep({
    name: 'scripts-network',
    order: 650,
    async run() {
      // Never fails the boot: the network belongs to the compose file, and the check stays closed while it is missing.
      await useScriptNetwork().refresh()
    },
  })

  registerScriptsDomain()
  registerScriptRunsDomain()
  registerScriptRuntimeDomain()
})
