import type { Filter } from 'mongodb'
import { ACTIVE_SCAN_STATES } from '#shared/utils/enums'
import type { JobDoc, ScanDoc, TaskDoc, TestRunDoc } from '../../types/documents'
import { FatalJobError, type JobContext, JobDeferredError, type JobKindDefinition, cancelActiveJobs } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { deleteObject, deletePrefix } from '../../utils/s3'
import { deleteTaskFolder } from '../helpers/ops'
import { platformError } from '../pipeline/events'
import { failRevision } from '../revisions/build'
import { deleteTaskManifests, removeLocalTaskImages } from '../revisions/images'
import { ACTIVE_TEST_RUN_STATES } from '../test-runs'
import { requestCancellation } from '../test-runs/live'

// Task deletion (docs/api.md §4.6 deleteTask, docs/data-model.md §4.12 `taskDelete`): the API hides the task at once
// (`deletingAt`); this job (reconciler component, cursor `{phase}`) then stops the task's builds and test runs,
// deletes its test runs, its registry manifests and local images, its snapshots and build logs, its revisions, the
// workspace folder (helper `delete-files --path "" --recursive`) and finally the task document. Every phase is
// idempotent, so a job restarted after a lease expiry resumes at its phase. A scan that started while the deletion
// was being requested keeps the revisions and images it runs on: the job defers itself before removing them until no
// non-terminal scan uses the task. The same building blocks serve the userPurge steps 50–80 (./purge.ts).

export const TASK_DELETE_PHASES = ['stop', 'testRuns', 'images', 'storage', 'revisions', 'workspace', 'task'] as const
export type TaskDeletePhase = (typeof TASK_DELETE_PHASES)[number]

/** How long stopped builds get to notice their cancellation (the jobs runner renews leases every 10 s). */
export const STOP_SETTLE_MS = 20_000

const TASK_DELETED = 'the task was deleted'

/** How long the job waits before it checks again whether a scan still uses the task. */
export const SCAN_IN_USE_RECHECK_MS = 60_000

/** Phases that remove what a running scan needs (its revision documents and images). */
const SCAN_GUARDED_PHASES: ReadonlySet<TaskDeletePhase> = new Set(['images', 'revisions'])

/** A non-terminal (or deleting) scan of the task, which blocks its deletion (409 taskInUse at request time). */
export async function scanUsingTask(taskId: string): Promise<Pick<ScanDoc, '_id' | 'state'> | null> {
  return useCollections().scans.findOne({ 'task.id': taskId, state: { $in: [...ACTIVE_SCAN_STATES, 'deleting'] } }, { projection: { _id: 1, state: 1 } })
}

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

export interface StoppedWork {
  /** a job was running: the caller waits for it to notice before deleting what it might still write */
  running: boolean
}

/**
 * Stops the work of the matching revisions and test runs: unfinished revisions fail ("the task was deleted"), active
 * test runs are cancelled, and their jobs are cancelled.
 */
export async function stopTaskWork(filter: { taskId: string } | { userId: string }, log: Logger): Promise<StoppedWork> {
  const { revisions, testRuns, jobs } = useCollections()
  let running = false
  const unfinished = await revisions.find({ ...filter, state: { $in: ['queued', 'building'] } }, { projection: { _id: 1 } }).toArray()
  for (const revision of unfinished) {
    running = (await jobs.countDocuments({ kind: 'revisionBuild', 'subject.id': revision._id, state: 'running' })) > 0 || running
    await cancelActiveJobs('revisionBuild', revision._id)
    await failRevision(revision._id, [platformError(TASK_DELETED)], log)
  }
  const active = await testRuns.find({ ...filter, state: { $in: [...ACTIVE_TEST_RUN_STATES] } } as Filter<TestRunDoc>, { projection: { _id: 1 } }).toArray()
  const now = new Date()
  for (const testRun of active) {
    running = (await jobs.countDocuments({ kind: 'testRun', 'subject.id': testRun._id, state: 'running' })) > 0 || running
    await testRuns.updateOne(
      { _id: testRun._id, state: { $in: [...ACTIVE_TEST_RUN_STATES] } },
      { $set: { state: 'cancelled', finishedAt: now, updatedAt: now }, $unset: { 'secrets.request': '' } },
    )
    requestCancellation(testRun._id)
    await cancelActiveJobs('testRun', testRun._id)
  }
  return { running }
}

