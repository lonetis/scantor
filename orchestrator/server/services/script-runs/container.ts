import type { Readable } from 'node:stream'
import type Docker from 'dockerode'
import type { ContainerCreateOptions } from 'dockerode'
import { RUNTIME_HEALTHCHECK, SCRIPTS_NETWORK } from '../../utils/docker'
import { isManagedContainer, managedLabels, managedNamePrefix } from '../../utils/labels'
import { runtimeInjectionArchive } from '../pipeline/injection'

// The script-run container (docs/scripts.md): `scantor-s-<scriptRunId>` on the internal network scantor-scripts only
// (the orchestrator API and the internal S3 endpoint; no internet, RabbitMQ, workers or editors), the script image by
// id, the runtime injected by CopyToContainer as `/scantor/scantor` with entrypoint `/scantor/scantor runtime script
// --entry <entry>`, and the hardening profile: every capability dropped and none added, no-new-privileges, an init,
// PidsLimit 4096, memory + 256 MiB (swap equal), CPUs as NanoCpus, the OOM killer's first choice, nofile 65536, the
// `local` log driver with 5 × 50 MiB (the log follower resumes from it after an orchestrator restart), no restart
// policy, never privileged, no mounts, the runtime healthcheck. Its only credentials are the run-scoped token and the
// internal URL in its environment.

export const SCRIPT_RUN_PIDS_LIMIT = 4096
export const NOFILE_LIMIT = 65_536
export const SCRIPT_LOG_MAX_SIZE = '50m'
export const SCRIPT_LOG_MAX_FILES = '5'
export const MEMORY_OVERHEAD_BYTES = 256 * 1024 ** 2
export const OOM_SCORE_ADJ = 1000
/** `docker stop -t` of a cancel or timeout: the runtime kills the script 50 s after SIGTERM. */
export const STOP_TIMEOUT_SECONDS = 60

export function scriptRunContainerName(scriptRunId: string): string {
  return `${managedNamePrefix('scriptRun')}${scriptRunId}`
}

export function scriptRunLabels(input: { scriptRunId: string; userId: string }): Record<string, string> {
  return managedLabels('scriptRun', { 'scantor.user': input.userId, 'scantor.script-run': input.scriptRunId })
}

/** True when a container found by name is this run's container (managed labels, prefix and run id). */
export function isScriptRunContainer(scriptRunId: string, name: string, labels: Record<string, string> | undefined): boolean {
  return isManagedContainer('scriptRun', name.replace(/^\//, ''), labels ?? {}, { 'scantor.script-run': scriptRunId })
}

export interface ScriptRunContainerInput {
  scriptRunId: string
  userId: string
  /** the script image id */
  image: string
  entry: string
  resources: { cpus: number; memoryMiB: number }
  /** SCANTOR_INTERNAL_URL */
  url: string
  /** the run-scoped `ssr_` token */
  token: string
}

export function scriptRunContainerSpec(input: ScriptRunContainerInput): ContainerCreateOptions & { name: string } {
  const memory = input.resources.memoryMiB * 1024 ** 2 + MEMORY_OVERHEAD_BYTES
  return {
    name: scriptRunContainerName(input.scriptRunId),
    Image: input.image,
    Entrypoint: ['/scantor/scantor', 'runtime', 'script', '--entry', input.entry],
    Cmd: [],
    Env: [`SCANTOR_URL=${input.url}`, `SCANTOR_SCRIPT_TOKEN=${input.token}`],
    Healthcheck: { ...RUNTIME_HEALTHCHECK, Test: [...RUNTIME_HEALTHCHECK.Test] },
    Labels: scriptRunLabels(input),
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      NetworkMode: SCRIPTS_NETWORK,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidsLimit: SCRIPT_RUN_PIDS_LIMIT,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(input.resources.cpus * 1e9),
      OomScoreAdj: OOM_SCORE_ADJ,
      Ulimits: [{ Name: 'nofile', Soft: NOFILE_LIMIT, Hard: NOFILE_LIMIT }],
      LogConfig: { Type: 'local', Config: { 'max-size': SCRIPT_LOG_MAX_SIZE, 'max-file': SCRIPT_LOG_MAX_FILES } },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
  }
}

/** The injection tar extracted at `/`: `scantor/` (0755) and `scantor/scantor` (0755, the runtime binary), owned by 0:0. */
export function runtimeArchive(binaryPath: string): Readable {
  return runtimeInjectionArchive(binaryPath)
}

/** Force-removes a container by id; one that is already gone is no error. */
export async function removeContainerById(docker: Docker, id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true, v: true })
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error
  }
}

/** `docker stop -t 60` by id; a container that is gone or already stopped is no error. */
export async function stopContainerById(docker: Docker, id: string, seconds = STOP_TIMEOUT_SECONDS): Promise<void> {
  try {
    await docker.getContainer(id).stop({ t: seconds })
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status !== 404 && status !== 304) throw error
  }
}

export interface ContainerStatus {
  id: string
  name: string
  labels: Record<string, string>
  status: string
  exitCode: number
  oomKilled: boolean
}

/** Inspects a container by id or name; null when it does not exist. */
export async function inspectContainer(docker: Docker, idOrName: string): Promise<ContainerStatus | null> {
  try {
    const info = await docker.getContainer(idOrName).inspect()
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      labels: info.Config?.Labels ?? {},
      status: info.State.Status,
      exitCode: info.State.ExitCode,
      oomKilled: info.State.OOMKilled,
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null
    throw error
  }
}
