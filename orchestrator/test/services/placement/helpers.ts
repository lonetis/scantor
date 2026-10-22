import type { PlacementNode, PlacementScan, PlacementSnapshot, PlacementWorker } from '../../../server/services/placement/types'

// Builders of placement snapshots (docs/nodes.md §12): plain data with readable defaults, overridden per test.

export const GiB = 1024 ** 3
export const T0 = new Date('2026-10-21T10:00:00.000Z')

export function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

export function scan(id: string, overrides: Partial<PlacementScan> & { settings?: Partial<PlacementScan['settings']>; revision?: Partial<PlacementScan['revision']> } = {}): PlacementScan {
  const { settings, revision, ...rest } = overrides
  return {
    id,
    userId: 'user-a',
    state: 'running',
    createdAt: T0,
    startedAt: T0,
    schedulingState: 'running',
    ...rest,
    settings: {
      workers: 1,
      processes: 1,
      resources: { cpus: 1, memoryMiB: 512 },
      nodeSelector: { pool: 'shared', labels: {} },
      ...settings,
    },
    revision: {
      repository: `tasks/${id}`,
      digest: `sha256:${id}`,
      platform: { os: 'linux', arch: 'amd64' },
      privileged: false,
      ...revision,
    },
  }
}

export function worker(id: string, scanId: string, overrides: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id,
    scanId,
    userId: 'user-a',
    role: 'runner',
    state: 'pending',
    nodeId: null,
    createdAt: T0,
    digest: `sha256:${scanId}`,
    resources: { cpus: 1, memoryMiB: 512 },
    privileged: false,
    processes: { desired: 1, assigned: 0, running: null },
    reason: null,
    ...overrides,
  }
}

export function node(id: string, overrides: Partial<PlacementNode> & { info?: Partial<NonNullable<PlacementNode['info']>> | null } = {}): PlacementNode {
  const { info, ...rest } = overrides
  return {
    id,
    builtIn: false,
    state: 'online',
    cordoned: false,
    hasToken: true,
    pool: 'shared',
    labels: {},
    maxWorkers: null,
    ...rest,
    info:
      info === null
        ? null
        : {
            os: 'linux',
            arch: 'amd64',
            cpus: 8,
            memoryBytes: 32 * GiB,
            diskFreeBytes: 100 * GiB,
            dindMode: 'disabled',
            maxWorkers: 8,
            ...info,
          },
  }
}

export function snapshot(parts: Partial<PlacementSnapshot>): PlacementSnapshot {
  return {
    now: at(60),
    scans: [],
    workers: [],
    nodes: [],
    userMaxWorkers: {},
    busy: {},
    minFreeDiskBytes: 5 * GiB,
    maxConcurrentPulls: 4,
    ...parts,
  }
}
