import type { NodeHelloBody } from '#shared/schemas/nodes'
import type { NodeDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { NodePrincipal } from '../../utils/principal'
import { recordEvent } from './events'
import { checkLeaseHolder, evaluateHelloLease, type NodeInstance } from './lease'
import { endpointUrls } from './profile'

// POST /api/node/hello (docs/api.md §7.1, docs/nodes.md §5.2): instance lease, host info, `online`, and the node's
// identity and orchestrator-side configuration. Later node requests must come from the lease holder
// (requireLeaseHolder), otherwise 409 nodeInstanceConflict sends the daemon back to hello.

export const INSTANCE_ID_HEADER = 'x-scantor-instance-id'

export interface NodeHelloResponse {
  serverTime: number
  node: { id: string; name: string; builtIn: boolean; endpointProfile: NodeDoc['endpointProfile']; pool: string; labels: Record<string, string> }
  config: {
    statusIntervalMs: number
    assignmentsWaitSeconds: number
    offlineAfterMs: number
    drainGraceMs: number
    registry: { host: string; username: 'node' }
    minFreeDiskBytes: number
  }
}

export type NodeConfigSettings = Pick<
  Config,
  | 'nodeStatusIntervalMs'
  | 'nodeAssignmentsWaitMs'
  | 'nodeOfflineAfterMs'
  | 'workerDrainGraceMs'
  | 'nodeMinFreeDiskBytes'
  | 'internalUrl'
  | 'publicUrl'
  | 'amqpInternalUrl'
  | 'amqpPublicUrl'
  | 'registryPort'
  | 'registryPublicHost'
>

export function helloResponse(node: NodeDoc, config: NodeConfigSettings, now: Date): NodeHelloResponse {
  return {
    serverTime: now.getTime(),
    node: { id: node._id, name: node.name, builtIn: node.builtIn, endpointProfile: node.endpointProfile, pool: node.pool, labels: node.labels ?? {} },
    config: {
      statusIntervalMs: config.nodeStatusIntervalMs,
      assignmentsWaitSeconds: Math.round(config.nodeAssignmentsWaitMs / 1000),
      offlineAfterMs: config.nodeOfflineAfterMs,
      drainGraceMs: config.workerDrainGraceMs,
      registry: { host: endpointUrls(node.endpointProfile, config).registryHost, username: 'node' },
      minFreeDiskBytes: config.nodeMinFreeDiskBytes,
    },
  }
}

function conflict(retryAfterMs: number) {
  return apiError('nodeInstanceConflict', 'another daemon instance holds the lease of this node', { retryAfterMs })
}

async function loadNode(principal: NodePrincipal): Promise<NodeDoc> {
  const node = await useCollections().nodes.findOne({ _id: principal.node.id })
  // Deleted or revoked since the (10 s cached) token lookup.
  if (!node || node.state === 'revoked' || !node.tokenHash) throw apiError('unauthorized', 'unknown or revoked node token')
  return node
}

const MAX_LEASE_ATTEMPTS = 3

export async function handleHello(principal: NodePrincipal, body: NodeHelloBody, config: NodeConfigSettings, log: Logger): Promise<NodeHelloResponse> {
  const { nodes } = useCollections()
  for (let attempt = 1; attempt <= MAX_LEASE_ATTEMPTS; attempt++) {
    const node = await loadNode(principal)
    const now = new Date()
    const decision = evaluateHelloLease(node.instance, body.instanceId, now, config.nodeOfflineAfterMs)
    if (decision.kind === 'conflict') {
      await recordEvent({
        type: 'node.instanceConflict',
        level: 'warning',
        nodeId: node._id,
        message: `a second daemon instance of node ${node.name} was refused: another engine holds the lease`,
        data: { instanceId: body.instanceId },
      })
      log.warn('node instance conflict', { nodeId: node._id, retryAfterMs: decision.retryAfterMs })
      throw conflict(decision.retryAfterMs)
    }
    const sameInstance = node.instance?.id === body.instanceId
    const instance: NodeInstance = {
      id: body.instanceId,
      version: body.version,
      startedAt: sameInstance && node.instance ? node.instance.startedAt : now,
      lastSeenAt: now,
    }
    const info: NonNullable<NodeDoc['info']> = {
      ...body.info,
      version: body.version,
      ...(node.info?.clockOffsetMs !== undefined ? { clockOffsetMs: node.info.clockOffsetMs } : {}),
    }
    // Conditional on the lease holder that was evaluated, so two concurrent hellos cannot both win.
    const updated = await nodes.findOneAndUpdate(
      { _id: node._id, 'instance.id': node.instance?.id ?? null, state: { $ne: 'revoked' } },
      { $set: { instance, info, state: 'online', lastSeenAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!updated) continue
    if (node.state !== 'online' || !sameInstance) {
      await recordEvent({
        type: 'node.online',
        level: 'info',
        nodeId: node._id,
        message: decision.takeover ? `node ${node.name} restarted on the same engine and took over its lease` : `node ${node.name} is online`,
        data: { instanceId: body.instanceId },
      })
    }
    log.info('node hello', {
      nodeId: node._id,
      version: body.version,
      takeover: decision.takeover,
      adoptedContainers: body.containers?.length ?? 0,
    })
    return helloResponse(updated, config, now)
  }
  throw conflict(0)
}

/**
 * Loads the calling node and asserts that `instanceId` holds its lease (every node route except hello). Returns
 * the node document.
 */
export async function requireLeaseHolder(principal: NodePrincipal, instanceId: string | null | undefined, offlineAfterMs: number): Promise<NodeDoc> {
  const node = await loadNode(principal)
  const check = checkLeaseHolder(node.instance, instanceId, new Date(), offlineAfterMs)
  if (!check.ok) throw conflict(check.retryAfterMs)
  return node
}
