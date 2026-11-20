import type { BundleInfo, BundleInfoLimits, BundleInfoSettings, BundlePlatform } from '#shared/types/bundles'
import type { Description } from '#shared/types/common'
import type { RevisionDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { mergeSettings } from '../configs/settings'
import { LOG_TAIL_BYTES, LOG_TAIL_EARLIER_BYTES } from '../test-runs/container'

// The bundle info (/scantor/bundle.json, schemas/bundle.schema.json, docs/runtime.md §15.7, security.md BDL-1): the
// revision's describe output, its settings defaults and the platform limits of a run, built as an allowlist from the
// revision document. Every value is copied field by field, so nothing else of the document (ids, keys, the owner, the
// image digest, the registry) can reach the image; the Go step parses it again strictly (internal/bundle) before it
// writes it. Secret defaults never appear: describe already strips the `default` of writeOnly fields. Data-source
// overrides of the master are deliberately absent: a bundle run uses the compiled-in public URLs unless the recipient
// passes its own (`docker run -e SCANTOR_TRANCO_URL=…`). The names mirror Go bundle.ImageName and bundle.FileName.

export const BUNDLE_INFO_VERSION = 1
/** The registry domain of a bundle's image name: a recipient who forgets `docker load` never pulls a public image. */
export const BUNDLE_IMAGE_PREFIX = 'localhost/scantor/'

export type BundleInfoConfig = Pick<Config, 'maxAnalysisConfigBytes' | 'maxResultBytes' | 'maxFileBytes' | 'maxFilesPerAnalysis' | 'maxProcessesPerWorker'>

/** `localhost/scantor/<task>:<number>` (Go bundle.ImageName). */
export function bundleImageName(task: string, revision: number): string {
  return `${BUNDLE_IMAGE_PREFIX}${task}:${revision}`
}

/** `<task>@<number>`. */
export function bundleRef(task: string, revision: number): string {
  return `${task}@${revision}`
}

/** `<task>-<number>-<os>-<arch>.bundle.tar.gz` (Go bundle.FileName; the architecture variant is not part of it). */
export function bundleFileName(task: string, revision: number, platform: Pick<BundlePlatform, 'os' | 'arch'>): string {
  return `${task}-${revision}-${platform.os}-${platform.arch}.bundle.tar.gz`
}

function descriptionOf(revision: RevisionDoc): Description {
  const description = revision.description
  if (!description) throw new Error(`revision ${revision.taskName}@${revision.number} has no describe output`)
  const { schemas, secretPaths, uploadPaths } = description
  return {
    protocolVersion: description.protocolVersion,
    connector: { language: description.connector.language, version: description.connector.version },
    schemas: { taskConfig: schemas.taskConfig, scanConfig: schemas.scanConfig, analysisConfig: schemas.analysisConfig, result: schemas.result },
    schedule:
      description.schedule.kind === 'template' && description.schedule.template
        ? { kind: 'template', template: description.schedule.template }
        : { kind: 'custom' },
    secretPaths: {
      taskConfig: [...secretPaths.taskConfig],
      scanConfig: [...secretPaths.scanConfig],
      analysisConfig: [...secretPaths.analysisConfig],
      result: [...secretPaths.result],
    },
    uploadPaths: { taskConfig: [...uploadPaths.taskConfig], scanConfig: [...uploadPaths.scanConfig] },
    fileRefPaths: [...description.fileRefPaths],
    warnings: [...(description.warnings ?? [])],
  }
}

/** The revision's settings defaults (fallbacks filled) without workers, nodeSelector and privileged. */
export function bundleSettings(revision: Pick<RevisionDoc, 'settingsDefaults'>): BundleInfoSettings {
  const settings = mergeSettings(revision.settingsDefaults, undefined, false)
  const { backoff, resources } = settings
  return {
    processes: settings.processes,
    timeoutMs: settings.timeoutMs,
    maxAttempts: settings.maxAttempts,
    backoff: { initialMs: backoff.initialMs, factor: backoff.factor, maxMs: backoff.maxMs, jitter: backoff.jitter },
    resources: { cpus: resources.cpus, memoryMiB: resources.memoryMiB },
    maxAnalysesPerProcess: settings.maxAnalysesPerProcess,
  }
}

/** The limits of a test run on this master, plus the processes bound of SCANTOR_MAX_PROCESSES_PER_WORKER. */
export function bundleLimits(config: BundleInfoConfig): BundleInfoLimits {
  return {
    maxAnalysisConfigBytes: config.maxAnalysisConfigBytes,
    maxResultBytes: config.maxResultBytes,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerAnalysis: config.maxFilesPerAnalysis,
    logTailBytes: LOG_TAIL_BYTES,
    logTailEarlierBytes: LOG_TAIL_EARLIER_BYTES,
    maxProcesses: config.maxProcessesPerWorker,
  }
}

/** The bundle info of a ready revision; throws when the revision lacks a build output it needs. */
export function bundleInfo(revision: RevisionDoc, config: BundleInfoConfig): BundleInfo {
  const entry = revision.manifest?.entry
  if (typeof entry !== 'string' || entry === '') throw new Error(`revision ${revision.taskName}@${revision.number} has no entry`)
  if (!revision.language) throw new Error(`revision ${revision.taskName}@${revision.number} has no language`)
  if (!revision.image) throw new Error(`revision ${revision.taskName}@${revision.number} has no image`)
  return {
    v: BUNDLE_INFO_VERSION,
    image: bundleImageName(revision.taskName, revision.number),
    ref: bundleRef(revision.taskName, revision.number),
    task: revision.taskName,
    revision: revision.number,
    language: revision.language,
    entry,
    platform: { os: revision.image.platform.os, arch: revision.image.platform.arch },
    description: descriptionOf(revision),
    settings: bundleSettings(revision),
    limits: bundleLimits(config),
  }
}
