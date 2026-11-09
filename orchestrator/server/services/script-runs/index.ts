import type { FileContentQuery } from '#shared/schemas/analyses'
import type { Page } from '#shared/types/common'
import type { FileContent, FileDownload } from '#shared/types/exports'
import type { ScriptRun } from '#shared/types/scripts'
import type { ScriptDoc, ScriptRunDoc } from '../../types/documents'
import { invalidState, apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import { contentDisposition, DOWNLOAD_URL_TTL_SECONDS, presignDownload, presignGet } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'
import { readStoredFileContent, type StoredFile } from '../files/content'
import { cancelScriptRunState } from './cleanup'
import { scriptRunLogTail } from './logs'
import { effectiveScriptRunState, toApiScriptRun } from './mappers'

// Script runs (docs/api.md, tag `script-runs`): representations with the scans' names and the log tail, the history
// of a script, cancellation, and the downloads of outputs and the source snapshot. Starting is in ./start, the
// lifecycle in ./job, the log in ./logs.

export async function reloadScriptRun(doc: ScriptRunDoc): Promise<ScriptRunDoc> {
  return (await useCollections().scriptRuns.findOne({ _id: doc._id })) ?? doc
}

async function scanNames(scanIds: readonly string[]): Promise<Map<string, string | null>> {
  const scans = await useCollections()
    .scans.find({ _id: { $in: [...scanIds] }, state: { $ne: 'deleted' } }, { projection: { name: 1 } })
    .toArray()
  return new Map(scans.map((scan) => [scan._id, scan.name ?? null]))
}

/** The single-run representation (getScriptRun, start, restart, cancel): with the scans' names and the log tail. */
export async function scriptRunRepresentation(doc: ScriptRunDoc): Promise<ScriptRun> {
  const [names, logTail] = await Promise.all([scanNames(doc.scanIds), scriptRunLogTail(doc)])
  return toApiScriptRun(doc, { scanNames: names, logTail })
}

/** listScriptRuns: the runs of a script, newest first, without the log tail. */
export async function listScriptRuns(script: ScriptDoc, query: { limit?: number; cursor?: string }): Promise<Page<ScriptRun>> {
  const page = await findPage(useCollections().scriptRuns, { scriptId: script._id }, query, (doc) => doc)
  const names = await scanNames([...new Set(page.items.flatMap((doc) => doc.scanIds))])
  return { ...page, items: page.items.map((doc) => toApiScriptRun(doc, { scanNames: names })) }
}

/**
 * cancelScriptRun: `queued`, `building` and `running` become `cancelled` (a running one is reported cancelled while its
 * job stops the container with `docker stop -t 60` and removes it); a cancelled run is returned unchanged; a completed
 * or failed one is 409 invalidState.
 */
export async function cancelScriptRun(doc: ScriptRunDoc): Promise<ScriptRunDoc> {
  const cancelled = await cancelScriptRunState(doc._id, null)
  if (cancelled) return cancelled
  const current = await reloadScriptRun(doc)
  if (effectiveScriptRunState(current) === 'cancelled') return current
  throw invalidState('script run', current.state, ['queued', 'building', 'running'], 'cancel')
}

/** A stored output of the run; pending outputs and unknown ids are 404. */
function storedOutput(doc: ScriptRunDoc, outputId: string): StoredFile {
  const output = doc.outputs.find((candidate) => candidate.id === outputId && candidate.state === 'stored')
  if (!output || output.size === null) throw apiError('notFound', 'output not found')
  return { key: output.key, name: output.name, size: output.size, sha256: output.sha256 ?? '', contentType: output.contentType }
}

/** getScriptRunOutputDownload: a presigned public GET (10 minutes) of a stored output, like getFileDownload. */
export async function scriptRunOutputDownload(doc: ScriptRunDoc, outputId: string): Promise<FileDownload> {
  const output = storedOutput(doc, outputId)
  const { url, expiresAt, inline } = await presignDownload({ key: output.key, name: output.name, contentType: output.contentType })
  return { url, expiresAt: isoDate(expiresAt), name: output.name, size: output.size, sha256: output.sha256, contentType: output.contentType, inline }
}

/** readScriptRunOutput: one page of a stored output, inline (the shared file content service). */
export async function scriptRunOutputContent(doc: ScriptRunDoc, outputId: string, range: FileContentQuery): Promise<FileContent> {
  return readStoredFileContent(storedOutput(doc, outputId), range)
}

/** getScriptRunSourceDownload: a presigned public GET (10 minutes) of the run's source snapshot, as an attachment. */
export async function scriptRunSourceDownload(doc: ScriptRunDoc): Promise<{ url: string; expiresAt: Date }> {
  return presignGet({
    key: doc.source.key,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    profile: 'public',
    responseContentType: 'application/gzip',
    responseContentDisposition: contentDisposition('attachment', `${doc.scriptName}-${doc._id.slice(0, 8)}.tar.gz`),
  })
}
