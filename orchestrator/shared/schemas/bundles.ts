import { z } from 'zod'
import { qBoolean, waitQueryShape } from './common'

// Request schemas of a revision's bundle (docs/api.md, tag `revisions`): `createRevisionBundle` and
// `getRevisionBundle` under `/api/tasks/{task}/revisions/{revision}/bundle`. The path parameters are `revisionParams`
// of ./tasks. Every schema is strict.

/** `?wait` (seconds) and `?rebuild` (replace a ready bundle) of createRevisionBundle. */
export const createRevisionBundleQuery = z.strictObject({
  ...waitQueryShape,
  rebuild: qBoolean().default(false),
})
export type CreateRevisionBundleQuery = z.infer<typeof createRevisionBundleQuery>

/** `?wait` (seconds) of getRevisionBundle. */
export const getRevisionBundleQuery = z.strictObject({ ...waitQueryShape })
