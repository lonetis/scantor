import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { ScriptDoc } from '../../types/documents'
import { ByteCap } from '../../utils/byte-cap'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import type { UserPrincipal } from '../../utils/principal'
import { commit, discard, extract, snapshotHash } from '../helpers/ops'
import type { ExtractOutput, WorkspaceSummary } from '../helpers/types'
import { StallGuard, stalledError, TASK_UPLOAD_CONTENT_TYPES, tooLarge, UPLOAD_IDLE_MS } from '../tasks/upload'
import { applyScriptWorkspaceSummary, findScriptByName, insertScript, isScriptLanguage, newScriptDoc, removeUnusedScript, SCRIPT_MANIFEST_FILE } from './store'

// Script upload (`uploadScript`, `scantor scripts push`; docs/api.md tag `scripts`, docs/scripts.md): the tar.gz streams
// into helper `extract --kind script` (which validates scantor-script.yaml), the manifest name selects or creates the
// script, the orchestrator decides on conflicts from the current workspace hash, helper `commit --script --expect
// <hash>` replaces the folder atomically (a concurrent edit still fails), and `lastSyncSha256` becomes the uploaded
// hash. The stall guard, byte cap and their errors are the task upload's (../tasks/upload.ts).

export interface ScriptUploadInput {
  body: Readable
  /** cap of the compressed stream (SCANTOR_TASK_MAX_PACK_BYTES) */
  maxBytes: number
  /** test seam: UPLOAD_IDLE_MS */
  idleMs?: number
  force: boolean
}

export interface ScriptUploadOutcome {
  script: ScriptDoc
  created: boolean
}

export function assertScriptUploadContentType(header: string | undefined): void {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(TASK_UPLOAD_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw apiError('unsupportedMediaType', 'the script upload body must be application/gzip (a tar.gz of the script folder)')
  }
}

/**
 * The conflict rule of a script upload (scripts have no revisions): no conflict when the folder is absent, or its
 * current hash equals the uploaded hash or `workspace.lastSyncSha256` (the folder is unchanged since the last upload).
 * Anything else means the folder has changes that exist only there (editor or file-route writes, or the scaffold).
 */
export function scriptUploadConflicts(current: WorkspaceSummary | null, uploadedSha256: string, script: Pick<ScriptDoc, 'workspace'>): boolean {
  if (!current) return false
  const hash = current.packSha256
  if (hash === uploadedSha256) return false
  if (script.workspace.lastSyncSha256 !== null && hash === script.workspace.lastSyncSha256) return false
  return true
}

/** The `--expect` of the commit: anything for a new script or with force, else the hash the decision was made on. */
export function scriptCommitExpectation(current: WorkspaceSummary | null, options: { created: boolean; force: boolean }): string {
  if (options.created || options.force) return 'any'
  return current?.packSha256 ?? 'absent'
}

async function discardQuietly(userId: string, stagingId: string): Promise<void> {
  await discard(userId, stagingId).catch((error: unknown) => useLogger('scripts').warn('discarding a staging directory failed', { stagingId, err: error }))
}

function unsupportedLanguage(language: string) {
  return apiError('manifestInvalid', `scripts cannot be written in ${language}`, {
    errors: [{ phase: 'static', file: SCRIPT_MANIFEST_FILE, message: `language "${language}" does not support scripts` }],
  })
}

/** Finds the caller's script by manifest name or creates it (`source.kind = upload`). */
async function scriptForManifest(principal: UserPrincipal, manifest: ExtractOutput['manifest']): Promise<{ script: ScriptDoc; created: boolean }> {
  // extract --kind script already checked the language (rule S3); this keeps a stale helper from creating a script
  // the platform cannot build.
  if (!isScriptLanguage(manifest.language)) throw unsupportedLanguage(manifest.language)
  const existing = await findScriptByName(principal.user.id, manifest.name)
  if (existing) {
    if (existing.deletingAt) throw apiError('alreadyExists', `script ${manifest.name} is being deleted; retry when the deletion finished`)
    return { script: existing, created: false }
  }
  try {
    const script = await insertScript(
      newScriptDoc({
        userId: principal.user.id,
        name: manifest.name,
        language: manifest.language,
        description: typeof manifest.description === 'string' ? manifest.description : null,
        source: { kind: 'upload' },
      }),
    )
    return { script, created: true }
  } catch (error) {
    // A concurrent upload created it first: continue with that script.
    const raced = (error as { code?: unknown }).code === 'alreadyExists' ? await findScriptByName(principal.user.id, manifest.name) : null
    if (raced && !raced.deletingAt) return { script: raced, created: false }
    throw error
  }
}

export async function uploadScript(principal: UserPrincipal, input: ScriptUploadInput): Promise<ScriptUploadOutcome> {
  const userId = principal.user.id
  const stagingId = randomUUID()
  const idleMs = input.idleMs ?? UPLOAD_IDLE_MS
  const cap: ByteCap = new ByteCap(input.maxBytes, () => guard.touch())
  const guard = new StallGuard(input.body, cap, idleMs)
  input.body.on('error', (error) => cap.destroy(error))
  let extracted: ExtractOutput
  try {
    extracted = await extract(userId, stagingId, input.body.pipe(cap), { kind: 'script' })
  } catch (error) {
    await discardQuietly(userId, stagingId)
    throw cap.exceeded ? tooLarge(cap) : guard.stalled ? stalledError(idleMs) : error
  } finally {
    guard.stop()
  }
  if (cap.exceeded || guard.stalled) {
    await discardQuietly(userId, stagingId)
    throw cap.exceeded ? tooLarge(cap) : stalledError(idleMs)
  }
  let committed = false
  try {
    const { script, created } = await scriptForManifest(principal, extracted.manifest)
    // A folder without a script document (a crashed request) carries nothing worth keeping, so a new script never
    // checks the current folder.
    const current = created ? null : await snapshotHash(userId, { script: script.name })
    if (!created && !input.force && scriptUploadConflicts(current, extracted.summary.packSha256, script)) {
      throw apiError('workspaceDirty', `the folder of script ${script.name} has changes that were never uploaded; retry with force=true to replace them`, {
        current: current?.packSha256 ?? null,
        uploaded: extracted.summary.packSha256,
      })
    }
    let result: Awaited<ReturnType<typeof commit>>
    try {
      result = await commit(userId, { stagingId, script: script.name, expect: scriptCommitExpectation(current, { created, force: input.force }) })
    } catch (error) {
      if (created) await removeUnusedScript(script._id)
      throw error
    }
    committed = true
    // The manifest is the source of the language and description of a script (there is no publish that copies them).
    const description = typeof extracted.manifest.description === 'string' ? extracted.manifest.description : null
    const updated = await applyScriptWorkspaceSummary(script._id, result.workspace, {
      lastSyncSha256: result.workspace.packSha256,
      extra: { language: extracted.manifest.language, description },
    })
    return { script: updated ?? script, created }
  } finally {
    if (!committed) await discardQuietly(userId, stagingId)
  }
}
