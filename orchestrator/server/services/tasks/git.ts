import { randomUUID } from 'node:crypto'
import type { ImportGitBody } from '#shared/schemas/tasks'
import type { GitImportCandidate } from '#shared/types/tasks'
import type { TaskDoc } from '../../types/documents'
import { useConfig } from '../../utils/config'
import { apiError, invalidState } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import { isKnownLanguage } from '../catalog/languages'
import { assertOwnCredential, credentialForGit } from '../credentials'
import { commit, discard, gitClone, gitPull, type GitHelperAccess } from '../helpers/ops'
import { HelperError, isHelperCode, mapHelperError } from '../helpers/protocol'
import type { GitCandidate, HelperOp, WorkspaceSummary } from '../helpers/types'
import { checkGitUrl } from './git-url'
import { applyWorkspaceSummary, insertTask, newTaskDoc } from './store'

// Git import and pull (docs/tasks.md §14, docs/editor.md §9.7, docs/api.md §4.8). git runs only inside helpers on
// scantor-egress; the orchestrator pre-checks the URL, passes the user's token for the exact host as GIT_CONFIG_*
// variables, decides on candidates and conflicts, and commits staged folders atomically. Import and pull set
// `lastSyncSha256`; pull never publishes.

export interface ImportOutcome {
  imported: TaskDoc[]
  candidates: GitImportCandidate[]
}

export interface PullOutcome {
  task: TaskDoc
  previousCommit: string
  commit: string
  changed: boolean
}

async function gitAccess(ownerId: string, credentialId: string | null | undefined, host: string): Promise<GitHelperAccess> {
  const env: Record<string, string> = {}
  const secrets: string[] = []
  const caCert = useConfig().caCert
  if (caCert) env.SCANTOR_CA_CERT = caCert
  if (credentialId) {
    const credential = await credentialForGit(ownerId, credentialId, host)
    Object.assign(env, credential.env)
    secrets.push(...credential.secrets)
  }
  return { env, secrets }
}

async function discardQuietly(userId: string, stagingId: string): Promise<void> {
  await discard(userId, stagingId).catch((error: unknown) => useLogger('tasks').warn('discarding a staging directory failed', { stagingId, err: error }))
}

function manifestInvalid(candidate: Pick<GitCandidate, 'path' | 'errors'>): never {
  const errors = candidate.errors.length > 0 ? candidate.errors : [{ phase: 'static', file: 'scantor.yaml', message: 'invalid manifest' }]
  throw apiError('manifestInvalid', `${candidate.path}/scantor.yaml is invalid: ${errors[0]!.message}`, {
    errors: errors.map((error) => ({ phase: error.phase ?? 'static', ...error })),
  })
}

/**
 * The error of an invalid candidate (docs/editor.md §9.4, §9.5): its rejection (a symlink, special file or path rule
 * is 422 invalidPath with `details.path`, a cap 413 payloadTooLarge) mapped like a failed helper, else manifestInvalid.
 */
function invalidCandidate(candidate: Pick<GitCandidate, 'path' | 'errors' | 'rejection'>, op: HelperOp = 'git-clone'): never {
  if (candidate.rejection) throw new HelperError(op, mapHelperError(op, candidate.rejection), candidate.rejection.code, '')
  manifestInvalid(candidate)
}

/** Which candidates to import: the selected paths, or the only valid one; null = ask the caller to select. */
export function selectCandidates(candidates: GitCandidate[], select: string[] | undefined): GitCandidate[] | null {
  if (select) {
    return select.map((path) => {
      const candidate = candidates.find((entry) => entry.path === path)
      if (!candidate) throw apiError('badRequest', `no scantor.yaml was found at ${path}`)
      if (!candidate.valid) invalidCandidate(candidate)
      return candidate
    })
  }
  const valid = candidates.filter((candidate) => candidate.valid)
  if (valid.length === 1) return valid
  if (valid.length > 1) return null
  if (candidates.length > 0) invalidCandidate(candidates[0]!)
  throw apiError('manifestInvalid', 'no scantor.yaml was found under the path', {
    errors: [{ phase: 'static', file: 'scantor.yaml', message: 'no scantor.yaml was found under the given path' }],
  })
}

/** Commits one staged candidate into a new task folder, re-cloning when a previous commit consumed the staging. */
async function commitCandidate(
  userId: string,
  stagingId: string,
  candidate: GitCandidate,
  reclone: () => Promise<string>,
): Promise<{ workspace: WorkspaceSummary; stagingId: string }> {
  try {
    const result = await commit(userId, { stagingId, from: candidate.path, task: candidate.name, expect: 'absent' })
    return { workspace: result.workspace, stagingId }
  } catch (error) {
    if (!isHelperCode(error, 'notFound')) throw error
    const fresh = await reclone()
    const result = await commit(userId, { stagingId: fresh, from: candidate.path, task: candidate.name, expect: 'absent' })
    return { workspace: result.workspace, stagingId: fresh }
  }
}

