import type { BuildErrorDoc } from '../../types/documents'
import { type PipelineCommandOptions, type PipelineCommandOutcome, runPipelineCommand } from './task-build'
import type { BuildResultImage, PackSummary } from './events'

// The script-build driver (docs/scripts.md): `scantor script build - --tag scripts/<scriptId>:<packSha256>
// --expect-name <name> --reuse-existing --events ndjson` with the same NDJSON events and exit codes as `task build`.
// The pipeline runs pack → static (scantor-script.yaml, Dockerfile policy) → build only: no describe, no type check,
// no push. Script images stay local to the master's Docker daemon.

/** The normalised run defaults of the script manifest; null `timeoutMs` = SCANTOR_SCRIPT_RUN_TIMEOUT. */
export interface ScriptBuildDefaults {
  timeoutMs: number | null
  resources: { cpus: number; memoryMiB: number }
}

/** The final `result` of `scantor script build`. */
export interface ScriptBuildResult {
  ok: boolean
  pack: PackSummary | null
  manifest: Record<string, unknown> | null
  entry: string | null
  defaults: ScriptBuildDefaults | null
  baseImage: { ref: string; digest: string } | null
  image: BuildResultImage | null
  errors: BuildErrorDoc[]
  warnings: string[]
  durationsMs: Record<string, number>
}

export type ScriptBuildOutcome = PipelineCommandOutcome<ScriptBuildResult>

export interface ScriptBuildOptions extends Omit<PipelineCommandOptions, 'push' | 'pushGate'> {
  tag: string
  expectName: string
  reuseExisting?: boolean
}

/** The local image of a script build: content-addressed by the pack hash, so unchanged code reuses it. */
export function scriptImageRef(scriptId: string, packSha256: string): string {
  return `scripts/${scriptId}:${packSha256}`
}

/** `^scripts/<uuid>:<sha256>$`: the tags script builds create (the gc removes old ones). */
export const SCRIPT_IMAGE_TAG = /^scripts\/[0-9a-f-]{36}:[0-9a-f]{64}$/

export function scriptBuildArgs(options: Pick<ScriptBuildOptions, 'tag' | 'expectName' | 'reuseExisting'>): string[] {
  return [
    'script',
    'build',
    '-',
    '--tag',
    options.tag,
    '--expect-name',
    options.expectName,
    ...(options.reuseExisting ? ['--reuse-existing'] : []),
    '--events',
    'ndjson',
  ]
}

/** Runs `scantor script build -` to completion and returns its outcome. Never rejects for pipeline failures. */
export function runScriptBuild(options: ScriptBuildOptions): Promise<ScriptBuildOutcome> {
  return runPipelineCommand<ScriptBuildResult>(scriptBuildArgs(options), options)
}
