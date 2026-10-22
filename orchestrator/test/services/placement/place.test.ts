import { describe, expect, it } from 'vitest'
import { chooseNode, placementOrder, planPlacement } from '../../../server/services/placement/place'
import { NodeView } from '../../../server/services/placement/node-view'
import type { PlacementSnapshot } from '../../../server/services/placement/types'
import { at, GiB, node, scan, snapshot, worker } from './helpers'

// Placement phase 2 (docs/nodes.md §12.2–§12.6): hard filters in a fixed order with pending reasons, the stable
// spread score, the scheduler's preference for the built-in node, reservations within one pass and live resize.

function placeOne(parts: Partial<PlacementSnapshot>) {
  return planPlacement(snapshot({ scans: [scan('s1')], workers: [worker('w1', 's1')], ...parts }))
}

describe('planPlacement: filters and pending reasons', () => {
  it('places a pending runner on the only online node', () => {
    const plan = placeOne({ nodes: [node('n1')] })
    expect(plan.placements).toEqual([{ workerId: 'w1', scanId: 's1', nodeId: 'n1', dindMode: null, assigned: 1 }])
    expect(plan.pending).toEqual([])
    expect(plan.touchedNodes).toEqual(['n1'])
    expect(plan.conditions).toEqual({ s1: null })
  })

  it.each([
    ['no nodes at all', []],
    ['an offline node', [node('n1', { state: 'offline' })]],
    ['a pending node', [node('n1', { state: 'pending' })]],
    ['a revoked node', [node('n1', { state: 'revoked', hasToken: false })]],
    ['a cordoned node', [node('n1', { cordoned: true })]],
    ['an online node without a token', [node('n1', { hasToken: false })]],
    ['an online node that never reported', [node('n1', { info: null })]],
  ])('noNodes with %s', (_name, nodes) => {
    const plan = placeOne({ nodes })
    expect(plan.placements).toEqual([])
    expect(plan.pending).toEqual([{ workerId: 'w1', scanId: 's1', reason: 'noNodes', previous: null }])
    expect(plan.conditions.s1).toEqual({ count: 1, reasons: { noNodes: 1 } })
  })

  it('archMismatch when the platform differs (architecture or os)', () => {
    expect(placeOne({ nodes: [node('n1', { info: { arch: 'arm64' } })] }).pending[0]?.reason).toBe('archMismatch')
    expect(placeOne({ nodes: [node('n1', { info: { os: 'windows' } })] }).pending[0]?.reason).toBe('archMismatch')
  })

  it('selectorMismatch for another pool or missing labels; labels are a subset match', () => {
    const labelled = scan('s1', { settings: { nodeSelector: { pool: 'shared', labels: { region: 'eu' } } } })
    expect(placeOne({ nodes: [node('n1', { pool: 'gpu' })] }).pending[0]?.reason).toBe('selectorMismatch')
    expect(placeOne({ scans: [labelled], nodes: [node('n1', { labels: { region: 'us' } })] }).pending[0]?.reason).toBe('selectorMismatch')
    expect(placeOne({ scans: [labelled], nodes: [node('n1', { labels: { region: 'eu', disk: 'ssd' } })] }).placements).toHaveLength(1)
  })

  it('dindUnavailable for privileged workers on nodes without DinD; the node mode is recorded at placement', () => {
    const privileged = { scans: [scan('s1', { revision: { privileged: true } })], workers: [worker('w1', 's1', { privileged: true })] }
    expect(placeOne({ ...privileged, nodes: [node('n1')] }).pending[0]?.reason).toBe('dindUnavailable')
    expect(placeOne({ ...privileged, nodes: [node('n1', { info: { dindMode: 'sysbox' } })] }).placements[0]?.dindMode).toBe('sysbox')
    expect(placeOne({ ...privileged, nodes: [node('n1', { info: { dindMode: 'privileged' } })] }).placements[0]?.dindMode).toBe('privileged')
    expect(placeOne({ nodes: [node('n1', { info: { dindMode: 'sysbox' } })] }).placements[0]?.dindMode).toBeNull()
  })

  it('diskLow below the minimum free disk', () => {
    expect(placeOne({ nodes: [node('n1', { info: { diskFreeBytes: 1 * GiB } })] }).pending[0]?.reason).toBe('diskLow')
    expect(placeOne({ nodes: [node('n1', { info: { diskFreeBytes: 5 * GiB } })] }).placements).toHaveLength(1)
  })

  it('insufficientCapacity when slots, CPU or memory would be exceeded', () => {
    const busy = worker('busy', 's9', { state: 'running', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    expect(placeOne({ nodes: [node('n1', { info: { maxWorkers: 1 } })], workers: [worker('w1', 's1'), busy] }).pending[0]?.reason).toBe('insufficientCapacity')
    expect(placeOne({ nodes: [node('n1', { maxWorkers: 0 })] }).pending[0]?.reason).toBe('insufficientCapacity')
    expect(placeOne({ nodes: [node('n1', { info: { cpus: 2 } })], workers: [worker('w1', 's1', { processes: { desired: 3, assigned: 0, running: null } })] }).pending[0]?.reason).toBe(
      'insufficientCapacity',
    )
    // 2 × 512 MiB + 256 MiB overhead does not fit into 1 GiB
    expect(placeOne({ nodes: [node('n1', { info: { memoryBytes: 1 * GiB } })], workers: [worker('w1', 's1', { processes: { desired: 2, assigned: 0, running: null } })] }).pending[0]?.reason).toBe(
      'insufficientCapacity',
    )
    // exactly full is allowed: 1 × 512 MiB + 256 MiB
    expect(placeOne({ nodes: [node('n1', { info: { memoryBytes: 768 * 1024 * 1024 } })] }).placements).toHaveLength(1)
  })

  it('pullLimit while too many pulls of the image are in flight, unless the node already has it', () => {
    const pulling = worker('p1', 's1', { state: 'pulling', nodeId: 'n2', processes: { desired: 1, assigned: 1, running: null } })
    const plan = placeOne({ maxConcurrentPulls: 1, nodes: [node('n1'), node('n2', { cordoned: true })], workers: [worker('w1', 's1'), pulling] })
    expect(plan.pending[0]?.reason).toBe('pullLimit')

    const running = worker('r1', 's1', { state: 'running', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    const withImage = placeOne({ maxConcurrentPulls: 1, nodes: [node('n1'), node('n2', { cordoned: true })], workers: [worker('w1', 's1'), pulling, running] })
    expect(withImage.placements[0]?.nodeId).toBe('n1')
  })

  it('counts pulls started by this pass toward the pull limit', () => {
    const plan = planPlacement(
      snapshot({ maxConcurrentPulls: 1, scans: [scan('s1', { settings: { workers: 2 } })], workers: [worker('w1', 's1'), worker('w2', 's1')], nodes: [node('n1'), node('n2')] }),
    )
    expect(plan.placements.map((placement) => placement.workerId)).toEqual(['w1'])
    expect(plan.pending).toEqual([{ workerId: 'w2', scanId: 's1', reason: 'pullLimit', previous: null }])
  })

  it('records the filter that removed the last candidates', () => {
    // n1 passes filter 1 but not filter 2, n2 fails filter 1: archMismatch
    expect(placeOne({ nodes: [node('n1', { info: { arch: 'arm64' } }), node('n2', { state: 'offline' })] }).pending[0]?.reason).toBe('archMismatch')
    // filter 3 removes n2 (pool), filter 5 removes n1 (disk): diskLow
    expect(placeOne({ nodes: [node('n1', { info: { diskFreeBytes: 0 } }), node('n2', { pool: 'gpu' })] }).pending[0]?.reason).toBe('diskLow')
    expect(placeOne({ nodes: [node('n1', { pool: 'gpu', info: { diskFreeBytes: 0 } })] }).pending[0]?.reason).toBe('selectorMismatch')
  })

  it('userMaxWorkers when the owner reached the limit, counting placements of this pass', () => {
    const other = worker('o1', 's9', { state: 'running', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    expect(placeOne({ nodes: [node('n1')], userMaxWorkers: { 'user-a': 1 }, workers: [worker('w1', 's1'), other] }).pending[0]?.reason).toBe('userMaxWorkers')

    const plan = planPlacement(
      snapshot({
        scans: [scan('s1', { settings: { workers: 3 } })],
        workers: [worker('w1', 's1'), worker('w2', 's1'), worker('w3', 's1')],
        nodes: [node('n1')],
        userMaxWorkers: { 'user-a': 2 },
      }),
    )
    expect(plan.placements.map((placement) => placement.workerId)).toEqual(['w1', 'w2'])
    expect(plan.pending).toEqual([{ workerId: 'w3', scanId: 's1', reason: 'userMaxWorkers', previous: null }])
  })

  it('treats maxWorkers 0 or a missing user as unlimited and ignores other users', () => {
    const other = worker('o1', 's9', { userId: 'user-b', state: 'running', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    expect(placeOne({ nodes: [node('n1')], userMaxWorkers: { 'user-a': 0 } }).placements).toHaveLength(1)
    expect(placeOne({ nodes: [node('n1')], userMaxWorkers: { 'user-a': 1 }, workers: [worker('w1', 's1'), other] }).placements).toHaveLength(1)
  })

  it('reports a pending worker only when its reason changes, but always counts it in workersPending', () => {
    const plan = placeOne({ nodes: [], workers: [worker('w1', 's1', { reason: 'noNodes' })] })
    expect(plan.pending).toEqual([])
    expect(plan.conditions.s1).toEqual({ count: 1, reasons: { noNodes: 1 } })

    const changed = placeOne({ nodes: [node('n1', { pool: 'gpu' })], workers: [worker('w1', 's1', { reason: 'noNodes' })] })
    expect(changed.pending).toEqual([{ workerId: 'w1', scanId: 's1', reason: 'selectorMismatch', previous: 'noNodes' }])
  })

  it('places no workers of scans that are not running and clears their condition', () => {
    const plan = placeOne({ scans: [scan('s1', { state: 'paused' })], nodes: [node('n1')] })
    expect(plan.placements).toEqual([])
    expect(plan.pending).toEqual([])
    expect(plan.conditions).toEqual({ s1: null })
  })

  it('aggregates the reasons of a scan into its workersPending condition', () => {
    const plan = planPlacement(
      snapshot({
        scans: [scan('s1', { settings: { workers: 1, processes: 8 } })],
        workers: [worker('sched', 's1', { role: 'scheduler' }), worker('w1', 's1', { processes: { desired: 8, assigned: 0, running: null } })],
        nodes: [node('n1', { info: { cpus: 4 } })],
      }),
    )
    expect(plan.placements.map((placement) => placement.workerId)).toEqual(['sched'])
    expect(plan.conditions.s1).toEqual({ count: 1, reasons: { insufficientCapacity: 1 } })
  })
})

describe('planPlacement: choosing a node', () => {
  it('prefers the least allocated node (max of CPU, memory and slot ratios)', () => {
    const plan = placeOne({ nodes: [node('n1', { info: { cpus: 4 } }), node('n2', { info: { cpus: 16 } })] })
    expect(plan.placements[0]?.nodeId).toBe('n2')
  })

  it('breaks score ties by fewer workers of the same scan, then by node id', () => {
    const sameScan = worker('x1', 's1', { state: 'running', nodeId: 'n-a', processes: { desired: 1, assigned: 1, running: 1 } })
    const otherScan = worker('x2', 's2', { state: 'running', nodeId: 'n-b', processes: { desired: 1, assigned: 1, running: 1 } })
    const plan = planPlacement(
      snapshot({ scans: [scan('s1', { settings: { workers: 2 } }), scan('s2')], workers: [worker('w1', 's1'), sameScan, otherScan], nodes: [node('n-a'), node('n-b')] }),
    )
    expect(plan.placements[0]?.nodeId).toBe('n-b')

    const tie = planPlacement(snapshot({ scans: [scan('s1')], workers: [worker('w1', 's1')], nodes: [node('n-b'), node('n-a')] }))
    expect(tie.placements[0]?.nodeId).toBe('n-a')
  })

  it('spreads the workers of one pass across equal nodes', () => {
    const plan = planPlacement(
      snapshot({ scans: [scan('s1', { settings: { workers: 4 } })], workers: ['w1', 'w2', 'w3', 'w4'].map((id) => worker(id, 's1')), nodes: [node('n1'), node('n2')] }),
    )
    expect(plan.placements.map((placement) => placement.nodeId)).toEqual(['n1', 'n2', 'n1', 'n2'])
  })

  it('places a scheduler on the built-in node whenever it is a candidate', () => {
    const load = ['b1', 'b2', 'b3'].map((id) => worker(id, 's9', { state: 'running', nodeId: 'builtin', processes: { desired: 1, assigned: 1, running: 1 } }))
    const nodes = [node('builtin', { builtIn: true }), node('n2')]
    const plan = planPlacement(snapshot({ scans: [scan('s1')], workers: [worker('sched', 's1', { role: 'scheduler' }), worker('w1', 's1'), ...load], nodes }))
    expect(plan.placements).toEqual([
      { workerId: 'sched', scanId: 's1', nodeId: 'builtin', dindMode: null, assigned: 1 },
      { workerId: 'w1', scanId: 's1', nodeId: 'n2', dindMode: null, assigned: 1 },
    ])

    const builtinFull = planPlacement(
      snapshot({ scans: [scan('s1')], workers: [worker('sched', 's1', { role: 'scheduler' })], nodes: [node('builtin', { builtIn: true, cordoned: true }), node('n2')] }),
    )
    expect(builtinFull.placements[0]?.nodeId).toBe('n2')
  })

  it('chooseNode is the argmin over candidates', () => {
    const nodes = [node('n1', { info: { cpus: 2 } }), node('n2', { info: { cpus: 4 } })]
    const view = new NodeView(nodes, [])
    expect(chooseNode(nodes, worker('w1', 's1'), view).id).toBe('n2')
  })

  it('later decisions of a pass see the reservations of earlier ones', () => {
    const plan = planPlacement(
      snapshot({ scans: [scan('s1', { settings: { workers: 2 } })], workers: [worker('w1', 's1'), worker('w2', 's1')], nodes: [node('n1', { info: { maxWorkers: 1 } })] }),
    )
    expect(plan.placements.map((placement) => placement.workerId)).toEqual(['w1'])
    expect(plan.pending[0]).toMatchObject({ workerId: 'w2', reason: 'insufficientCapacity' })
  })

  it('reserves max(desired, assigned) processes of placed workers and counts draining ones', () => {
    const resizing = worker('r1', 's9', { state: 'running', nodeId: 'n1', processes: { desired: 6, assigned: 2, running: 2 } })
    expect(placeOne({ nodes: [node('n1', { info: { cpus: 6 } })], workers: [worker('w1', 's1'), resizing] }).pending[0]?.reason).toBe('insufficientCapacity')
    const draining = worker('d1', 's9', { state: 'draining', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    expect(placeOne({ nodes: [node('n1', { info: { maxWorkers: 1 } })], workers: [worker('w1', 's1'), draining] }).pending[0]?.reason).toBe('insufficientCapacity')
    const stopped = worker('d2', 's9', { state: 'stopped', nodeId: 'n1', processes: { desired: 1, assigned: 1, running: 1 } })
    expect(placeOne({ nodes: [node('n1', { info: { maxWorkers: 1 } })], workers: [worker('w1', 's1'), stopped] }).placements).toHaveLength(1)
  })
})

describe('placementOrder', () => {
  it('orders schedulers first, then by scan start, worker creation and id', () => {
    const scans = new Map([
      ['early', scan('early', { startedAt: at(0) })],
      ['late', scan('late', { startedAt: at(100) })],
      ['fresh', scan('fresh', { startedAt: null, createdAt: at(50) })],
    ])
    const workers = [
      worker('r-late', 'late', { createdAt: at(101) }),
      worker('r-early-b', 'early', { createdAt: at(5) }),
      worker('r-early-a', 'early', { createdAt: at(5) }),
      worker('r-early-0', 'early', { createdAt: at(1) }),
      worker('s-late', 'late', { role: 'scheduler', createdAt: at(100) }),
      worker('r-fresh', 'fresh', { createdAt: at(51) }),
    ]
    expect(placementOrder(workers, scans).map((w) => w.id)).toEqual(['s-late', 'r-early-0', 'r-early-a', 'r-early-b', 'r-fresh', 'r-late'])
  })
})

describe('planPlacement: live resize of runner processes (§12.6)', () => {
  const placed = (processes: { desired: number; assigned: number; running: number | null }, overrides = {}) =>
    worker('w1', 's1', { state: 'running', nodeId: 'n1', processes, ...overrides })

  it('raises assigned to desired when the node has headroom', () => {
    const plan = placeOne({ nodes: [node('n1')], workers: [placed({ desired: 4, assigned: 2, running: 2 })] })
    expect(plan.resizes).toEqual([{ workerId: 'w1', nodeId: 'n1', assigned: 4 }])
    expect(plan.touchedNodes).toEqual(['n1'])
    expect(plan.conditions.s1).toBeNull()
  })

  it('raises as far as it fits and reports the rest as insufficientCapacity', () => {
    const plan = placeOne({ nodes: [node('n1', { info: { cpus: 3 } })], workers: [placed({ desired: 4, assigned: 2, running: 2 })] })
    expect(plan.resizes).toEqual([{ workerId: 'w1', nodeId: 'n1', assigned: 3 }])
    expect(plan.conditions.s1).toEqual({ count: 1, reasons: { insufficientCapacity: 1 } })
  })

  it('keeps assigned when nothing more fits', () => {
    const neighbour = worker('o1', 's9', { state: 'running', nodeId: 'n1', processes: { desired: 2, assigned: 2, running: 2 } })
    const plan = placeOne({ nodes: [node('n1', { info: { cpus: 4 } })], workers: [placed({ desired: 4, assigned: 2, running: 2 }), neighbour] })
    expect(plan.resizes).toEqual([])
    expect(plan.conditions.s1).toEqual({ count: 1, reasons: { insufficientCapacity: 1 } })
  })

  it('lowers assigned only once the runtime runs at most the desired processes', () => {
    expect(placeOne({ nodes: [node('n1')], workers: [placed({ desired: 1, assigned: 4, running: 4 })] }).resizes).toEqual([])
    expect(placeOne({ nodes: [node('n1')], workers: [placed({ desired: 1, assigned: 4, running: 1 })] }).resizes).toEqual([{ workerId: 'w1', nodeId: 'n1', assigned: 1 }])
    expect(placeOne({ nodes: [node('n1')], workers: [placed({ desired: 1, assigned: 4, running: null })] }).resizes).toEqual([{ workerId: 'w1', nodeId: 'n1', assigned: 1 }])
  })

  it('never resizes schedulers, draining workers or workers of scans that are not running', () => {
    expect(placeOne({ nodes: [node('n1')], workers: [placed({ desired: 2, assigned: 1, running: 1 }, { role: 'scheduler' })] }).resizes).toEqual([])
    expect(placeOne({ nodes: [node('n1')], workers: [placed({ desired: 2, assigned: 1, running: 1 }, { state: 'draining' })] }).resizes).toEqual([])
    expect(placeOne({ scans: [scan('s1', { state: 'paused' })], nodes: [node('n1')], workers: [placed({ desired: 2, assigned: 1, running: 1 })] }).resizes).toEqual([])
  })
})

describe('planPlacement: determinism', () => {
  it('gives the same plan for the same snapshot in any input order', () => {
    const scans = [scan('s1', { settings: { workers: 3 } }), scan('s2', { startedAt: at(10), settings: { workers: 2 } })]
    const workers = [
      worker('a', 's1'),
      worker('b', 's1'),
      worker('c', 's1'),
      worker('d', 's2', { userId: 'user-b' }),
      worker('e', 's2', { userId: 'user-b', role: 'scheduler' }),
      worker('f', 's2', { userId: 'user-b' }),
    ]
    const nodes = [node('n1', { info: { cpus: 4 } }), node('n2', { info: { cpus: 2 } }), node('n3', { builtIn: true, info: { cpus: 2 } })]
    const reference = planPlacement(snapshot({ scans, workers, nodes }))
    expect(reference.placements).toHaveLength(6)
    for (let round = 0; round < 5; round++) {
      const shuffled = snapshot({ scans: shuffle(scans, round), workers: shuffle(workers, round + 1), nodes: shuffle(nodes, round + 2) })
      expect(planPlacement(shuffled)).toEqual(reference)
    }
  })
})

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items]
  let state = seed + 1
  for (let index = copy.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const other = state % (index + 1)
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}
