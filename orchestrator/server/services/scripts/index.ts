import type { Filter } from 'mongodb'
import type { CreateScriptBody, ListScriptsQuery } from '#shared/schemas/scripts'
import type { JobRef, Page } from '#shared/types/common'
import type { Script } from '#shared/types/scripts'
import type { ScriptDoc, ScriptRunDoc } from '../../types/documents'
import { ownerFilter } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { createJob } from '../../utils/jobs'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import type { UserPrincipal } from '../../utils/principal'
import { scaffold } from '../helpers/ops'
import { toJobRef } from '../jobs/mappers'
import { RECENT_RUNS_LIMIT, RUN_SUMMARY_PROJECTION, toApiScript } from './mappers'
import { applyScriptWorkspaceSummary, defaultScriptLanguage, insertScript, newScriptDoc, removeUnusedScript } from './store'

// Scripts (docs/api.md tag `scripts`, docs/scripts.md): creation from the language's script scaffold, listing, the
// Script representation with its newest runs, and deletion (a `scriptDelete` job). Workspace content is only ever
// touched by helpers; the folder of a script is `.scripts/<name>/` (the helpers map the name to it).

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The filter of listScripts: the owner filter, scripts being deleted hidden, `q` as an escaped substring. */
export function listScriptsFilter(principal: UserPrincipal, query: ListScriptsQuery): Filter<ScriptDoc> {
  const clauses: Filter<ScriptDoc>[] = [ownerFilter(principal, query.userId) as Filter<ScriptDoc>, { deletingAt: null }]
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i')
    clauses.push({ $or: [{ name: pattern }, { description: pattern }] })
  }
  return { $and: clauses }
}

export async function listScripts(principal: UserPrincipal, query: ListScriptsQuery): Promise<Page<Script>> {
  return findPage(useCollections().scripts, listScriptsFilter(principal, query), { limit: query.limit, cursor: query.cursor }, (doc) => toApiScript(doc))
}

/** The newest runs of a script, newest first, with the fields of a summary only. */
export async function recentScriptRuns(scriptId: string): Promise<ScriptRunDoc[]> {
  return useCollections()
    .scriptRuns.find({ scriptId }, { projection: RUN_SUMMARY_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .limit(RECENT_RUNS_LIMIT)
    .toArray()
}

/** getScript: the Script with `recentRuns`. */
export async function scriptRepresentation(script: ScriptDoc): Promise<Script> {
  return toApiScript(script, { recentRuns: await recentScriptRuns(script._id) })
}

/**
 * createScript: inserts the script (`source.kind = scaffold`, the first script language of languages.json) and
 * renders the script scaffold into `<userId>/.scripts/<name>/` (the executor runs the helper `init` first, once per
 * process). A failed scaffold removes the document again, so the name stays free.
 */
export async function createScript(principal: UserPrincipal, body: CreateScriptBody): Promise<Script> {
  const doc = await insertScript(
    newScriptDoc({
      userId: principal.user.id,
      name: body.name,
      language: defaultScriptLanguage(),
      description: body.description || null,
      source: { kind: 'scaffold' },
    }),
  )
  try {
    const { workspace } = await scaffold(principal.user.id, {
      script: doc.name,
      language: doc.language,
      description: body.description || undefined,
    })
    const updated = await applyScriptWorkspaceSummary(doc._id, workspace)
    return toApiScript(updated ?? doc, { recentRuns: [] })
  } catch (error) {
    await removeUnusedScript(doc._id).catch((deleteError: unknown) =>
      useLogger('scripts').error('removing a script whose scaffold failed failed', { scriptId: doc._id, err: deleteError }),
    )
    throw error
  }
}

/**
 * deleteScript: the script becomes invisible at once (`deletingAt`: name lookups, run starts and the editor no longer
 * find it) and a `scriptDelete` job cancels its active runs, then removes the runs' data, the script's images, the
 * workspace folder and the document. Active runs never block the request: the job stops them.
 */
export async function requestScriptDeletion(script: ScriptDoc): Promise<JobRef> {
  const deletingAt = new Date()
  const marked = await useCollections().scripts.findOneAndUpdate(
    { _id: script._id, deletingAt: null },
    { $set: { deletingAt, updatedAt: deletingAt } },
    { returnDocument: 'after' },
  )
  if (!marked) throw apiError('notFound', 'script not found')
  const { job } = await createJob({ kind: 'scriptDelete', userId: script.userId, subject: { kind: 'script', id: script._id }, params: {} })
  return toJobRef(job)
}
