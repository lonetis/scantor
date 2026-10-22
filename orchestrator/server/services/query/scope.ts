import type { Document } from 'mongodb'
import type { ScanDoc } from '../../types/documents'

// The scope of every user query (docs/api.md §5.2, security.md Q-3): `{$and: [{scanId}, {userId: <scan owner>},
// <user filter>]}`, and every pipeline starts with that `$match`. The user's filter is never spread into the scope,
// so a user filter such as `{"scanId": {"$ne": null}}` can only narrow the result.

export type ScopedScan = Pick<ScanDoc, '_id' | 'userId'>

/** The scope clauses of a scan, newly built for every query. */
export function scopeClauses(scan: ScopedScan): Document[] {
  return [{ scanId: scan._id }, { userId: scan.userId }]
}

/** `{$and: [scope…, extra…]}` for find-style queries; `extra` are user and server clauses (never spread). */
export function scopedFilter(scan: ScopedScan, ...extra: Document[]): Document {
  return { $and: [...scopeClauses(scan), ...extra] }
}

/** The first stage of every user pipeline. */
export function scopeStage(scan: ScopedScan): Document {
  return { $match: { $and: scopeClauses(scan) } }
}
