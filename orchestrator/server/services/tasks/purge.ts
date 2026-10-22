import { useCollections } from '../../utils/mongo'
import type { UserPurgeContext, UserPurgeStep } from '../../utils/user-purge'
import { purgeUserDirs } from '../helpers/ops'
import { deleteTaskImages, deleteTaskStorage, deleteTestRuns, STOP_SETTLE_MS, stopTaskWork } from './delete'

// The task-domain steps of the userPurge job (docs/data-model.md §5, server/utils/user-purge.ts): 50 test runs,
// 60 revisions and task images, 70 tasks, 80 the user's workspace and editor-home directories (helper `purge`).
// Every step is idempotent; the user is locked out, so no new tasks, revisions or test runs appear meanwhile.

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

async function stopUserWork({ userId, log, signal }: UserPurgeContext): Promise<boolean> {
  const stopped = await stopTaskWork({ userId }, log)
  if (stopped.running) await sleep(STOP_SETTLE_MS, signal)
  return stopped.buildsRunning
}

export async function purgeUserTestRuns(ctx: UserPurgeContext): Promise<void> {
  await stopUserWork(ctx)
  const count = await deleteTestRuns({ userId: ctx.userId }, ctx.signal)
  ctx.log.info('deleted the test runs of a purged user', { userId: ctx.userId, testRuns: count })
}

export async function purgeUserRevisions(ctx: UserPurgeContext): Promise<void> {
  // The user is locked out, so a restarted step finds no running build: a build stopped by an earlier attempt of this
  // step that still pushed afterwards (rare) is not seen, and only the recorded digests are deleted.
  const buildsStopped = await stopUserWork(ctx)
  const { tasks, revisions } = useCollections()
  const owned = await tasks.find({ userId: ctx.userId }, { projection: { _id: 1 } }).toArray()
  for (const task of owned) {
    ctx.signal.throwIfAborted()
    await deleteTaskImages(task._id, ctx.log, { buildsStopped })
    await deleteTaskStorage(task._id, ctx.signal)
  }
  await revisions.deleteMany({ userId: ctx.userId })
}

export async function purgeUserTasks({ userId }: UserPurgeContext): Promise<void> {
  await useCollections().tasks.deleteMany({ userId })
}

export async function purgeUserWorkspace({ userId }: UserPurgeContext): Promise<void> {
  await purgeUserDirs(userId)
}

export const taskPurgeSteps: UserPurgeStep[] = [
  { name: 'test-runs', order: 50, run: purgeUserTestRuns },
  { name: 'revisions', order: 60, run: purgeUserRevisions },
  { name: 'tasks', order: 70, run: purgeUserTasks },
  { name: 'workspace', order: 80, run: purgeUserWorkspace },
]
