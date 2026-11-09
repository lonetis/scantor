import type { Script, ScriptDescribe, ScriptRunPointer } from '#shared/types/scripts'
import type { ScriptDescribeDoc, ScriptDoc, ScriptRunDoc, ScriptRunPointerDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { toScriptRunSummary } from '../script-runs/mappers'

// Script representations (docs/api.md §2 `Script`, docs/scripts.md): `workspace` without the internal
// `lastSyncSha256` (scripts have no revisions, so there is no `dirty`), `describe` as reported by the newest run of
// a pack, `latestRun` from the pointer the run lifecycle maintains, and `recentRuns` (getScript, createScript) as
// summaries of the newest runs. `deletingAt` is internal.

/** How many run summaries getScript and createScript embed in `recentRuns`. */
export const RECENT_RUNS_LIMIT = 10

/** The run fields a summary needs; `recentRuns` loads only these (a run document can hold a large result). */
export const RUN_SUMMARY_PROJECTION = { _id: 1, state: 1, cancelRequest: 1, createdAt: 1, finishedAt: 1, progress: 1 } as const

export function toScriptDescribe(doc: ScriptDescribeDoc | null): ScriptDescribe | null {
  if (!doc) return null
  return { packSha256: doc.packSha256, configSchema: doc.configSchema, resultSchema: doc.resultSchema, at: isoDate(doc.at) }
}

export function toScriptRunPointer(doc: ScriptRunPointerDoc | null): ScriptRunPointer | null {
  if (!doc) return null
  return { id: doc.id, state: doc.state, createdAt: isoDate(doc.createdAt), finishedAt: isoDateOrNull(doc.finishedAt) }
}

export interface ScriptRepresentationOptions {
  /** the newest runs of the script, newest first (RUN_SUMMARY_PROJECTION suffices); omitted on lists and uploads */
  recentRuns?: ScriptRunDoc[]
}

export function toApiScript(doc: ScriptDoc, options: ScriptRepresentationOptions = {}): Script {
  return {
    id: doc._id,
    userId: doc.userId,
    name: doc.name,
    language: doc.language,
    description: doc.description ?? null,
    source: { kind: doc.source.kind },
    workspace: {
      packSha256: doc.workspace.packSha256,
      fileCount: doc.workspace.fileCount,
      bytes: doc.workspace.bytes,
      checkedAt: isoDateOrNull(doc.workspace.checkedAt),
    },
    describe: toScriptDescribe(doc.describe),
    latestRun: toScriptRunPointer(doc.latestRun),
    ...(options.recentRuns ? { recentRuns: options.recentRuns.slice(0, RECENT_RUNS_LIMIT).map((run) => toScriptRunSummary(run)) } : {}),
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  }
}
