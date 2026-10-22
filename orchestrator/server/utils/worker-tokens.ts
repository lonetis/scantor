import { timingSafeEqual } from 'node:crypto'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import type { WorkerDoc } from '../types/documents'
import { parseWorkerToken, useKeys } from './keys'
import { useCollections } from './mongo'
import type { WorkerPrincipal } from './principal'

// Worker tokens (docs/auth.md §10.2): `swt_<workerId>.<mac>` with the MAC over workerId, scanId, role and nodeId,
// derived from HKDF "worker-token", never stored. Validation reads the worker document on every request (no cache,
// so revocation is immediate) and requires an active worker state.

/** The token of a placed worker (its `nodeId` must be set). */
export function mintWorkerToken(worker: Pick<WorkerDoc, '_id' | 'scanId' | 'role' | 'nodeId'>): string {
  if (!worker.nodeId) throw new Error(`worker ${worker._id} has no node yet`)
  return useKeys().workerToken(worker._id, worker.scanId, worker.role, worker.nodeId)
}

/** Resolves a worker token to its principal, or null when malformed, unknown, inactive or forged. */
export async function resolveWorkerToken(token: string): Promise<WorkerPrincipal | null> {
  const parsed = parseWorkerToken(token)
  if (!parsed) return null
  const worker = await useCollections().workers.findOne(
    { _id: parsed.workerId },
    { projection: { _id: 1, scanId: 1, userId: 1, role: 1, nodeId: 1, epoch: 1, state: 1 } },
  )
  if (!worker || !worker.nodeId || !(ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)) return null
  const expected = Buffer.from(useKeys().workerTokenMac(worker._id, worker.scanId, worker.role, worker.nodeId))
  const presented = Buffer.from(parsed.mac)
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null
  return {
    kind: 'worker',
    worker: { id: worker._id, scanId: worker.scanId, userId: worker.userId, role: worker.role, nodeId: worker.nodeId, epoch: worker.epoch },
  }
}
