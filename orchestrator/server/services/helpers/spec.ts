import type { ContainerCreateOptions } from 'dockerode'
import { EDITOR_HOME_VOLUME, EGRESS_NETWORK, WORKSPACES_VOLUME } from '../../utils/docker'
import { managedLabels, managedNamePrefix } from '../../utils/labels'
import { type HelperMount, type HelperNetwork, type HelperOp, ROOT_OPS, VOLUME_OPS } from './types'

// The container profile of workspace helpers (docs/editor.md §9.2, security.md WS-2): one throwaway container per
// operation, `scantor workspace <op>` in the scantor image, uid 1000:1000 with only the user's workspace subpath
// (none for `--archive`), network none (git: scantor-egress), read-only rootfs with a small noexec /tmp, no
// capabilities, no-new-privileges, pids/memory/CPU limits, no logs (output is read through attach) and the managed
// labels. `prepare`, `init` and `purge` mount the whole volumes; only `prepare`, which gives the volume roots to the
// helper user once per process, runs as root, with CHOWN and FOWNER.

export const HELPER_BINARY = '/usr/local/bin/scantor'
export const HELPER_WORKSPACE_DIR = '/workspace'
export const HELPER_VOLUMES_DIR = '/volumes'
export const HELPER_TMPFS = 'rw,nosuid,nodev,noexec,size=64m'
export const HELPER_USER = '1000:1000'
const ROOT_CAPS = ['CHOWN', 'FOWNER']

export interface HelperSpecInput {
  op: HelperOp
  userId: string
  args: string[]
  network: HelperNetwork
  mount: HelperMount
  /** extra environment; HOME=/tmp is always set */
  env: Record<string, string>
  image: string
  memoryBytes: number
  pidsLimit: number
  /** container name suffix (a uuid) */
  id: string
}

/** The mount layout of an operation: `--archive` reads stdin only; prepare, init and purge see both whole volumes. */
export function helperMountFor(op: HelperOp, args: readonly string[]): HelperMount {
  if (VOLUME_OPS.has(op)) return 'volumes'
  if ((op === 'list' || op === 'read') && args.includes('--archive')) return 'none'
  return 'user'
}

/** Engine API create options of one helper container. Pure: snapshot-tested per operation. */
export function helperContainerSpec(input: HelperSpecInput): ContainerCreateOptions {
  const root = ROOT_OPS.has(input.op)
  const mounts =
    input.mount === 'user'
      ? [
          {
            Type: 'volume' as const,
            Source: WORKSPACES_VOLUME,
            Target: HELPER_WORKSPACE_DIR,
            VolumeOptions: { Subpath: input.userId },
          },
        ]
      : input.mount === 'volumes'
        ? [
            { Type: 'volume' as const, Source: WORKSPACES_VOLUME, Target: `${HELPER_VOLUMES_DIR}/workspaces` },
            { Type: 'volume' as const, Source: EDITOR_HOME_VOLUME, Target: `${HELPER_VOLUMES_DIR}/editor-home` },
          ]
        : []
  const env = { ...input.env, HOME: '/tmp' }
  return {
    name: `${managedNamePrefix('helper')}${input.id}`,
    Image: input.image,
    Entrypoint: [HELPER_BINARY],
    Cmd: ['workspace', input.op, ...input.args],
    User: root ? '0:0' : HELPER_USER,
    Env: Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`),
    Labels: managedLabels('helper', { 'scantor.user': input.userId, 'scantor.op': input.op }),
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      NetworkMode: input.network === 'egress' ? EGRESS_NETWORK : 'none',
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': HELPER_TMPFS },
      CapDrop: ['ALL'],
      CapAdd: root ? ROOT_CAPS : undefined,
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: input.pidsLimit,
      Memory: input.memoryBytes,
      MemorySwap: input.memoryBytes,
      NanoCpus: 1_000_000_000,
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      Mounts: mounts as NonNullable<ContainerCreateOptions['HostConfig']>['Mounts'],
    },
  }
}
