import type { RevisionDoc, ScanDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { findAuthUser } from '../../utils/users'

// Checks shared by startScan, restartScan, resumeScan and retryFailedAnalyses (security.md PRIV-4, docs/auth.md §6.2;
// docs/api.md §4.13): privileged revisions need the owner's `canRunPrivileged`, and the scan's revision must still
// exist. Workers run with the owner's identity, so the owner's flag decides, also when an admin acts for them.

export async function assertPrivilegedAllowed(privileged: boolean, ownerId: string): Promise<void> {
  if (!privileged) return
  const owner = await findAuthUser(ownerId)
  if (!owner?.canRunPrivileged) {
    throw apiError('privilegedNotAllowed', 'this revision is privileged (Docker-in-Docker); the scan owner needs the canRunPrivileged permission, which an admin grants')
  }
}

/** The scan's revision; 409 revisionUnavailable when it was deleted (or is no longer ready). */
export async function loadScanRevision(scan: Pick<ScanDoc, 'revision' | 'task'>): Promise<RevisionDoc> {
  const revision = await useCollections().revisions.findOne({ _id: scan.revision.id })
  if (!revision || revision.state !== 'ready' || !revision.image) {
    throw apiError('revisionUnavailable', `revision ${scan.task.name}@${scan.revision.number} of this scan no longer exists`)
  }
  return revision
}
