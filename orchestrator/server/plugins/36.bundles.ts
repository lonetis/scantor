import { defineNitroPlugin } from 'nitropack/runtime'
import { bundleJobKind } from '../services/bundles/job'
import { registerJobKind } from '../utils/jobs'

// The bundles area (docs/data-model.md §4.21, docs/tasks.md §9.11): the `bundle` job kind (api component; bundles
// share the build slots of SCANTOR_BUILD_CONCURRENCY, one per user at a time). Task deletion, the user purge and the
// tasks GC remove bundles, their archives and leftover `scantor-bundle/*` tags (services/tasks). Registration only;
// nothing runs before boot.

export default defineNitroPlugin(() => {
  registerJobKind('bundle', bundleJobKind)
})
