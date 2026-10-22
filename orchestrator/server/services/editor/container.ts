import type Docker from 'dockerode'
import type { Config } from '../../utils/config'
import { EDITOR_HOME_VOLUME, WORKSPACES_VOLUME } from '../../utils/docker'
import { isManagedContainer, managedLabels } from '../../utils/labels'
import { WORKSPACE_ROOT } from './sessions'

/*
 * The per-user editor container (docs/editor.md §4, security.md ED-3, ED-5, ED-6) and the Docker operations of the
 * editor manager. The container runs the scantor-editor image as 1000:1000 with a read-only rootfs, no capabilities,
 * no Docker socket and only the user's subpaths of the home, workspace and socket volumes; code-server listens on a
 * unix socket only. Its environment holds exactly the four variables of docs/editor.md §5.
 */

export const EDITOR_NAME_PREFIX = 'scantor-editor-'
export const EDITOR_IMAGE = 'scantor-editor'
export const SANDBOX_NETWORK = 'scantor-sandbox'
export const EDITOR_SOCKETS_VOLUME = 'scantor-editor-sockets'
export const EDITOR_SOCKET_MOUNT = '/run/scantor-editor'
export const EDITOR_HOME = '/home/coder'
export const EDITOR_STOP_TIMEOUT_S = 10

export type EditorContainerConfig = Pick<
  Config,
  'imagePrefix' | 'imageTag' | 'internalUrl' | 'editorMemoryLimitBytes' | 'editorCpus' | 'editorPidsLimit' | 'editorTmpfsSizeBytes'
>

export function editorContainerName(userId: string): string {
  return `${EDITOR_NAME_PREFIX}${userId}`
}

/** `<SCANTOR_IMAGE_PREFIX>scantor-editor:<SCANTOR_IMAGE_TAG>`, recorded in `editors.image` at every start. */
export function editorImageRef(config: Pick<Config, 'imagePrefix' | 'imageTag'>): string {
  return `${config.imagePrefix}${EDITOR_IMAGE}:${config.imageTag}`
}

/** code-server's arguments (docs/editor.md §2.4). Workspace trust stays on: --disable-workspace-trust is never set. */
export function codeServerArgs(email: string): string[] {
  return [
    '--socket', `${EDITOR_SOCKET_MOUNT}/code.sock`,
    '--socket-mode', '600',
    '--auth', 'none',
    '--disable-proxy',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-getting-started-override',
    '--user-data-dir', `${EDITOR_HOME}/.local/share/code-server`,
    '--extensions-dir', '/opt/code-server/extensions',
    '--app-name', `scantor (${email})`,
    WORKSPACE_ROOT,
  ]
}

interface VolumeMount {
  Type: 'volume'
  Source: string
  Target: string
  VolumeOptions: { Subpath: string }
}

/** The Engine API body of `POST /containers/create?name=scantor-editor-<userId>` (docs/editor.md §4). */
export interface EditorContainerSpec {
  name: string
  Image: string
  User: string
  Cmd: string[]
  Env: string[]
  Hostname: string
  Labels: Record<string, string>
  StopTimeout: number
  HostConfig: {
    Init: boolean
    RestartPolicy: { Name: 'no' }
    NetworkMode: string
    CapDrop: string[]
    SecurityOpt: string[]
    ReadonlyRootfs: boolean
    PidsLimit: number
    Memory: number
    MemorySwap: number
    NanoCpus: number
    Tmpfs: Record<string, string>
    LogConfig: { Type: 'local'; Config: Record<string, string> }
    Mounts: VolumeMount[]
  }
  NetworkingConfig: { EndpointsConfig: Record<string, Record<string, never>> }
}

export interface EditorContainerInput {
  userId: string
  email: string
  image: string
  /** the user's current `editor` API key */
  apiKey: string
}