/** Deletes the matching test runs with their analyses and S3 objects (logs and files). */
export async function deleteTestRuns(filter: { taskId: string } | { userId: string }, signal: AbortSignal): Promise<number> {
  const { testRuns, testRunAnalyses } = useCollections()
  const ids = (await testRuns.find(filter, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id)
  for (const id of ids) {
    signal.throwIfAborted()
    await deletePrefix(`test-runs/${id}/`)
    await testRunAnalyses.deleteMany({ testRunId: id })
  }
  await testRuns.deleteMany({ _id: { $in: ids } })
  return ids.length
}

/**
 * Whether a deletion stopped a build of the task after it had started (the revision failed with "the task was
 * deleted" and has a `startedAt`): such a build may have pushed a manifest that no revision records. It is read from
 * the revisions, so a restarted taskDelete job or a later userPurge step that stops nothing itself still knows it.
 */
async function hadStoppedBuild(taskId: string): Promise<boolean> {
  const failed = await useCollections().revisions.find({ taskId, state: 'failed', image: null, startedAt: { $ne: null } }, { projection: { errors: 1 } }).toArray()
  return failed.some((revision) => revision.errors.some((error) => error.message === TASK_DELETED))
}

/**
 * Deletes a task's registry manifests and its local revision and draft images. The registry is contacted only when
 * the task has pushed images or a stopped build might still have pushed one, so deleting a task that never published
 * an image does not depend on the registry.
 */
export async function deleteTaskImages(taskId: string, log: Logger): Promise<void> {
  const revisions = await useCollections().revisions.find({ taskId, 'image.digest': { $type: 'string' } }, { projection: { image: 1 } }).toArray()
  const digests = revisions.map((revision) => revision.image?.digest).filter((digest): digest is string => typeof digest === 'string')
  if (digests.length > 0 || (await hadStoppedBuild(taskId))) await deleteTaskManifests(taskId, digests, log)
  await removeLocalTaskImages(taskId, log)
}

/** Deletes a task's snapshots and the build logs of its revisions. */
export async function deleteTaskStorage(taskId: string, signal: AbortSignal): Promise<void> {
  await deletePrefix(`snapshots/${taskId}/`)
  const revisions = await useCollections().revisions.find({ taskId }, { projection: { buildLogKey: 1 } }).toArray()
  for (const revision of revisions) {
    signal.throwIfAborted()
    await deleteObject(revision.buildLogKey)
  }
}

async function loadTask(job: JobDoc): Promise<TaskDoc | null> {
  return useCollections().tasks.findOne({ _id: job.subject.id })
}

async function runPhase(phase: TaskDeletePhase, task: TaskDoc, ctx: JobContext): Promise<void> {
  const { revisions, tasks } = useCollections()
  if (SCAN_GUARDED_PHASES.has(phase)) {
    const scan = await scanUsingTask(task._id)
    if (scan) throw new JobDeferredError(new Date(Date.now() + SCAN_IN_USE_RECHECK_MS), `scan ${scan._id} (${scan.state}) still uses the task`)
  }
  switch (phase) {
    case 'stop': {
      const stopped = await stopTaskWork({ taskId: task._id }, ctx.log)
      if (stopped.running) await sleep(STOP_SETTLE_MS, ctx.signal)
      return
    }
    case 'testRuns':
      await deleteTestRuns({ taskId: task._id }, ctx.signal)
      return
    case 'images':
      await deleteTaskImages(task._id, ctx.log)
      return
    case 'storage':
      await deleteTaskStorage(task._id, ctx.signal)
      return
    case 'revisions':
      await revisions.deleteMany({ taskId: task._id })
      return
    case 'workspace':
      await deleteTaskFolder(task.userId, task.name)
      return
    case 'task':
      await tasks.deleteOne({ _id: task._id, deletingAt: { $ne: null } })
      return
  }
}

export const taskDeleteJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 2,
  maxAttempts: 10,
  backoff: { initialMs: 10_000, maxMs: 300_000 },
  async handler(job, ctx) {
    if (job.subject.kind !== 'task') throw new FatalJobError('invalidSubject', `taskDelete needs a task subject, got ${job.subject.kind}`)
    const task = await loadTask(job)
    if (!task) return
    if (!task.deletingAt) throw new FatalJobError('invalidState', `task ${task._id} is not being deleted`)
    const resume = TASK_DELETE_PHASES.indexOf(job.cursor.phase as TaskDeletePhase)
    for (let index = Math.max(0, resume); index < TASK_DELETE_PHASES.length; index++) {
      const phase = TASK_DELETE_PHASES[index]!
      ctx.signal.throwIfAborted()
      await ctx.saveCursor({ phase }, { done: index, total: TASK_DELETE_PHASES.length })
      await runPhase(phase, task, ctx)
    }
    await ctx.setProgress(TASK_DELETE_PHASES.length, TASK_DELETE_PHASES.length)
    ctx.log.info('task deleted', { taskId: task._id, name: task.name, userId: task.userId })
  },
}
