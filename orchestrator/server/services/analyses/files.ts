import type { FileContentQuery } from '#shared/schemas/analyses'
import type { FileContent, FileDownload } from '#shared/types/exports'
import type { AnalysisDoc } from '../../types/documents'
import { presignDownload } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'
import { findStoredFile, readStoredFileContent } from '../files/content'

// Analysis files (docs/architecture.md §11.5, docs/data-model.md §9, security.md DL-1/DL-3/DL-6). Keys are generated
// only by the server: the ingestor recomputes the keys of a result's FileRefs with the presign route's own key
// function (`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`) and never reads a key from a message.

export { analysisFileKey } from '../runtime/uploads'

/**
 * The presigned download of one file of an analysis (getFileDownload): 10 minutes, for SCANTOR_S3_PUBLIC_URL,
 * attachment as application/octet-stream except png/jpeg/gif/webp, which are inline with their image type.
 */
export async function analysisFileDownload(analysis: Pick<AnalysisDoc, 'files'>, fileId: string): Promise<FileDownload> {
  const file = findStoredFile(analysis.files, fileId)
  const { url, expiresAt, inline } = await presignDownload({ key: file.key, name: file.name, contentType: file.contentType })
  return {
    url,
    expiresAt: isoDate(expiresAt),
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType,
    inline,
  }
}

/** One page of a file of an analysis, inline (readAnalysisFile). */
export async function analysisFileContent(analysis: Pick<AnalysisDoc, 'files'>, fileId: string, range: FileContentQuery): Promise<FileContent> {
  return readStoredFileContent(findStoredFile(analysis.files, fileId), range)
}
