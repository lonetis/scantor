import type { Config } from '../../utils/config'

// The `scantor` binary the orchestrator runs as a subprocess (task pipeline, template estimates) and injects into
// test-run containers. In the orchestrator image it is /usr/local/bin/scantor, a static linux binary of the host
// daemon's architecture.

export const SCANTOR_BINARY = '/usr/local/bin/scantor'

let binaryOverride: string | null = null
let runtimeBinaryOverride: string | null = null

/** The binary spawned for `scantor task …` and `scantor templates …`. */
export function scantorBinary(): string {
  return binaryOverride ?? SCANTOR_BINARY
}

/** The static linux binary injected as `/scantor/scantor` into test-run containers. */
export function runtimeBinary(): string {
  return runtimeBinaryOverride ?? scantorBinary()
}

/** Test seam: a fake or natively built binary (and, for injection on macOS hosts, a linux build). */
export function setScantorBinaryForTesting(binary: string | null, runtime: string | null = null): void {
  binaryOverride = binary
  runtimeBinaryOverride = runtime
}

/** A duration in the Go syntax the binary parses (docs/architecture.md §10). */
export function goDuration(ms: number): string {
  return `${Math.round(ms)}ms`
}

/**
 * The environment of every `scantor task …` / `scantor templates …` subprocess (docs/architecture.md §10, task
 * pipeline row): this deployment's image pair, the pipeline limits, the instance limits of manifest rule M8 and the
 * hosts of Dockerfile rule D5. Never SCANTOR_SECRET; the push password is added only for `--push`.
 */
export function pipelineEnv(config: Config, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: '/tmp',
    SCANTOR_IMAGE_PREFIX: config.imagePrefix,
    SCANTOR_IMAGE_TAG: config.imageTag,
    SCANTOR_BUILD_TIMEOUT: goDuration(config.buildTimeoutMs),
    SCANTOR_MAX_IMAGE_BYTES: String(config.maxImageBytes),
    SCANTOR_BUILD_CACHE_MAX_BYTES: String(config.buildCacheMaxBytes),
    SCANTOR_DESCRIBE_TIMEOUT: goDuration(config.describeTimeoutMs),
    SCANTOR_TASK_MAX_PACK_BYTES: String(config.taskMaxPackBytes),
    SCANTOR_TASK_MAX_FILES: String(config.taskMaxFiles),
    SCANTOR_TASK_MAX_BYTES: String(config.taskMaxBytes),
    SCANTOR_MAX_WORKERS_PER_SCAN: String(config.maxWorkersPerScan),
    SCANTOR_MAX_PROCESSES_PER_WORKER: String(config.maxProcessesPerWorker),
    SCANTOR_PUBLIC_URL: config.publicUrl,
    SCANTOR_REGISTRY_PUBLIC_HOST: config.registryPublicHost,
    ...extra,
  }
}
