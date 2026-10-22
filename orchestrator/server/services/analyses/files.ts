import type { FileDownload } from '#shared/types/exports'
import type { AnalysisDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { presignDownload } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'

// Analysis files (docs/architecture.md §11.5, docs/data-model.md §9, security.md DL-1/DL-3). Keys are generated
// only by the server: the ingestor recomputes the keys of a result's FileRefs with the presign route's own key
// function (`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`) and never reads a key from a message.

export { analysisFileKey } from '../runtime/uploads'

/**
 * The presigned download of one file of an analysis (getFileDownload): 10 minutes, for SCANTOR_S3_PUBLIC_URL,
 * attachment as application/octet-stream except png/jpeg/gif/webp, which are inline with their image type.
 */
export async function analysisFileDownload(analysis: Pick<AnalysisDoc, 'files'>, fileId: string): Promise<FileDownload> {
  const file = (analysis.files ?? []).find((candidate) => candidate.id === fileId)
  if (!file?.key) throw apiError('notFound', 'file not found')
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
