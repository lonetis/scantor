import { type Channel, type ChannelModel, type ConfirmChannel, connect, type Options, type RecoveringChannelModel } from 'amqplib'
import { type Config, useConfig } from './config'
import { instanceId } from './instance'
import { type Logger, useLogger } from './logger'
import { RABBITMQ_VHOST, useRabbitmqManagement } from './rabbitmq-management'

// AMQP for the orchestrator (docs/queue.md): one recovering connection per component, named
// `scantor-orchestrator/<component>/<instanceId>`, as the admin user on vhost `scantor`. Channels die with their
// connection; consumers register `onConnect` to (re)open them after every (re)connection. Publishers use confirm
// channels. Boot step 5 ensures the vhost, the admin permissions, the exchanges, the global queues and their
// bindings (docs/queue.md §3.5). Workers declare nothing; per-scan objects belong to the reconciler.

export const EXCHANGES = {
  analyses: 'scantor.analyses',
  results: 'scantor.results',
  dead: 'scantor.dead',
} as const

export const GLOBAL_QUEUES = {
  resultsIngest: 'scantor.results.ingest',
  deadIngest: 'scantor.dead.ingest',
} as const

export function scanQueueName(scanId: string): string {
  return `scantor.scan.${scanId}`
}

export function scanAmqpUser(scanId: string): string {
  return `scan-${scanId}`
}

/** Arguments of the global queues (docs/queue.md §3.3). */
export const GLOBAL_QUEUE_ARGUMENTS: Record<string, Record<string, unknown>> = {
  [GLOBAL_QUEUES.resultsIngest]: {
    'x-queue-type': 'quorum',
    'x-delivery-limit': 3,
    'x-dead-letter-exchange': EXCHANGES.dead,
    'x-dead-letter-strategy': 'at-least-once',
    'x-overflow': 'reject-publish',
  },
  [GLOBAL_QUEUES.deadIngest]: {
    'x-queue-type': 'quorum',
    'x-delivery-limit': 20,
  },
}

/** Connection options of the admin user on the scantor vhost. Contains the password: never log them. */
function adminConnectOptions(config: Config): Options.Connect {
  const url = new URL(config.amqpInternalUrl)
  const tls = url.protocol === 'amqps:'
  return {
    protocol: tls ? 'amqps' : 'amqp',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : tls ? 5671 : 5672,
    username: config.rabbitmqUser,
    password: config.rabbitmqPassword,
    vhost: RABBITMQ_VHOST,
    heartbeat: 30,
  }
}

export interface AmqpConnection {
  readonly name: string
  readonly model: RecoveringChannelModel
  createChannel(): Promise<Channel>
  createConfirmChannel(): Promise<ConfirmChannel>
  /** Runs `setup` now (when connected) and after every reconnection. */
  onConnect(setup: (model: ChannelModel) => void | Promise<void>): void
  close(): Promise<void>
}

const connections = new Map<string, Promise<AmqpConnection>>()

async function openConnection(component: string, log: Logger): Promise<AmqpConnection> {
  const config = useConfig()
  const name = `scantor-orchestrator/${component}/${instanceId}`
  const setups: ((model: ChannelModel) => void | Promise<void>)[] = []
  let current: ChannelModel | null = null
  const model = await connect(adminConnectOptions(config), {
      clientProperties: { connection_name: name },
      recovery: { initialDelay: 500, maxDelay: 15_000, initialMaxRetries: 20 },
  })
  model.on('connect', (connected: ChannelModel) => {
    current = connected
    for (const setup of setups) {
      Promise.resolve(setup(connected)).catch((error: unknown) => log.error('AMQP channel setup failed', { err: error }))
    }
  })
  model.on('disconnect', (error: Error) => {
    current = null
    log.warn('AMQP connection lost; reconnecting', { connection: name, err: error })
  })
  model.on('blocked', (reason: string) => log.warn('AMQP connection blocked by the broker', { reason }))
  model.on('unblocked', () => log.info('AMQP connection unblocked'))
  model.on('error', (error: Error) => log.warn('AMQP connection error', { err: error }))
  await model.waitForConnect()
  log.info('AMQP connected', { connection: name })
  return {
    name,
    model,
    createChannel: () => model.createChannel(),
    createConfirmChannel: () => model.createConfirmChannel(),
    onConnect(setup) {
      setups.push(setup)
      if (current) {
        Promise.resolve(setup(current)).catch((error: unknown) => log.error('AMQP channel setup failed', { err: error }))
      }
    },
    close: () => model.close(),
  }
}

/** The connection of `component` (opened once per process; reconnects on its own). */
export function useAmqp(component: string): Promise<AmqpConnection> {
  let connection = connections.get(component)
  if (!connection) {
    connection = openConnection(component, useLogger('amqp', { connection: component })).catch((error: unknown) => {
      connections.delete(component)
      throw error
    })
    connections.set(component, connection)
  }
  return connection
}

/** Closes the connection of one component (for example the short-lived `boot` connection). */
export async function closeAmqpConnection(component: string): Promise<void> {
  const connection = connections.get(component)
  if (!connection) return
  connections.delete(component)
  await (await connection.catch(() => null))?.close()
}

export async function closeAmqp(): Promise<void> {
  const pending = [...connections.values()]
  connections.clear()
  await Promise.all(pending.map(async (connection) => (await connection.catch(() => null))?.close().catch(() => undefined)))
}

function isPreconditionFailed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 406
}

/**
 * Boot step 5: the vhost `scantor` (default queue type quorum) with full permissions for the admin user, the three
 * topic exchanges, the global queues and their bindings. Idempotent; scantor defines no policies. An existing queue
 * declared with other arguments is kept and logged (queue arguments are immutable).
 */
export async function ensureGlobalTopology(log: Logger = useLogger('amqp')): Promise<void> {
  const config = useConfig()
  const management = useRabbitmqManagement()
  await management.putVhost(RABBITMQ_VHOST, { description: 'scantor', default_queue_type: 'quorum' })
  await management.putPermissions(RABBITMQ_VHOST, config.rabbitmqUser, { configure: '.*', write: '.*', read: '.*' })

  const connection = await useAmqp('boot')
  let channel = await connection.createChannel().catch(async (error: unknown) => {
    await closeAmqpConnection('boot')
    throw error
  })
  try {
    for (const exchange of Object.values(EXCHANGES)) {
      await channel.assertExchange(exchange, 'topic', { durable: true, internal: false, autoDelete: false })
    }
    const bindings: [string, string][] = [
      [GLOBAL_QUEUES.resultsIngest, EXCHANGES.results],
      [GLOBAL_QUEUES.deadIngest, EXCHANGES.dead],
    ]
    for (const [queue, exchange] of bindings) {
      try {
        await channel.assertQueue(queue, { durable: true, arguments: GLOBAL_QUEUE_ARGUMENTS[queue] })
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error
        log.warn('queueArgumentsMismatch: keeping the existing queue', { queue })
        channel = await connection.createChannel()
      }
      await channel.bindQueue(queue, exchange, '#')
    }
  } finally {
    await channel.close().catch((error: unknown) => log.debug('closing the boot channel failed', { err: error }))
    await closeAmqpConnection('boot')
  }
}
