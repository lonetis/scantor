import type { AnalysisAggregateResult } from '#shared/types/analyses'
import type { ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { presignInternalGet } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'
import { findStoredFile } from '../files/content'
import { aggregateAnalyses } from '../query/execute'
import { acquireRunReadSlot } from './limiter'
import { FILE_URL_TTL_SECONDS } from './limits'
import type { ScriptRuntimeAggregateBody } from './schemas'

// Reads of a script run besides the analysis stream (docs/scripts.md): aggregations with the rules of
// aggregateAnalyses, and fresh presigned internal GETs of single stored files (a stream's URL may expire while a slow
// consumer works through its backlog).

/**
 * scriptRuntimeAggregate: aggregateAnalyses over one scan of the run (allowlist, secret checks, scope first, the same
 * time and size limits), on the run's read slots instead of the owner's query slots.
 */
export async function aggregateRunAnalyses(
  principal: ScriptRunPrincipal,
  scan: ScanDoc,
  body: ScriptRuntimeAggregateBody,
  config: Pick<Config, 'queryMaxTimeMs' | 'queryMaxDocs'>,
): Promise<AnalysisAggregateResult> {
  const release = acquireRunReadSlot(principal.scriptRun.id)
  try {
    return await aggregateAnalyses(scan, body, config)
  } finally {
    release()
  }
}

export interface ScriptRuntimeFileUrl {
  url: string
  expiresAt: string
  name: string
  size: number
  sha256: string
  contentType: string
}

/** scriptRuntimeFileUrl: a presigned internal GET of one stored file of an analysis (404 for unknown or unstored files). */
export function runFileUrl(analysis: { files?: Parameters<typeof findStoredFile>[0] }, fileId: string, now = new Date()): ScriptRuntimeFileUrl {
  const file = findStoredFile(analysis.files, fileId)
  const { url, expiresAt } = presignInternalGet(file.key, FILE_URL_TTL_SECONDS, now)
  return { url, expiresAt: isoDate(expiresAt), name: file.name, size: file.size, sha256: file.sha256, contentType: file.contentType }
}
