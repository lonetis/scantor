import { defineNitroPlugin } from 'nitropack/runtime'
import { useEditorRuntime } from '../services/editor'
import { REAPER_INTERVAL_MS } from '../services/editor/reaper'
import { registerBootStep, registerComponentTask, retryUntil } from '../utils/boot'
import { LeaseLock } from '../utils/locks'
import { useCollections } from '../utils/mongo'
import { registerUserPurgeStep } from '../utils/user-purge'
import { registerUserLockoutHook } from '../utils/users'

// The editor's background work (docs/editor.md §6.3–§6.4, docs/data-model.md §5, docs/auth.md §5.7):
//   - boot step 700: the reaper's sweep once before the API serves editor sessions (process with the `api`
//     component; `starting`/`stopping` documents of the previous process are cleaned up at once)
//   - reconciler task `editor-reaper`: the sweep every 60 s under the `reconciler` lease
//   - userPurge step 20: stop the editor, delete its keys and its document
//   - lockout hook: a ban or deletion stops the editor (deleting its key) at once

export default defineNitroPlugin(() => {
  registerBootStep({
    name: 'editor-sweep',
    order: 700,
    async run({ config, log }) {
      if (!config.components.includes('api')) return
      const report = await retryUntil('the editor boot sweep', () => useEditorRuntime().reaper.sweep({ staleTransitions: true }), { log })
      if (report.errors > 0) log.warn('the editor boot sweep finished with errors; the reaper retries', { errors: report.errors })
    },
  })

  let lock: LeaseLock | null = null
  let timer: NodeJS.Timeout | null = null
  let sweeping: Promise<void> | null = null

  registerComponentTask({
    component: 'reconciler',
    name: 'editor-reaper',
    start({ log }) {
      const tick = () => {
        if (sweeping || !lock?.held) return
        sweeping = useEditorRuntime()
          .reaper.sweep({ staleTransitions: false })
          .then(
            () => undefined,
            (error: unknown) => log.error('editor reaper sweep failed', { err: error }),
          )
          .finally(() => {
            sweeping = null
          })
      }
      // onAcquired fires before `held` flips, so the first sweep runs on the next turn of the event loop.
      lock = new LeaseLock(useCollections().locks, 'reconciler', { logger: log, onAcquired: () => setImmediate(tick) })
      lock.start()
      timer = setInterval(tick, REAPER_INTERVAL_MS)
      timer.unref()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await sweeping
      await lock?.stop()
      lock = null
    },
  })

  registerUserPurgeStep({
    name: 'editor',
    order: 20,
    async run({ userId }) {
      await useEditorRuntime().manager.purge(userId)
    },
  })

  registerUserLockoutHook({
    name: 'editor',
    order: 50,
    async run(userId, { reason }) {
      const runtime = useEditorRuntime()
      runtime.codes.revokeUser(userId)
      await runtime.manager.stop(userId, reason === 'ban' ? 'banned' : 'userDeleted')
    },
  })
})
