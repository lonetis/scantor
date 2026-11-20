import type { Bundle } from '#shared/types/bundles'
import type { BundleDoc } from '../../types/documents'
import { contentDisposition, DOWNLOAD_URL_TTL_SECONDS, presignGet } from '../../utils/s3'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { bundleRef } from './info'

// The Bundle representation (docs/api.md §2, components.schemas.Bundle): the document without its internal fields
// (key, owner, task and job ids), the copy-paste commands of the recipient and, when ready, a presigned download
// created anew for every representation (10 minutes, the public S3 endpoint, an application/gzip attachment named
// fileName; security.md BDL-3, DL-1).

export const BUNDLE_CONTENT_TYPE = 'application/gzip'

/** The recipient's commands (docs/guide/bundles.md): load the archive once, run it with /work mounted, describe it. */
export function bundleCommands(doc: Pick<BundleDoc, 'image' | 'fileName'>): Bundle['commands'] {
  return {
    load: `docker load -i ${doc.fileName}`,
    run: `docker run --rm -v "$PWD:/work" ${doc.image}`,
    describe: `docker run --rm ${doc.image} --describe`,
  }
}

/** `wait` on createRevisionBundle and getRevisionBundle settles when the bundle is `ready` or `failed`. */
export function isBundleSettled(doc: Pick<BundleDoc, 'state'>): boolean {
  return doc.state === 'ready' || doc.state === 'failed'
}

export async function toApiBundle(doc: BundleDoc): Promise<Bundle> {
  let download: Bundle['download'] = null
  if (doc.state === 'ready') {
    const signed = await presignGet({
      key: doc.key,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      profile: 'public',
      responseContentType: BUNDLE_CONTENT_TYPE,
      responseContentDisposition: contentDisposition('attachment', doc.fileName),
    })
    download = { url: signed.url, expiresAt: isoDate(signed.expiresAt), fileName: doc.fileName }
  }
  return {
    id: doc._id,
    revision: { id: doc.revisionId, number: doc.revisionNumber, ref: bundleRef(doc.taskName, doc.revisionNumber) },
    state: doc.state,
    image: doc.image,
    platform: { os: doc.platform.os, arch: doc.platform.arch, ...(doc.platform.variant ? { variant: doc.platform.variant } : {}) },
    bytes: doc.bytes,
    sha256: doc.sha256,
    scantorVersion: doc.scantorVersion,
    error: doc.error ? { code: doc.error.code, message: doc.error.message } : null,
    createdAt: isoDate(doc.createdAt),
    startedAt: isoDateOrNull(doc.startedAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    expiresAt: isoDate(doc.expiresAt),
    download,
    commands: bundleCommands(doc),
  }
}