export function editorContainerSpec(input: EditorContainerInput, config: EditorContainerConfig): EditorContainerSpec {
  const subpathMount = (source: string, target: string): VolumeMount => ({
    Type: 'volume',
    Source: source,
    Target: target,
    VolumeOptions: { Subpath: input.userId },
  })
  return {
    name: editorContainerName(input.userId),
    Image: input.image,
    User: '1000:1000',
    Cmd: codeServerArgs(input.email),
    Env: [
      `SCANTOR_URL=${config.internalUrl}`,
      `SCANTOR_TOKEN=${input.apiKey}`,
      'SCANTOR_DEV_MODE=remote',
      `SCANTOR_WORKSPACE=${WORKSPACE_ROOT}`,
    ],
    Hostname: 'editor',
    Labels: managedLabels('editor', { 'scantor.user': input.userId }),
    StopTimeout: EDITOR_STOP_TIMEOUT_S,
    HostConfig: {
      Init: true,
      RestartPolicy: { Name: 'no' },
      NetworkMode: SANDBOX_NETWORK,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      PidsLimit: config.editorPidsLimit,
      Memory: config.editorMemoryLimitBytes,
      MemorySwap: config.editorMemoryLimitBytes,
      NanoCpus: Math.round(config.editorCpus * 1e9),
      Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${config.editorTmpfsSizeBytes}` },
      LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
      Mounts: [
        subpathMount(EDITOR_HOME_VOLUME, EDITOR_HOME),
        subpathMount(WORKSPACES_VOLUME, WORKSPACE_ROOT),
        subpathMount(EDITOR_SOCKETS_VOLUME, EDITOR_SOCKET_MOUNT),
      ],
    },
    NetworkingConfig: { EndpointsConfig: { [SANDBOX_NETWORK]: {} } },
  }
}

// ── Docker operations ────────────────────────────────────────────────────────

export interface EditorContainerState {
  running: boolean
  exitCode: number | null
}

export interface EditorContainerSummary {
  id: string
  name: string
  /** the `scantor.user` label */
  userId: string | null
  running: boolean
}

/** What the editor manager and reaper need from Docker (a seam for unit tests). */
export interface EditorDocker {
  imageExists(ref: string): Promise<boolean>
  pullImage(ref: string): Promise<void>
  createAndStart(spec: EditorContainerSpec): Promise<string>
  /** `POST /containers/<name>/stop?t=10` then `DELETE …?force=true`; a missing container is fine */
  stopAndRemove(name: string): Promise<void>
  /** `DELETE /containers/<name>?force=true`; a missing container is fine */
  remove(name: string): Promise<void>
  inspect(name: string): Promise<EditorContainerState | null>
  /** every container that carries the editor's managed labels and name prefix */
  listEditors(): Promise<EditorContainerSummary[]>
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode
}

export function dockerEditorOperations(docker: Docker): EditorDocker {
  async function remove(name: string): Promise<void> {
    try {
      await docker.getContainer(name).remove({ force: true })
    } catch (error) {
      const status = statusOf(error)
      // 404: gone; 409: removal already in progress.
      if (status !== 404 && status !== 409) throw error
    }
  }

  return {
    async imageExists(ref) {
      try {
        await docker.getImage(ref).inspect()
        return true
      } catch (error) {
        if (statusOf(error) === 404) return false
        throw error
      }
    },

    async pullImage(ref) {
      const stream = await docker.pull(ref)
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error: Error | null, events: { error?: string }[]) => {
          const failed = events?.find((event) => event.error)
          if (error) reject(error)
          else if (failed) reject(new Error(`pulling ${ref} failed: ${failed.error}`))
          else resolve()
        })
      })
    },

    async createAndStart(spec) {
      // The spec is the exact Engine API body; dockerode's types predate some of its fields (volume subpaths).
      const container = await docker.createContainer(spec as unknown as Docker.ContainerCreateOptions)
      await container.start()
      return container.id
    },

    async stopAndRemove(name) {
      const container = docker.getContainer(name)
      try {
        await container.stop({ t: EDITOR_STOP_TIMEOUT_S })
      } catch (error) {
        // 304: already stopped; 404: gone.
        const status = statusOf(error)
        if (status !== 304 && status !== 404) throw error
      }
      await remove(name)
    },

    remove,

    async inspect(name) {
      try {
        const info = await docker.getContainer(name).inspect()
        return { running: info.State.Running === true, exitCode: info.State.Running ? null : (info.State.ExitCode ?? null) }
      } catch (error) {
        if (statusOf(error) === 404) return null
        throw error
      }
    },

    async listEditors() {
      const containers = await docker.listContainers({ all: true, filters: { label: ['scantor.managed=true', 'scantor.kind=editor'] } })
      return containers
        .map((container) => ({ container, name: (container.Names[0] ?? '').replace(/^\//, '') }))
        .filter(({ container, name }) => isManagedContainer('editor', name, container.Labels))
        .map(({ container, name }) => ({
          id: container.Id,
          name,
          userId: container.Labels['scantor.user'] ?? null,
          running: container.State === 'running',
        }))
    },
  }
}
