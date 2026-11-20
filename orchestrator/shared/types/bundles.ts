import type { BundleState } from '../utils/enums'
import type { Backoff, Description, IsoDate, Platform, ProcessResources } from './common'

// Bundle representations (docs/api.md §2; docs/data-model.md §4.21) and the bundle info baked into a bundle
// image at /scantor/bundle.json (schemas/bundle.schema.json, Go internal/bundle.Info).

/** Image platform of a bundle; bundles are single-architecture. */
export interface BundlePlatform extends Platform {
  variant?: string
}

export interface Bundle {
  id: string
  revision: { id: string; number: number; ref: string }
  state: BundleState
  /** `localhost/scantor/<task>:<number>` */
  image: string
  platform: BundlePlatform
  /** Archive size; set when `ready`. */
  bytes: number | null
  /** Archive SHA-256 (hex); set when `ready`. */
  sha256: string | null
  /** Version of the runtime baked into the image; set when `ready`. */
  scantorVersion: string | null
  /** Set when `failed`. */
  error: { code: string; message: string } | null
  createdAt: IsoDate
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  expiresAt: IsoDate
  /** Presigned anew with every representation; non-null only when `ready`. */
  download: { url: string; expiresAt: IsoDate; fileName: string } | null
  /** The recipient's copy-paste lines. */
  commands: { load: string; run: string; describe: string }
}

/** The revision's settings defaults without workers, nodeSelector and privileged. */
export interface BundleInfoSettings {
  processes: number
  timeoutMs: number
  maxAttempts: number
  backoff: Backoff
  resources: ProcessResources
  maxAnalysesPerProcess: number
}

/** The test-run limits of the master plus the processes bound (SCANTOR_MAX_PROCESSES_PER_WORKER). */
export interface BundleInfoLimits {
  maxAnalysisConfigBytes: number
  maxResultBytes: number
  maxFileBytes: number
  maxFilesPerAnalysis: number
  logTailBytes: number
  logTailEarlierBytes: number
  maxProcesses: number
}

/** `/scantor/bundle.json`: an allowlist without secrets, credentials, master URLs, ids or data-source overrides. */
export interface BundleInfo {
  v: 1
  /** `localhost/scantor/<task>:<revision>` */
  image: string
  /** `<task>@<revision>` */
  ref: string
  task: string
  revision: number
  language: string
  entry: string
  platform: BundlePlatform
  description: Description
  settings: BundleInfoSettings
  limits: BundleInfoLimits
}
