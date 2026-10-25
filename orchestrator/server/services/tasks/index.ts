import type { Filter } from 'mongodb'
import type { CreateTaskBody, ListTasksQuery } from '#shared/schemas/tasks'
import { CUSTOM_TEMPLATE } from '#shared/schemas/tasks'
import type { JobRef, Page } from '#shared/types/common'
import type { Task, TaskWorkspaceStatus } from '#shared/types/tasks'
import type { TaskDoc } from '../../types/documents'
import { ownerFilter } from '../../utils/authz'
import { apiError, validationError } from '../../utils/errors'
import { createJob } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import type { UserPrincipal } from '../../utils/principal'
import { templateNames } from '../catalog/templates'
import { scaffold, snapshotHash } from '../helpers/ops'
import { toJobRef } from '../jobs/mappers'
import { scanUsingTask } from './delete'
import { toApiTask, toWorkspaceStatus } from './mappers'
import { applyWorkspaceSummary, insertTask, newTaskDoc } from './store'

// Tasks (docs/api.md §4.6, docs/tasks.md §12.2, §13): creation from a scaffold, listing, the cached and fresh
// workspace status, and deletion (a `taskDelete` job). Workspace content is only ever touched by helpers.

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function listTasks(principal: UserPrincipal, query: ListTasksQuery): Promise<Page<Task>> {
  const clauses: Filter<TaskDoc>[] = [ownerFilter(principal, query.userId) as Filter<TaskDoc>, { deletingAt: null }]
  if (query.language) clauses.push({ language: query.language })
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i')
    clauses.push({ $or: [{ name: pattern }, { description: pattern }] })
  }
  return findPage(useCollections().tasks, { $and: clauses }, { limit: query.limit, cursor: query.cursor }, toApiTask)
}

/** createTask: inserts the task (`source.kind = scaffold`) and renders the scaffold into `<userId>/<name>/`. */
export async function createTask(principal: UserPrincipal, body: CreateTaskBody): Promise<Task> {
  if (body.template !== CUSTOM_TEMPLATE && !(await templateNames()).includes(body.template)) {
    throw validationError([{ path: 'template', message: `unknown template "${body.template}"` }])
  }
  const doc = await insertTask(
    newTaskDoc({
      userId: principal.user.id,
      name: body.name,
      language: body.language,
      description: body.description || null,
      source: { kind: 'scaffold', template: body.template },
    }),
  )
  try {
    const { workspace } = await scaffold(principal.user.id, {
      task: doc.name,
      language: doc.language,
      template: body.template,
      description: body.description || undefined,
    })
    const updated = await applyWorkspaceSummary(doc._id, workspace)
    return toApiTask(updated ?? doc)
  } catch (error) {
    await useCollections()
      .tasks.deleteOne({ _id: doc._id, revisionSeq: 0 })
      .catch((deleteError: unknown) => useLogger('tasks').error('removing a task whose scaffold failed failed', { taskId: doc._id, err: deleteError }))
    throw error
  }
}

/** getTaskWorkspace: a fresh `snapshot --hash-only`, which also refreshes the cached `tasks.workspace`. */
export async function getWorkspaceStatus(task: TaskDoc): Promise<TaskWorkspaceStatus> {
  const summary = await snapshotHash(task.userId, task.name)
  if (!summary) throw apiError('notFound', `the workspace folder of task ${task.name} does not exist`)
  const updated = await applyWorkspaceSummary(task._id, summary)
  return toWorkspaceStatus(updated ?? task, summary, updated?.workspace.checkedAt ?? new Date())
}

/**
 * deleteTask: 409 taskInUse while a non-terminal scan uses the task; otherwise the task becomes invisible at once
 * (`deletingAt`) and a `taskDelete` job removes the workspace folder, revisions, snapshots, images and test runs.
 * The mark is written before the scans are checked (a found scan rolls it back): from the mark on, revision
 * references no longer resolve, so no scan can start on the task; a start that resolved just before the mark and
 * is inserted after this check is caught by the job, which waits for such scans before removing revisions or images.
 */
export async function requestTaskDeletion(task: TaskDoc): Promise<JobRef> {
  const { tasks } = useCollections()
  const deletingAt = new Date()
  const marked = await tasks.findOneAndUpdate({ _id: task._id, deletingAt: null }, { $set: { deletingAt, updatedAt: deletingAt } }, { returnDocument: 'after' })
  if (!marked) throw apiError('notFound', 'task not found')
  const active = await scanUsingTask(task._id)
  if (active) {
    await tasks.updateOne({ _id: task._id, deletingAt }, { $set: { deletingAt: null, updatedAt: new Date() } })
    throw apiError('taskInUse', `scan ${active._id} (${active.state}) uses task ${task.name}`, { scanId: active._id })
  }
  const { job } = await createJob({ kind: 'taskDelete', userId: task.userId, subject: { kind: 'task', id: task._id }, params: {} })
  return toJobRef(job)
}
