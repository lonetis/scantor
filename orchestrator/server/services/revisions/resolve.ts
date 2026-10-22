import type { RevisionDoc } from '../../types/documents'
import { resolveRevisionRef as resolveVisibleRevision } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'

// Revision references in create bodies (docs/api.md §1.4, §5.1 steps 2–3): `<task>@<N>`, `<task>@latest`, `<task>`
// (= latest) or a revision id. A top-level create may reference only the caller's own revisions, also for admins
// (docs/api.md §1.3), so a revision of another user is 404. A resolved revision must be `ready`, else 409
// revisionNotReady; `@latest` of a task whose revisions are all still building or failed is revisionNotReady as well.

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'notFound'
}

/** The task part of a reference when it addresses `@latest` (explicitly or as a bare name/id). */
function latestTaskPart(ref: string): string | null {
  const at = ref.lastIndexOf('@')
  if (at > 0) return ref.slice(at + 1) === 'latest' ? ref.slice(0, at) : null
  return ref
}

export async function resolveRevisionRef(user: UserPrincipal, ref: string): Promise<RevisionDoc> {
  let revision: RevisionDoc
  try {
    revision = await resolveVisibleRevision(user, ref)
  } catch (error) {
    if (!isNotFound(error)) throw error
    await assertLatestNotReady(user, ref)
    throw error
  }
  if (revision.userId !== user.user.id) throw apiError('notFound', 'revision not found')
  if (revision.state !== 'ready') {
    throw apiError('revisionNotReady', `revision ${revision.taskName}@${revision.number} is ${revision.state}`, {
      state: revision.state,
      allowed: ['ready'],
    })
  }
  return revision
}

/** For `@latest` without a ready revision: 409 revisionNotReady when the caller's task has unfinished revisions. */
async function assertLatestNotReady(user: UserPrincipal, ref: string): Promise<void> {
  const taskPart = latestTaskPart(ref)
  if (!taskPart) return
  const { tasks } = useCollections()
  const task = await tasks.findOne({ userId: user.user.id, deletingAt: null, $or: [{ name: taskPart }, { _id: taskPart.toLowerCase() }] })
  const latest = task?.latestRevision
  if (latest && latest.state !== 'ready') {
    throw apiError('revisionNotReady', `task ${task.name} has no ready revision; its latest revision @${latest.number} is ${latest.state}`, {
      state: latest.state,
      allowed: ['ready'],
    })
  }
}
