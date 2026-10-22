import { randomUUID } from 'node:crypto'
import type { Filter } from 'mongodb'
import type { CreateNodeBody, ListNodesQuery, UpdateNodeBody } from '#shared/schemas/nodes'
import type { Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Node, NodeJoin, NodeWithToken } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import { ACTIVE_WORKER_STATES, type WorkerState } from '#shared/utils/enums'
import type { EventDoc, NodeDoc, WorkerDoc } from '../../types/documents'
import { useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { generateNodeToken, invalidateNodeTokenCache } from '../../utils/node-tokens'
import { decodeCursor, encodeCursor, findPage, pageLimit } from '../../utils/pagination'
import { scantorVersion } from '../../utils/version'
import { notifyAssignmentsChanged } from './assignments'
import { recordEvent } from './events'
import { buildNodeJoin, NODE_TOKEN_PLACEHOLDER } from './join'
import { toApiEvent, toApiNode, toApiWorker } from './mappers'
import { markNodeWorkersLost } from './workers'

// Node administration (docs/api.md §4.17, docs/auth.md §10.1, docs/data-model.md §6.7). Tokens are generated here,
// shown once and stored only as hashes. The built-in node cannot be deleted, rotated, revoked or renamed (409
// builtInNode). Revocation and deletion mark the node's workers `lost` at once; placement replaces them.

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

function joinSettings() {
  const config = useConfig()
  return { publicUrl: config.publicUrl, imagePrefix: config.imagePrefix, imageTag: config.imageTag, version: scantorVersion }
}

/** Active workers per node id. */
async function activeWorkerCounts(nodeIds: string[]): Promise<Map<string, number>> {
  if (nodeIds.length === 0) return new Map()
  const rows = await useCollections()
    .workers.aggregate<{ _id: string; count: number }>([
      { $match: { nodeId: { $in: nodeIds }, state: { $in: [...ACTIVE_WORKER_STATES] } } },
      { $group: { _id: '$nodeId', count: { $sum: 1 } } },
    ])
    .toArray()
  return new Map(rows.map((row) => [row._id, row.count]))
}

async function toApiNodes(docs: NodeDoc[]): Promise<Node[]> {
  const counts = await activeWorkerCounts(docs.map((doc) => doc._id))
  return docs.map((doc) => toApiNode(doc, counts.get(doc._id) ?? 0))
}

export async function loadNode(nodeId: string): Promise<NodeDoc> {
  const node = await useCollections().nodes.findOne({ _id: nodeId.toLowerCase() })
  if (!node) throw apiError('notFound', 'node not found')
  return node
}

function assertNotBuiltIn(node: NodeDoc, action: string): void {
  if (node.builtIn) {
    throw apiError('builtInNode', `the built-in node cannot be ${action}: its token is derived from SCANTOR_SECRET`)
  }
}

export async function listNodes(query: ListNodesQuery): Promise<{ items: Node[] }> {
  const filter: Filter<NodeDoc> = {}
  if (query.state) filter.state = query.state
  if (query.pool) filter.pool = query.pool
  const docs = await useCollections().nodes.find(filter).sort({ builtIn: -1, name: 1 }).toArray()
  return { items: await toApiNodes(docs) }
}

export async function getNode(nodeId: string): Promise<Node> {
  const [node] = await toApiNodes([await loadNode(nodeId)])
  return node!
}

export async function createNode(body: CreateNodeBody & { pool: string; labels: Record<string, string> }, adminId: string, log: Logger): Promise<NodeWithToken> {
  const now = new Date()
  const generated = generateNodeToken()
  const doc: NodeDoc = {
    _id: randomUUID(),
    name: body.name,
    builtIn: false,
    state: 'pending',
    endpointProfile: 'public',
    tokenHash: generated.tokenHash,
    tokenPrefix: generated.tokenPrefix,
    tokenRotatedAt: null,
    pool: body.pool,
    labels: body.labels,
    maxWorkers: body.maxWorkers ?? null,
    cordoned: false,
    instance: null,
    info: null,
    assignmentsRev: 0,
    lastSeenAt: null,
    createdBy: adminId,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await useCollections().nodes.insertOne(doc)
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a node named ${body.name} already exists`)
    throw error
  }
  log.info('node created', { nodeId: doc._id, name: doc.name, pool: doc.pool })
  return { node: toApiNode(doc, 0), token: generated.token, join: buildNodeJoin(generated.token, joinSettings()) }
}

export async function updateNode(nodeId: string, body: UpdateNodeBody): Promise<Node> {
  const node = await loadNode(nodeId)
  if (body.name !== undefined && body.name !== node.name) assertNotBuiltIn(node, 'renamed')
  const set: Partial<NodeDoc> = { updatedAt: new Date() }
  if (body.name !== undefined) set.name = body.name
  if (body.pool !== undefined) set.pool = body.pool
  if (body.labels !== undefined) set.labels = body.labels
  if (body.maxWorkers !== undefined) set.maxWorkers = body.maxWorkers
  if (body.cordoned !== undefined) set.cordoned = body.cordoned
  try {
    await useCollections().nodes.updateOne({ _id: node._id }, { $set: set })
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a node named ${body.name} already exists`)
    throw error
  }
  // Pool and labels are part of the node principal (token cache).
  invalidateNodeTokenCache()
  return getNode(node._id)
}

