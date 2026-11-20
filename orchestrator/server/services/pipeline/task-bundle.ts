import { Readable } from 'node:stream'
import type { BundleInfo } from '#shared/types/bundles'
import type { BundleResult } from './events'
import { type PipelineCommandOptions, type PipelineCommandOutcome, runPipelineCommand } from './task-build'

// The bundle driver (docs/tasks.md §9.11): `scantor task bundle - --image <ref> --pull <repo@sha256:…> --output-fd 3
// --events ndjson` with the bundle info (/scantor/bundle.json, built by services/bundles/info.ts) on stdin, the NDJSON
// events of the task pipeline on stdout and the gzip archive on fd 3. The step uses the local revision image when it
// still carries the pinned digest and otherwise pulls it from the master registry with the orchestrator credential
// (SCANTOR_REGISTRY_PUSH_PASSWORD in the environment). Exit codes as for `task build`: 0 ok, 2 content error (phase
// `build`), 3 platform error.

export type TaskBundleOutcome = PipelineCommandOutcome<BundleResult>

export interface TaskBundleOptions extends Omit<PipelineCommandOptions, 'input' | 'push' | 'pushGate' | 'output'> {
  /** the bundle info, sent as JSON on stdin */
  info: BundleInfo
  /** the local revision image (`localhost:<port>/tasks/<taskId>:<revisionId>`) */
  image: string
  /** the revision image by digest (`localhost:<port>/tasks/<taskId>@sha256:…`), pulled when the local one is gone */
  pull: string
  /** reads the archive from fd 3 to its end; whatever it waits for beyond the stream must end on `signal` */
  output: (stream: Readable, signal: AbortSignal) => Promise<void>
}

export function taskBundleArgs(options: Pick<TaskBundleOptions, 'image' | 'pull'>): string[] {
  return ['task', 'bundle', '-', '--image', options.image, '--pull', options.pull, '--output-fd', '3', '--events', 'ndjson']
}

/** Runs `scantor task bundle -` to completion and returns its outcome. Never rejects for pipeline failures. */
export function runTaskBundle(options: TaskBundleOptions): Promise<TaskBundleOutcome> {
  const { info, image, pull, ...rest } = options
  return runPipelineCommand<BundleResult>(taskBundleArgs({ image, pull }), { ...rest, input: Readable.from([Buffer.from(JSON.stringify(info))]) })
}
