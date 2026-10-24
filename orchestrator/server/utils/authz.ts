import type { H3Event } from 'h3'
import type { Collection, Document, Filter } from 'mongodb'
import { isUuid, isValidTaskName } from '#shared/utils/slug'
import type { WorkerRole } from '#shared/utils/enums'
import type { AnalysisDoc, RevisionDoc, ScanDoc, TaskDoc } from '../types/documents'
import { apiError } from './errors'
import { useCollections } from './mongo'
import type {
  NodePrincipal,
  Principal,
  RegistryPrincipal,
  SetupPrincipal,
  ToolsPrincipal,
  UserPrincipal,
  WorkerPrincipal,
} from './principal'

// Ownership helpers (docs/auth.md §9). Route handlers never inspect `event.context.principal` directly. Order of
// checks: authenticate (401), then visibility (404), then operation permission (403). A resource of another user
// is 404 `notFound`, never 403; admins pass ownership checks (except editor routes, which always act on the
// caller). Request objects are never placed into MongoDB filters: ids are validated before use.

function principalOf(event: H3Event): Principal | null {
  return (event.context.principal as Principal | null | undefined) ?? null
}

export function requireUser(event: H3Event, options: { editorKey?: boolean } = {}): UserPrincipal {
  const principal = principalOf(event)
  if (!principal || principal.kind !== 'user') throw apiError('unauthorized', 'authentication required')
  if (options.editorKey === false && principal.apiKey?.configId === 'editor') {
    throw apiError('forbidden', 'the editor API key cannot be used for this operation')
  }
  return principal
}

export function requireAdmin(event: H3Event): UserPrincipal {
  const principal = requireUser(event)
  if (!principal.isAdmin) throw apiError('adminRequired', 'this operation requires an admin')
  return principal
}

export function requireSession(event: H3Event): UserPrincipal {
  const principal = requireUser(event)
  if (principal.via !== 'session') throw apiError('sessionRequired', 'this operation requires a browser session')
  return principal
}

export function requireNode(event: H3Event): NodePrincipal {
  const principal = principalOf(event)
  if (!principal || principal.kind !== 'node') throw apiError('unauthorized', 'node token required')
  return principal
}

export function requireWorker(event: H3Event, options: { role?: WorkerRole } = {}): WorkerPrincipal {
  const principal = principalOf(event)
  if (!principal || principal.kind !== 'worker') throw apiError('unauthorized', 'worker token required')
  if (options.role && principal.worker.role !== options.role) {
    throw apiError('forbidden', `this operation requires the ${options.role} role`)
  }
  return principal
}

/** For scheduler routes: 409 staleEpoch when the request's epoch is not the scan's current one. */
export function assertCurrentEpoch(requestEpoch: number, currentEpoch: number): void {
  if (requestEpoch !== currentEpoch) {
    throw apiError('staleEpoch', `scheduler epoch ${requestEpoch} was superseded`, { currentEpoch })
  }
}

export function requireTools(event: H3Event): ToolsPrincipal {
  const principal = principalOf(event)
  if (!principal || principal.kind !== 'tools') throw apiError('unauthorized', 'tools cookie required')
  return principal
}

export function requireSetup(event: H3Event): SetupPrincipal {
  const principal = principalOf(event)
  if (!principal || principal.kind !== 'setup') throw apiError('setupTokenInvalid', 'setup token required')
  return principal
}

export function requireRegistryCredential(event: H3Event): RegistryPrincipal | NodePrincipal {
  const principal = principalOf(event)
  if (!principal || (principal.kind !== 'registry' && principal.kind !== 'node')) throw apiError('unauthorized', 'registry credential required')
  return principal
}

/**
 * The owner filter of a list operation: `{}` for admins (or `{userId}` when they filter), `{userId: <caller>}`
 * for users. A non-admin passing another user's id gets 403 adminRequired.
 */
export function ownerFilter(principal: UserPrincipal, requestedUserId?: string): { userId?: string } {
  if (principal.isAdmin) return requestedUserId ? { userId: requestedUserId } : {}
  if (requestedUserId && requestedUserId !== principal.user.id) {
    throw apiError('adminRequired', 'only admins may list other users\' resources')
  }
  return { userId: principal.user.id }
}

/**
 * The filter of the caller-only lists `listCredentials` and `listUploads` (docs/api.md §1.3): the caller's own items,
 * for admins too, because only their owner can reference them in a create (`ownedRef`).
 */
export function callerFilter(principal: UserPrincipal): { userId: string } {
  return { userId: principal.user.id }
}

export interface LoadOwnedOptions<T> {
  /** extra visibility rule (for example: tasks being deleted are invisible) */
  visible?: (doc: T) => boolean
  /** name used in the 404 message */
  what?: string
}

/**
 * Loads one owned document with a single query: `{_id}` for admins, `{_id, userId}` for users. A malformed id,
 * a missing document, another user's document or an invisible document are all 404 notFound.
 */
