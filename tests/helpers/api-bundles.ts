import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Bundle } from '#shared/types/bundles'
import { ok, type ApiClient, type ApiResponse } from './api-client'

// Bundles of revisions through the REST API (docs/api.md, createRevisionBundle and getRevisionBundle) for the api, e2e
// and security specs: create with or without `wait`, read with `wait`, wait until the bundle settled, and fetch the
// presigned archive without credentials (streamed and hashed, optionally only a byte range).

export type RevisionRef = string | number

/** createRevisionBundle; 201 for a new bundle, 200 for the existing one. */
export function createBundle(
  api: ApiClient,
  task: string,
  revision: RevisionRef,
  query: { wait?: number; rebuild?: boolean } = {},
): Promise<ApiResponse<Bundle>> {
  return api.call<Bundle>('createRevisionBundle', { path: { task, revision }, query })
}

/** getRevisionBundle; 404 when the revision has no bundle or it expired. */
export function getBundle(api: ApiClient, task: string, revision: RevisionRef, wait?: number): Promise<ApiResponse<Bundle>> {
  return api.call<Bundle>('getRevisionBundle', { path: { task, revision }, query: { wait } })
}

export function isSettled(bundle: Pick<Bundle, 'state'>): boolean {
  return bundle.state === 'ready' || bundle.state === 'failed'
}

/** Long-polls getRevisionBundle until the bundle is ready or failed. */
export async function waitForBundle(api: ApiClient, task: string, revision: RevisionRef, timeoutMs = 600_000): Promise<Bundle> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(120, Math.ceil((deadline - Date.now()) / 1000)))
    const bundle = ok(await getBundle(api, task, revision, wait), 'getRevisionBundle')
    if (isSettled(bundle)) return bundle
    if (Date.now() >= deadline) throw new Error(`the bundle of ${task}@${revision} is still ${bundle.state} after ${timeoutMs / 1000} s`)
  }
}

/**
 * Creates the bundle of a revision (or reuses it), waits until it settled and returns it; throws unless it is ready.
 * `created` is the status of the create call (201 new, 200 reused).
 */
export async function readyBundle(
  api: ApiClient,
  task: string,
  revision: RevisionRef,
  options: { rebuild?: boolean; timeoutMs?: number } = {},
): Promise<Bundle & { created: number }> {
  const response = await createBundle(api, task, revision, { rebuild: options.rebuild, wait: 120 })
  const created = ok(response, 'createRevisionBundle')
  const settled = isSettled(created) ? created : await waitForBundle(api, task, revision, options.timeoutMs)
  if (settled.state !== 'ready') throw new Error(`the bundle of ${task}@${revision} is ${settled.state}: ${JSON.stringify(settled.error)}`)
  return { ...settled, created: response.status }
}

export interface FetchedArchive {
  status: number
  headers: Record<string, string>
  /** bytes received */
  bytes: number
  /** SHA-256 (hex) of the bytes received */
  sha256: string
  /** the first bytes received (at most 64) */
  head: Buffer
}

/**
 * GETs a presigned bundle URL without credentials or Origin, streaming the body through a SHA-256 (archives are large).
 * `range` sends a `Range` header, which the presigned URL does not sign.
 */
export async function fetchArchive(url: string, options: { range?: string } = {}): Promise<FetchedArchive> {
  const response = await fetch(url, { headers: options.range ? { Range: options.range } : {}, redirect: 'manual' })
  const hash = createHash('sha256')
  const head: Buffer[] = []
  let headBytes = 0
  let bytes = 0
  if (response.body) {
    for await (const chunk of Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)) {
      const data = Buffer.from(chunk as Uint8Array)
      hash.update(data)
      bytes += data.length
      if (headBytes < 64) {
        head.push(data.subarray(0, 64 - headBytes))
        headBytes += Math.min(data.length, 64 - headBytes)
      }
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes, sha256: hash.digest('hex'), head: Buffer.concat(head) }
}
