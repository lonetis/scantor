import { defineNitroPlugin } from 'nitropack/runtime'
import { revisionBuildJobKind } from '../services/revisions/build'
import { taskDeleteJobKind } from '../services/tasks/delete'
import { TasksGc } from '../services/tasks/gc'
import { taskPurgeSteps } from '../services/tasks/purge'
import { testRunJobKind } from '../services/test-runs/job'
import { registerComponentTask } from '../utils/boot'
import { registerJobKind } from '../utils/jobs'
import { registerUserPurgeStep } from '../utils/user-purge'

// The tasks area (docs/api.md §4.5–§4.12, docs/tasks.md, docs/editor.md §9):
//   job kinds   revisionBuild and testRun (api component; builds share SCANTOR_BUILD_CONCURRENCY), taskDelete
//               (reconciler component)
//   reconciler  `tasks-gc` under the `gc` lease: orphan helper/test-run/build containers, draft images after
//               SCANTOR_DRAFT_IMAGE_RETENTION, test runs and revisions left without a job (first sweep at start)
//   userPurge   steps 50 test runs, 60 revisions and task images, 70 tasks, 80 workspace directories
// Registration only; nothing runs before boot.

export default defineNitroPlugin(() => {
  registerJobKind('revisionBuild', revisionBuildJobKind)
  registerJobKind('testRun', testRunJobKind)
  registerJobKind('taskDelete', taskDeleteJobKind)
  for (const step of taskPurgeSteps) registerUserPurgeStep(step)

  let gc: TasksGc | null = null
  registerComponentTask({
    component: 'reconciler',
    name: 'tasks-gc',
    start({ config, log }) {
      gc = new TasksGc(config, log.child({ component: 'tasks-gc' }))
      gc.start()
    },
    async stop() {
      await gc?.stop()
      gc = null
    },
  })
})