/** importGitTask (docs/tasks.md §14, docs/editor.md §9.9). */
export async function importGitTask(principal: UserPrincipal, body: ImportGitBody): Promise<ImportOutcome> {
  const userId = principal.user.id
  const config = useConfig()
  const checked = await checkGitUrl(body.url, { allowPrivate: config.gitAllowPrivate })
  if (body.credentialId) await assertOwnCredential(principal, body.credentialId)
  const access = await gitAccess(userId, body.credentialId, checked.host)
  const clone = async (stagingId: string) => gitClone(userId, { url: checked.url, ref: body.ref, path: body.path, stagingId }, access)

  let stagingId: string = randomUUID()
  const stagings = new Set([stagingId])
  try {
    const cloned = await clone(stagingId)
    const { tasks } = useCollections()
    const names = cloned.candidates.map((candidate) => candidate.name).filter(Boolean)
    const existing = new Set((await tasks.find({ userId, name: { $in: names } }, { projection: { name: 1 } }).toArray()).map((task) => task.name))
    const candidates: GitImportCandidate[] = cloned.candidates.map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      language: candidate.language,
      exists: existing.has(candidate.name),
    }))
    const selected = selectCandidates(cloned.candidates, body.select)
    if (!selected) return { imported: [], candidates }
    const taken = selected.find((candidate) => existing.has(candidate.name))
    if (taken) throw apiError('alreadyExists', `a task named ${taken.name} already exists`)
    const duplicateName = selected.find((candidate, index) => selected.findIndex((other) => other.name === candidate.name) !== index)
    if (duplicateName) throw apiError('badRequest', `two selected folders are both named ${duplicateName.name}`)

    const imported: TaskDoc[] = []
    for (const candidate of selected) {
      if (!isKnownLanguage(candidate.language)) manifestInvalid({ path: candidate.path, errors: [{ message: `unknown language "${candidate.language}"` }] })
      const now = new Date()
      const doc = await insertTask(
        newTaskDoc({
          userId,
          name: candidate.name,
          language: candidate.language,
          source: {
            kind: 'git',
            git: {
              url: checked.url,
              ref: body.ref,
              path: candidate.path,
              ...(body.credentialId ? { credentialId: body.credentialId } : {}),
              commit: cloned.commit,
              packSha256: candidate.summary?.packSha256 ?? '',
              pulledAt: now,
            },
          },
        }),
      )
      let committed: { workspace: WorkspaceSummary; stagingId: string }
      try {
        committed = await commitCandidate(userId, stagingId, candidate, async () => {
          const fresh = randomUUID()
          stagings.add(fresh)
          const again = await clone(fresh)
          if (again.commit !== cloned.commit) useLogger('tasks').warn('the git ref moved during a multi-task import', { url: checked.url, ref: body.ref })
          return fresh
        })
      } catch (error) {
        await tasks.deleteOne({ _id: doc._id, revisionSeq: 0 })
        throw error
      }
      stagingId = committed.stagingId
      const updated = await applyWorkspaceSummary(doc._id, committed.workspace, {
        lastSyncSha256: committed.workspace.packSha256,
        extra: { 'source.git.packSha256': committed.workspace.packSha256 },
      })
      imported.push(updated ?? doc)
    }
    return { imported, candidates: candidates.map((candidate) => (imported.some((task) => task.name === candidate.name) ? { ...candidate, exists: true } : candidate)) }
  } finally {
    for (const id of stagings) await discardQuietly(userId, id)
  }
}

/** pullGitTask (docs/tasks.md §14, docs/editor.md §9.7): fast-forward only unless `force`. */
export async function pullGitTask(task: TaskDoc, options: { force: boolean }): Promise<PullOutcome> {
  const git = task.source.git
  if (task.source.kind !== 'git' || !git) throw invalidState('task', task.source.kind, ['git'], 'git pull')
  const config = useConfig()
  const checked = await checkGitUrl(git.url, { allowPrivate: config.gitAllowPrivate })
  const credentialId = git.credentialId ?? null
  const credentialExists = credentialId ? (await useCollections().credentials.countDocuments({ _id: credentialId, userId: task.userId })) > 0 : false
  const access = await gitAccess(task.userId, credentialExists ? credentialId : null, checked.host)
  const stagingId = randomUUID()
  let committed = false
  try {
    const pulled = await gitPull(task.userId, { task: task.name, url: checked.url, ref: git.ref, path: git.path, baseCommit: git.commit, stagingId }, access)
    if (!options.force && !pulled.fastForward) throw apiError('gitDiverged', 'remote history is not a fast-forward of the last import or pull')
    if (!options.force && pulled.current?.packSha256 !== git.packSha256) throw apiError('gitDiverged', 'local changes since the last import/pull')
    const now = new Date()
    if (!pulled.changed) {
      const updated = await useCollections().tasks.findOneAndUpdate(
        { _id: task._id },
        { $set: { 'source.git.commit': pulled.commit, 'source.git.pulledAt': now, updatedAt: now } },
        { returnDocument: 'after' },
      )
      return { task: updated ?? task, previousCommit: git.commit, commit: pulled.commit, changed: false }
    }
    if (!pulled.candidate.valid) invalidCandidate(pulled.candidate, 'git-pull')
    if (pulled.candidate.name !== task.name) {
      throw apiError('manifestInvalid', `the pulled manifest names task ${pulled.candidate.name}, not ${task.name}`, {
        errors: [{ phase: 'static', file: 'scantor.yaml', message: `name "${pulled.candidate.name}" does not match task "${task.name}"; task names are immutable` }],
      })
    }
    const expect = options.force ? 'any' : (pulled.current?.packSha256 ?? 'absent')
    const result = await commit(task.userId, { stagingId, from: pulled.candidate.path, task: task.name, expect })
    committed = true
    const updated = await applyWorkspaceSummary(task._id, result.workspace, {
      lastSyncSha256: result.workspace.packSha256,
      extra: { 'source.git.commit': pulled.commit, 'source.git.packSha256': result.workspace.packSha256, 'source.git.pulledAt': now },
    })
    return { task: updated ?? task, previousCommit: git.commit, commit: pulled.commit, changed: true }
  } catch (error) {
    if (error instanceof HelperError && error.code === 'workspaceDirty') {
      throw apiError('gitDiverged', 'the workspace changed during the pull; retry', error.details)
    }
    throw error
  } finally {
    if (!committed) await discardQuietly(task.userId, stagingId)
  }
}