export async function loadOwned<T extends Document & { _id: string; userId: string }>(
  collection: Collection<T>,
  id: string,
  principal: UserPrincipal,
  options: LoadOwnedOptions<T> = {},
): Promise<T> {
  const what = options.what ?? 'resource'
  if (!isUuid(id)) throw apiError('notFound', `${what} not found`)
  const filter = (principal.isAdmin ? { _id: id } : { _id: id, userId: principal.user.id }) as Filter<T>
  const doc = (await collection.findOne(filter)) as T | null
  if (!doc || (options.visible && !options.visible(doc))) throw apiError('notFound', `${what} not found`)
  return doc
}

/**
 * A reference inside a create body (revision, upload, credential): always one of the caller's own documents,
 * even for admins acting on their own behalf; anything else is 404.
 */
export async function ownedRef<T extends Document & { _id: string; userId: string }>(
  collection: Collection<T>,
  id: string,
  principal: UserPrincipal,
  what = 'resource',
): Promise<T> {
  if (!isUuid(id)) throw apiError('notFound', `${what} not found`)
  const doc = (await collection.findOne({ _id: id, userId: principal.user.id } as Filter<T>)) as T | null
  if (!doc) throw apiError('notFound', `${what} not found`)
  return doc
}

const taskVisible = (task: TaskDoc) => !task.deletingAt

/**
 * `{task}`: a task id, or a task name looked up among the caller's tasks only (admins address other users' tasks
 * by id). Tasks being deleted are invisible.
 */
export async function resolveTask(principal: UserPrincipal, ref: string): Promise<TaskDoc> {
  const { tasks } = useCollections()
  if (isUuid(ref)) return loadOwned(tasks, ref.toLowerCase(), principal, { visible: taskVisible, what: 'task' })
  if (!isValidTaskName(ref)) throw apiError('notFound', 'task not found')
  const task = await tasks.findOne({ userId: principal.user.id, name: ref, deletingAt: null })
  if (!task) throw apiError('notFound', 'task not found')
  return task
}

async function latestReadyRevision(task: TaskDoc): Promise<RevisionDoc> {
  const { revisions } = useCollections()
  const revision = await revisions.findOne({ taskId: task._id, state: 'ready' }, { sort: { number: -1 } })
  if (!revision) throw apiError('notFound', `task ${task.name} has no ready revision`)
  return revision
}

/** `{revision}` of a task: a number, `latest` (highest-numbered ready revision) or a revision id. */
export async function resolveTaskRevision(task: TaskDoc, ref: string): Promise<RevisionDoc> {
  const { revisions } = useCollections()
  if (ref === 'latest') return latestReadyRevision(task)
  if (/^\d{1,9}$/.test(ref)) {
    const revision = await revisions.findOne({ taskId: task._id, number: Number(ref) })
    if (!revision) throw apiError('notFound', 'revision not found')
    return revision
  }
  if (isUuid(ref)) {
    const revision = await revisions.findOne({ _id: ref.toLowerCase(), taskId: task._id })
    if (!revision) throw apiError('notFound', 'revision not found')
    return revision
  }
  throw apiError('notFound', 'revision not found')
}

/**
 * A revision reference (body field `revision`, CLI, MCP): `<task>@<N>`, `<task>@latest`, `<task>` (= latest) or
 * a revision id; a bare uuid is tried as a revision id first, then as a task id (`@latest`).
 */
export async function resolveRevisionRef(principal: UserPrincipal, ref: string): Promise<RevisionDoc> {
  const { revisions } = useCollections()
  const at = ref.lastIndexOf('@')
  if (at > 0) {
    const task = await resolveTask(principal, ref.slice(0, at))
    return resolveTaskRevision(task, ref.slice(at + 1))
  }
  if (isUuid(ref)) {
    const id = ref.toLowerCase()
    const revision = await revisions.findOne(principal.isAdmin ? { _id: id } : { _id: id, userId: principal.user.id })
    if (revision) return revision
  }
  const task = await resolveTask(principal, ref)
  return latestReadyRevision(task)
}

export async function loadOwnedScan(principal: UserPrincipal, scanId: string): Promise<ScanDoc> {
  return loadOwned(useCollections().scans, scanId.toLowerCase(), principal, { what: 'scan' })
}

const ANALYSIS_ID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-(\d{1,16})$/

/** `<scanId>-<seq>`: loads the owned scan first, then the analysis of that scan. */
export async function loadOwnedAnalysis(principal: UserPrincipal, analysisId: string): Promise<{ scan: ScanDoc; analysis: AnalysisDoc }> {
  const match = ANALYSIS_ID.exec(analysisId)
  if (!match) throw apiError('notFound', 'analysis not found')
  const scan = await loadOwnedScan(principal, match[1]!)
  const seq = Number(match[2])
  if (!Number.isSafeInteger(seq)) throw apiError('notFound', 'analysis not found')
  const analysis = await useCollections().analyses.findOne({ _id: `${scan._id}-${seq}`, scanId: scan._id })
  if (!analysis) throw apiError('notFound', 'analysis not found')
  return { scan, analysis }
}