export async function deleteNode(nodeId: string, adminId: string, log: Logger): Promise<void> {
  const node = await loadNode(nodeId)
  assertNotBuiltIn(node, 'deleted')
  const { nodes } = useCollections()
  // Revoke first, so the daemon and registry pulls are refused while the workers are marked lost.
  await nodes.updateOne({ _id: node._id }, { $set: { tokenHash: null, state: 'revoked', updatedAt: new Date() } })
  invalidateNodeTokenCache()
  const lost = await markNodeWorkersLost(node._id, 'nodeDeleted')
  await nodes.deleteOne({ _id: node._id })
  log.info('node deleted', { nodeId: node._id, name: node.name, lostWorkers: lost.length, by: adminId })
}

export async function rotateNodeToken(nodeId: string, log: Logger): Promise<NodeWithToken> {
  const node = await loadNode(nodeId)
  assertNotBuiltIn(node, 'rotated')
  const now = new Date()
  const generated = generateNodeToken()
  // The lease is cleared so the daemon restarted with the new token joins at once (the old one gets 401).
  const updated = await useCollections().nodes.findOneAndUpdate(
    { _id: node._id },
    {
      $set: {
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
        tokenRotatedAt: now,
        instance: null,
        state: node.state === 'revoked' ? 'pending' : node.state,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  )
  invalidateNodeTokenCache()
  if (!updated) throw apiError('notFound', 'node not found')
  await recordEvent({ type: 'node.tokenRotated', level: 'warning', nodeId: node._id, message: `the token of node ${node.name} was rotated`, at: now }, log)
  const [apiNode] = await toApiNodes([updated])
  return { node: apiNode!, token: generated.token, join: buildNodeJoin(generated.token, joinSettings()) }
}

export async function revokeNodeToken(nodeId: string, log: Logger): Promise<Node> {
  const node = await loadNode(nodeId)
  assertNotBuiltIn(node, 'revoked')
  if (node.state === 'revoked' && node.tokenHash === null) return getNode(node._id)
  const now = new Date()
  await useCollections().nodes.updateOne(
    { _id: node._id },
    { $set: { tokenHash: null, state: 'revoked', instance: null, updatedAt: now } },
  )
  invalidateNodeTokenCache()
  const lost = await markNodeWorkersLost(node._id, 'nodeRevoked', now)
  if (lost.length > 0) await notifyAssignmentsChanged(node._id)
  await recordEvent({
    type: 'node.revoked',
    level: 'warning',
    nodeId: node._id,
    message: `the token of node ${node.name} was revoked; ${lost.length} worker${lost.length === 1 ? '' : 's'} lost`,
    data: { lostWorkers: lost.length },
    at: now,
  }, log)
  return getNode(node._id)
}

export async function getNodeJoin(nodeId: string): Promise<NodeJoin> {
  await loadNode(nodeId)
  return buildNodeJoin(NODE_TOKEN_PLACEHOLDER, joinSettings())
}

export async function listNodeWorkers(nodeId: string, query: { state?: WorkerState[]; cursor?: string; limit?: number }): Promise<Page<Worker>> {
  const node = await loadNode(nodeId)
  const { workers, scans } = useCollections()
  const filter: Filter<WorkerDoc> = { nodeId: node._id }
  if (query.state && query.state.length > 0) filter.state = { $in: query.state }
  const page = await findPage(workers, filter, { cursor: query.cursor, limit: query.limit }, (doc) => doc)
  const scanIds = [...new Set(page.items.map((worker) => worker.scanId))]
  const scanNames = new Map(
    (await scans.find({ _id: { $in: scanIds } }, { projection: { _id: 1, name: 1 } }).toArray()).map((scan) => [scan._id, scan.name ?? null]),
  )
  return {
    items: page.items.map((worker) =>
      toApiWorker(worker, { node: { id: node._id, name: node.name }, scan: { id: worker.scanId, name: scanNames.get(worker.scanId) ?? null } }),
    ),
    nextCursor: page.nextCursor,
  }
}

interface EventCursor {
  t: number
  i: string
}

function isEventCursor(value: unknown): value is EventCursor {
  const candidate = value as EventCursor | null
  return typeof candidate === 'object' && candidate !== null && Number.isSafeInteger(candidate.t) && typeof candidate.i === 'string' && candidate.i.length <= 64
}

/** Events of a node, newest first (`{nodeId: 1, at: -1}`); `type` matches exactly or by a prefix ending in ".". */
export async function listNodeEvents(nodeId: string, query: { type?: string; cursor?: string; limit?: number }): Promise<Page<Event>> {
  const node = await loadNode(nodeId)
  const limit = pageLimit(query.limit)
  const clauses: Filter<EventDoc>[] = [{ nodeId: node._id }]
  if (query.type) {
    const escaped = query.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    clauses.push({ type: query.type.endsWith('.') ? { $regex: `^${escaped}` } : query.type })
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, isEventCursor)
    const at = new Date(cursor.t)
    clauses.push({ $or: [{ at: { $lt: at } }, { at, _id: { $lt: cursor.i } }] })
  }
  const docs = await useCollections().events.find({ $and: clauses }).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray()
  const hasMore = docs.length > limit
  const items = hasMore ? docs.slice(0, limit) : docs
  const last = items.at(-1)
  return {
    items: items.map(toApiEvent),
    nextCursor: hasMore && last ? encodeCursor({ t: last.at.getTime(), i: last._id } satisfies EventCursor) : null,
  }
}
