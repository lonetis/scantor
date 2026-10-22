import type { DindMode, EndpointProfile, NodeState } from '../utils/enums'
import type { IsoDate } from './common'

// Node representations (docs/api.md §2, §4.17; docs/data-model.md §4.8). `Node` collides with the DOM global of
// the same name when auto-imported into app code; import it explicitly or use the `ScantorNode` alias there.

export interface NodeInfo {
  version: string
  hostname: string
  os: string
  arch: string
  kernel: string
  dockerVersion: string
  cpus: number
  memoryBytes: number
  diskFreeBytes: number
  dindMode: DindMode
  maxWorkers: number
  egressDenyApplied: boolean
  clockOffsetMs?: number
}

export interface NodeInstance {
  version: string
  startedAt: IsoDate
  lastSeenAt: IsoDate
}

export interface Node {
  id: string
  name: string
  builtIn: boolean
  state: NodeState
  endpointProfile: EndpointProfile
  tokenPrefix: string | null
  tokenRotatedAt: IsoDate | null
  pool: string
  labels: Record<string, string>
  maxWorkers: number | null
  cordoned: boolean
  instance: NodeInstance | null
  info: NodeInfo | null
  assignmentsRev: number
  lastSeenAt: IsoDate | null
  createdBy: string | null
  activeWorkers: number
  createdAt: IsoDate
  updatedAt: IsoDate
}

export type ScantorNode = Node

/** Join instructions for a remote node; the token is inlined or `${SCANTOR_NODE_TOKEN}`. */
export interface NodeJoin {
  dockerRun: string
  compose: string
  env: { SCANTOR_URL: string; SCANTOR_NODE_TOKEN: string }
}

/** `createNode` / `rotateNodeToken` response: the token is shown once. */
export interface NodeWithToken {
  node: Node
  token: string
  join: NodeJoin
}
