import { randomUUID } from 'node:crypto'
import type { ScriptSourceKind } from '#shared/utils/enums'
import type { ScriptDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { scriptLanguageNames } from '../catalog/languages'
import type { WorkspaceSummary } from '../helpers/types'

// Persistence of `scripts` (docs/data-model.md, docs/scripts.md): creation with the unique (userId, name) index and
// the workspace cache every helper summary refreshes. Scripts have no revisions; `latestRun` and `describe` are
// written by the script-run lifecycle.

/** The manifest file of a script folder (the task manifest is scantor.yaml). */
export const SCRIPT_MANIFEST_FILE = 'scantor-script.yaml'

export interface NewScriptInput {
  userId: string
  name: string
  language: string
  description?: string | null
  source: { kind: ScriptSourceKind }
}

export function newScriptDoc(input: NewScriptInput, now = new Date()): ScriptDoc {
  return {
    _id: randomUUID(),
    userId: input.userId,
    name: input.name,
    language: input.language,
    description: input.description ?? null,
    source: input.source,
    workspace: { packSha256: null, fileCount: 0, bytes: 0, checkedAt: null, lastSyncSha256: null },
    describe: null,
    latestRun: null,
    deletingAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The language of a script created without a manifest (createScript): the first language of languages.json with a
 * `script` object. The table, not the code, decides which languages scripts support.
 */
export function defaultScriptLanguage(): string {
  const [language] = scriptLanguageNames()
  if (!language) throw apiError('internal', 'no language of schemas/languages.json supports scripts')
  return language
}

export function isScriptLanguage(language: string): boolean {
  return scriptLanguageNames().includes(language)
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

/** Inserts a script; a taken name (also of a script being deleted) is 409 alreadyExists. */
export async function insertScript(doc: ScriptDoc): Promise<ScriptDoc> {
  try {
    await useCollections().scripts.insertOne(doc)
    return doc
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a script named ${doc.name} already exists`)
    throw error
  }
}

/** The caller's script by name, including scripts being deleted (callers decide how to treat those). */
export async function findScriptByName(userId: string, name: string): Promise<ScriptDoc | null> {
  return useCollections().scripts.findOne({ userId, name })
}

export async function loadScript(scriptId: string): Promise<ScriptDoc | null> {
  return useCollections().scripts.findOne({ _id: scriptId })
}

/**
 * Removes a script document that never became usable (its scaffold or first commit failed). The `latestRun: null`
 * guard keeps a script that a run already started on.
 */
export async function removeUnusedScript(scriptId: string): Promise<void> {
  await useCollections().scripts.deleteOne({ _id: scriptId, latestRun: null })
}

/**
 * Copies a helper summary into the workspace cache (null = the script folder does not exist). Upload also sets
 * `lastSyncSha256`; editor and file-route writes never do.
 */
export async function applyScriptWorkspaceSummary(
  scriptId: string,
  summary: WorkspaceSummary | null,
  options: { lastSyncSha256?: string | null; extra?: Record<string, unknown> } = {},
): Promise<ScriptDoc | null> {
  const now = new Date()
  const set: Record<string, unknown> = {
    'workspace.packSha256': summary?.packSha256 ?? null,
    'workspace.fileCount': summary?.fileCount ?? 0,
    'workspace.bytes': summary?.bytes ?? 0,
    'workspace.checkedAt': now,
    updatedAt: now,
    ...options.extra,
  }
  if (options.lastSyncSha256 !== undefined) set['workspace.lastSyncSha256'] = options.lastSyncSha256
  return useCollections().scripts.findOneAndUpdate({ _id: scriptId }, { $set: set }, { returnDocument: 'after' })
}
