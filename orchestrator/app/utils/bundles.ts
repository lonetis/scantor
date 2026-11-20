import type { Bundle, BundlePlatform } from '#shared/types/bundles'
import type { Revision } from '#shared/types/revisions'
import type { BundleState } from '#shared/utils/enums'
import { formatBytes, formatRelativeTime } from './format'

// Bundles of a revision (docs/ui.md §5.9; docs/api.md §2): pure helpers of the revision page's "Bundle" button and
// BundleModal. A bundle is a gzip Docker image archive of one ready revision that runs with only Docker.

/** The disclosure shown before a bundle is created (docs/security.md R23). */
export const BUNDLE_WARNING = 'A bundle contains the complete task image, including every file of the task folder. Anyone with the file can run and inspect it.'

/** A presigned download is re-read when it expires within this margin. */
export const BUNDLE_DOWNLOAD_MARGIN_MS = 30_000

/** True while the bundle job has not settled (the modal polls then). */
export function isBundleActive(state: BundleState | null | undefined): boolean {
  return state === 'queued' || state === 'running'
}

export interface BundleAvailability {
  enabled: boolean
  /** Why the "Bundle" button is disabled (its tooltip); null when enabled. */
  reason: string | null
}

/** Whether a revision can be bundled: ready and not privileged (the server's 409 rules, in the same order). */
export function canBundle(revision: Pick<Revision, 'state' | 'privileged'> | null | undefined): BundleAvailability {
  if (!revision) return { enabled: false, reason: 'The revision is loading' }
  if (revision.state === 'queued' || revision.state === 'building')
    return { enabled: false, reason: 'Only ready revisions can be bundled; this one is still building' }
  if (revision.state !== 'ready') return { enabled: false, reason: 'Failed revisions cannot be bundled' }
  if (revision.privileged) return { enabled: false, reason: 'Privileged revisions cannot be bundled' }
  return { enabled: true, reason: null }
}

/** "linux/amd64", "linux/arm64/v8". */
export function bundlePlatformLabel(platform: BundlePlatform): string {
  return [platform.os, platform.arch, platform.variant].filter((part) => part).join('/')
}

/** The archive size, "–" until the bundle is ready. */
export function bundleSizeLabel(bundle: Pick<Bundle, 'bytes'>): string {
  return formatBytes(bundle.bytes)
}

/** "expires in 7 days", or "expired". */
export function bundleExpiryLabel(bundle: Pick<Bundle, 'expiresAt'>, now: number = Date.now()): string {
  const at = Date.parse(bundle.expiresAt)
  if (Number.isNaN(at)) return '–'
  return at <= now ? 'expired' : `expires ${formatRelativeTime(at, now)}`
}

/** Time since the bundle was requested, until it settled. */
export function bundleElapsedMs(bundle: Pick<Bundle, 'createdAt' | 'finishedAt'>, now: number = Date.now()): number {
  const end = bundle.finishedAt ? Date.parse(bundle.finishedAt) : now
  return Math.max(0, end - Date.parse(bundle.createdAt))
}

/** True when the bundle's presigned download stays valid for longer than the margin. */
export function bundleDownloadFresh(bundle: Pick<Bundle, 'download'>, now: number = Date.now(), marginMs = BUNDLE_DOWNLOAD_MARGIN_MS): boolean {
  return bundle.download !== null && Date.parse(bundle.download.expiresAt) - now > marginMs
}

export interface BundleCommandLine {
  key: keyof Bundle['commands']
  title: string
  code: string
}

/** The recipient's commands in the order they are used: load once, run, describe. */
export function bundleCommandLines(bundle: Pick<Bundle, 'commands'>): BundleCommandLine[] {
  return [
    { key: 'load', title: 'Load once', code: bundle.commands.load },
    { key: 'run', title: 'Run', code: bundle.commands.run },
    { key: 'describe', title: 'Describe', code: bundle.commands.describe },
  ]
}
