import { defineNitroPlugin } from 'nitropack/runtime'
import { JobsRunner } from '../services/jobs/runner'
import { registerFoundationPurgeSteps, userPurgeJobKind } from '../services/jobs/user-purge'
import { registerComponentTask } from '../utils/boot'
import { jobKindsOf, registerJobKind } from '../utils/jobs'
import { useCollections } from '../utils/mongo'

// Foundation component tasks (docs/architecture.md §4.1): one jobs runner per component that runs job kinds (`api`
// for revisionBuild/testRun, `reconciler` for the others), plus the generic userPurge job kind and its foundation
// purge steps. Kinds registered by later plugins are picked up because runners read the registry at start.

export default defineNitroPlugin(() => {
  registerJobKind('userPurge', userPurgeJobKind)
  registerFoundationPurgeSteps()

  for (const component of ['api', 'reconciler'] as const) {
    let runner: JobsRunner | null = null
    registerComponentTask({
      component,
      name: `jobs-runner-${component}`,
      start({ config, log }) {
        runner = new JobsRunner({ component, jobs: useCollections().jobs, kinds: jobKindsOf(component), config, log: log.child({ component: 'jobs' }) })
        runner.start()
      },
      async stop() {
        await runner?.stop()
        runner = null
      },
    })
  }
})
