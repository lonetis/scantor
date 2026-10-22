import { readFileSync } from 'node:fs'
import amqp, { type Channel, type ChannelModel, type Options } from 'amqplib'
import { stackEnv } from './docker'
import { env } from './env'
import { stackKeys } from './keys'

// Raw AMQP access to the test stack's RabbitMQ (docs/testing.md §7.8) for security and chaos tests: publish as a
// scan's own RabbitMQ user (`scan-<scanId>`, password derived with helpers/keys.ts) or as the admin, through the
// public AMQPS endpoint behind Traefik (the same path remote workers take, the test CA trusted).

/** The vhost and exchanges of docs/queue.md §2. */
export const VHOST = 'scantor'
export const EXCHANGES = { analyses: 'scantor.analyses', results: 'scantor.results', dead: 'scantor.dead' } as const

export interface AmqpSession {
  connection: ChannelModel
  /** a confirm channel: publish() resolves when the broker accepted the message */
  channel: amqp.ConfirmChannel
  user: string
  close(): Promise<void>
}

/** Connects as `user` to amqps://amqp.<domain>:443/scantor (SNI by hostname, the test CA). */
export async function connectAs(user: string, password: string): Promise<AmqpSession> {
  const host = `amqp.${env.domain}`
  const url = `amqps://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:443/${encodeURIComponent(VHOST)}`
  const connection = await amqp.connect(url, { ca: [readFileSync(env.caCertFile)], servername: host })
  const channel = await connection.createConfirmChannel()
  return {
    connection,
    channel,
    user,
    close: async () => {
      await connection.close()
    },
  }
}

/** Connects as the RabbitMQ user of a scan. */
export function connectAsScan(scanId: string): Promise<AmqpSession> {
  return connectAs(`scan-${scanId}`, stackKeys().amqpPassword(scanId))
}

/** Connects as the RabbitMQ admin of the stack (SCANTOR_RABBITMQ_USER). */
export function connectAsAdmin(): Promise<AmqpSession> {
  const stack = stackEnv()
  return connectAs(stack.SCANTOR_RABBITMQ_USER!, stack.SCANTOR_RABBITMQ_PASSWORD!)
}

/**
 * Publishes a JSON (or raw) body and waits for the broker's confirm. `user_id` defaults to the session's user, as the
 * broker requires; pass another one to test the spoofing check. Rejects when the broker refuses the message or closes
 * the channel (ACCESS_REFUSED, PRECONDITION_FAILED).
 */
export function publish(session: AmqpSession, exchange: string, routingKey: string, body: unknown, properties: Options.Publish = {}): Promise<void> {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const channel: Channel = session.channel
  return new Promise((resolve, reject) => {
    const onClose = (error?: Error) => reject(error ?? new Error('the channel was closed'))
    channel.once('error', onClose)
    channel.once('close', onClose)
    session.channel.publish(
      exchange,
      routingKey,
      content,
      { contentType: 'application/json', persistent: true, userId: session.user, ...properties },
      (error) => {
        channel.off('error', onClose)
        channel.off('close', onClose)
        if (error) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve()
      },
    )
  })
}
