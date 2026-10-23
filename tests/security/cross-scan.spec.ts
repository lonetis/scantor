import { randomUUID } from 'node:crypto'
import type { ChannelModel } from 'amqplib'
import type { Analysis, AnalysisQueryResult } from '#shared/types/analyses'
import type { Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Scan } from '#shared/types/scans'
import { ok, type ApiClient } from '../helpers/api-client'
import { connectAs, connectAsScan, EXCHANGES, publish, type AmqpSession } from '../helpers/amqp'
import { finishScanDeletion, metricValue, rabbitManagementGet, scrapeMetrics, settleScan, UNPLACEABLE_SETTINGS } from '../helpers/api-results'
import { analysisMessage, channelRefusal, ingestRejectedEvents, rabbitManagement, resultMessage } from '../helpers/api-results-amqp'
import { stackKeys } from '../helpers/keys'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest, type ResultsetScans } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Ingestion trust across scans (docs/queue.md §3–§7, docs/runtime.md §8.1, security.md ING-1…ING-7): the per-scan
// RabbitMQ user `scan-<scanId>` (password derived from SCANTOR_SECRET, helpers/keys.ts) publishes hand-built messages
// through the public AMQPS endpoint, exactly as a compromised worker of that scan could. The scans of these tests
// stay `running` without any worker (their node selector matches no node), so their queue and RabbitMQ user exist
// while nothing else publishes for them; the RT-010 test needs a real runner and uses the built-in node.
//
// The ingestor processes scantor.results.ingest in FIFO batches, so once a valid "sentinel" result published after
// the messages under test is visible, those messages were processed as well. Rejected messages are dead-lettered and
// turned into admin-only `security.ingestRejected` events by the dead-letter consumer (at most one per routing key and
// reason per minute); every test uses fresh scans, so their routing keys are new. Metric counters are shared by the
// suite and asserted as deltas (≥).

/** A scan of the worker's resultset task that is running without workers (cancelled after the test). */
async function idleScan(resultset: ResultsetScans): Promise<Scan> {
  const started = await resultset.start({ scanConfig: { items: ['a'] }, settings: UNPLACEABLE_SETTINGS })
  return settleScan(resultset.api, started.id, 'running', 60_000)
}

async function analysisStatus(api: ApiClient, scanId: string, seq: number): Promise<number> {
  return (await api.call('getAnalysis', { path: { analysisId: `${scanId}-${seq}` } })).status
}

/** Publishes a valid result for `seq` and waits until the ingestor wrote it. */
async function sentinel(api: ApiClient, session: AmqpSession, scanId: string, seq: number): Promise<void> {
  await publish(session, EXCHANGES.results, scanId, resultMessage(scanId, seq))
  await expect.poll(() => analysisStatus(api, scanId, seq), { timeout: 60_000, intervals: [500, 1000] }).toBe(200)
}

async function seqsOf(api: ApiClient, scanId: string): Promise<number[]> {
  const result = ok(
    await api.call<AnalysisQueryResult>('queryAnalyses', { path: { scanId }, body: { filter: {}, projection: { seq: 1 }, limit: 1000 } }),
    'queryAnalyses',
  )
  return result.items.map((item) => item.seq as number)
}

async function withSession<T>(scanId: string, use: (session: AmqpSession) => Promise<T>): Promise<T> {
  const session = await connectAsScan(scanId)
  try {
    return await use(session)
  } finally {
    await session.close().catch(() => undefined)
  }
}

test.describe('per-scan RabbitMQ users', () => {
  test('orchestrator boot ensures the vhost, the topic exchanges and the global quorum queues', { tag: ['@ING-001'] }, async () => {
    expect((await rabbitManagement('GET', '/vhosts/scantor')).status).toBe(200)
    for (const name of Object.values(EXCHANGES)) {
      const exchange = await rabbitManagementGet<{ type: string; durable: boolean; auto_delete: boolean; internal: boolean }>(`/exchanges/scantor/${name}`)
      expect(exchange.status, name).toBe(200)
      expect(exchange.body, name).toMatchObject({ type: 'topic', durable: true, auto_delete: false, internal: false })
    }

    type QueueInfo = { type: string; durable: boolean; arguments: Record<string, unknown>; consumers: number }
    const ingest = await rabbitManagementGet<QueueInfo>('/queues/scantor/scantor.results.ingest')
    expect(ingest.status).toBe(200)
    expect(ingest.body).toMatchObject({ type: 'quorum', durable: true })
    expect(ingest.body.arguments).toMatchObject({
      'x-queue-type': 'quorum',
      'x-delivery-limit': 3,
      'x-dead-letter-exchange': 'scantor.dead',
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    })
    expect(ingest.body.arguments).not.toHaveProperty('x-max-length')
    const dead = await rabbitManagementGet<QueueInfo>('/queues/scantor/scantor.dead.ingest')
    expect(dead.status).toBe(200)
    expect(dead.body).toMatchObject({ type: 'quorum', durable: true })
    expect(dead.body.arguments).toMatchObject({ 'x-queue-type': 'quorum', 'x-delivery-limit': 20 })
    expect(dead.body.arguments).not.toHaveProperty('x-dead-letter-exchange')
    // The ingestor consumes both.
    for (const queue of [ingest, dead]) expect(queue.body.consumers).toBeGreaterThanOrEqual(1)

    type Binding = { destination: string; destination_type: string; routing_key: string }
    for (const [exchange, queue] of [
      [EXCHANGES.results, 'scantor.results.ingest'],
      [EXCHANGES.dead, 'scantor.dead.ingest'],
    ] as const) {
      const bindings = await rabbitManagementGet<Binding[]>(`/exchanges/scantor/${exchange}/bindings/source`)
      expect(bindings.body.filter((binding) => binding.destination === queue)).toEqual([
        expect.objectContaining({ destination_type: 'queue', routing_key: '#' }),
      ])
    }
  })

  test('the scan user’s password is derived from the secret and never stored; the user has no tags', { tag: ['@ING-004'] }, async ({ docker, resultset }) => {
    const scan = await idleScan(resultset)
    const user = `scan-${scan.id}`
    const password = stackKeys().amqpPassword(scan.id)

    const info = await rabbitManagement('GET', `/users/${user}`)
    expect(info.status).toBe(200)
    expect(info.body).toMatchObject({ name: user, tags: [], has_password: true })
    await withSession(scan.id, async (session) => expect(session.user).toBe(user))

    // No tags: the management API rejects the scan user.
    expect((await rabbitManagementGet('/whoami', { user, password })).status).toBe(401)
    expect((await rabbitManagementGet('/overview', { user, password })).status).toBe(401)

    // The password appears nowhere in the scan's documents.
    const stored = await docker.mongosh(
      `print(EJSON.stringify({ scan: db.scans.findOne({ _id: ${JSON.stringify(scan.id)} }), workers: db.workers.find({ scanId: ${JSON.stringify(scan.id)} }).toArray() }))`,
      { as: 'root' },
    )
    expect(stored).toContain(scan.id)
    expect(stored).not.toContain(password)

    // A recreated user (here: removed behind the reconciler's back) gets the same password again.
    expect((await rabbitManagement('DELETE', `/users/${user}`)).status).toBe(204)
    await expect.poll(async () => (await rabbitManagement('GET', `/users/${user}`)).status, { timeout: 60_000, intervals: [1000] }).toBe(200)
    await expect
      .poll(
        async () => {
          try {
            await withSession(scan.id, async () => undefined)
            return 'connected'
          } catch (error) {
            return String(error)
          }
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe('connected')
  })

  test('the broker confines a scan user to its own routing key and its own queue', { tag: ['@ING-005'] }, async ({ api, resultset }) => {
    const a = await idleScan(resultset)
    const b = await idleScan(resultset)

    await withSession(b.id, async (session) => {
      const refusals = {
        resultsWithForeignKey: await channelRefusal(session, async (channel) =>
          channel.publish(EXCHANGES.results, a.id, Buffer.from(JSON.stringify(resultMessage(a.id, 1))), { userId: session.user }),
        ),
        analysesWithForeignKey: await channelRefusal(session, async (channel) =>
          channel.publish(EXCHANGES.analyses, a.id, Buffer.from(JSON.stringify(analysisMessage(a.id, 1))), { userId: session.user }),
        ),
        deadExchange: await channelRefusal(session, async (channel) => channel.publish(EXCHANGES.dead, b.id, Buffer.from('{}'), { userId: session.user })),
        defaultExchange: await channelRefusal(session, async (channel) =>
          channel.publish('', `scantor.scan.${b.id}`, Buffer.from('{}'), { userId: session.user }),
        ),
        declareQueue: await channelRefusal(session, (channel) => channel.assertQueue(`scantor.scan.${randomUUID()}`, { durable: true })),
        declareExchange: await channelRefusal(session, (channel) => channel.assertExchange(`scantor.${randomUUID()}`, 'topic')),
        bindOwnQueue: await channelRefusal(session, (channel) => channel.bindQueue(`scantor.scan.${b.id}`, EXCHANGES.analyses, a.id)),
        deleteOwnQueue: await channelRefusal(session, (channel) => channel.deleteQueue(`scantor.scan.${b.id}`)),
        consumeOtherScanQueue: await channelRefusal(session, (channel) => channel.consume(`scantor.scan.${a.id}`, () => undefined)),
        consumeIngestQueue: await channelRefusal(session, (channel) => channel.consume('scantor.results.ingest', () => undefined)),
        consumeDeadQueue: await channelRefusal(session, (channel) => channel.consume('scantor.dead.ingest', () => undefined)),
      }
      for (const [what, refusal] of Object.entries(refusals)) {
        expect(refusal.code, `${what}: ${refusal.message}`).toBe(403)
        expect(refusal.message, what).toContain('ACCESS_REFUSED')
      }

      // A user_id other than the authenticated user closes the channel with PRECONDITION_FAILED.
      const spoofed = await channelRefusal(session, async (channel) =>
        channel.publish(EXCHANGES.results, b.id, Buffer.from(JSON.stringify(resultMessage(b.id, 2))), { userId: `scan-${a.id}` }),
      )
      expect(spoofed.code, spoofed.message).toBe(406)
      expect(spoofed.message).toContain('PRECONDITION_FAILED')

      // What the user may do: consume its own queue and publish with its own scan id.
      const own = await session.connection.createChannel()
      const consumer = await own.consume(`scantor.scan.${b.id}`, () => undefined)
      await own.cancel(consumer.consumerTag)
      await own.close()
      await sentinel(api, session, b.id, 3)
    })

    // Nothing reached scan A, and scan B holds only its own sentinel.
    expect(await seqsOf(api, a.id)).toEqual([])
    expect(await seqsOf(api, b.id)).toEqual([3])
  })

  test('connections and channels are limited by workers and processes; scaling raises the limits', { tag: ['@ING-006'] }, async ({ api, resultset }) => {
    const scan = await idleScan(resultset)
    const user = `scan-${scan.id}`
    const limits = async () => {
      const response = await rabbitManagementGet<{ value: Record<string, number> }[]>(`/user-limits/${user}`)
      return response.body[0]?.value
    }
    // workers 1, processes 1: C = 2 × (1 + 1) = 4 connections, H = C × (1 + 2) = 12 channels.
    expect(await limits()).toEqual({ 'max-connections': 4, 'max-channels': 12 })

    const connections: ChannelModel[] = []
    const errors: string[] = []
    try {
      for (let n = 0; n < 4; n++) {
        const session = await connectAs(user, stackKeys().amqpPassword(scan.id))
        session.connection.on('error', (error: Error) => errors.push(error.message))
        connections.push(session.connection)
      }
      // A fifth connection is refused.
      await expect(connectAs(user, stackKeys().amqpPassword(scan.id))).rejects.toThrow()

      // Each session holds one confirm channel: eight more reach the limit of twelve, the thirteenth closes its
      // connection with NOT_ALLOWED.
      for (let n = 0; n < 8; n++) await connections[0]!.createChannel()
      const closed = new Promise<void>((resolve) => connections[0]!.once('close', () => resolve()))
      await expect(connections[0]!.createChannel()).rejects.toThrow()
      await closed
      expect(errors.join('\n')).toContain('NOT_ALLOWED')
      expect(errors.join('\n')).toContain('max')
    } finally {
      for (const connection of connections) await connection.close().catch(() => undefined)
    }

    // workers 2, processes 2: C = 6, H = 6 × 4 = 24.
    const scaled = await api.call<Scan>('scaleScan', { path: { scanId: scan.id }, body: { workers: 2, processes: 2 } })
    expect(scaled.status).toBe(200)
    await expect.poll(limits, { timeout: 60_000, intervals: [1000] }).toEqual({ 'max-connections': 6, 'max-channels': 24 })
  })
})

test.describe('result ingestion trust', () => {
  test(
    'unauthenticated or inconsistent results are dead-lettered without writing anything',
    { tag: ['@ING-007', '@AUTHZ-016'] },
    async ({ api, adminApi, resultset }) => {
      const a = await idleScan(resultset)
      const b = await idleScan(resultset)
      const rejected = { source: 'results', reason: 'rejected' }
      // [the reason the ingestor rejects it for, body, AMQP properties]; every message goes out as scan B with key B.
      const bad: [string, unknown, Record<string, unknown>?][] = [
        ['missingUserId', resultMessage(b.id, 1), { userId: undefined }],
        ['scanIdMismatch', resultMessage(a.id, 2)],
        ['analysisIdMismatch', resultMessage(b.id, 3, { analysisId: `${b.id}-4` })],
        ['invalidSeq', resultMessage(b.id, -1, { analysisId: `${b.id}--1` })],
        ['invalidSeq', resultMessage(b.id, 1.5, { analysisId: `${b.id}-1.5` })],
        ['invalidSeq', resultMessage(b.id, 2 ** 53, { analysisId: `${b.id}-${2 ** 53}` })],
        ['invalidJson', Buffer.from('{"v": 1, "kind": "result", not json')],
      ]
      const before = await scrapeMetrics(adminApi)

      await withSession(b.id, async (session) => {
        for (const [, body, properties] of bad) await publish(session, EXCHANGES.results, b.id, body, properties)
        await sentinel(api, session, b.id, 100)
      })

      // Nothing was written: B holds only the sentinel, and the body that claimed scan A wrote nothing for A.
      expect(await seqsOf(api, b.id)).toEqual([100])
      expect(await seqsOf(api, a.id)).toEqual([])
      expect(await analysisStatus(api, a.id, 2)).toBe(404)

      // The dead-letter consumer records one admin-only event per reason (rate-limited per routing key and reason).
      await expect
        .poll(async () => [...new Set((await ingestRejectedEvents(b.id)).map((event) => event.data.reason))].sort(), { timeout: 60_000, intervals: [1000] })
        .toEqual([...new Set(bad.map(([reason]) => reason))].sort())
      const events = await ingestRejectedEvents(b.id)
      expect(events).toHaveLength(5)
      for (const event of events) {
        expect(event).toMatchObject({ type: 'security.ingestRejected', userId: null, data: { routingKey: b.id } })
        expect(event.scanId).toBeUndefined()
        expect(event.data.userIdProperty).toBe(event.data.reason === 'missingUserId' ? null : `scan-${b.id}`)
      }

      // Security events have no owner: they never appear among the owner's scan events.
      for (const type of [undefined, 'security.', 'security.ingestRejected']) {
        const page = ok(await api.call<Page<Event>>('listScanEvents', { path: { scanId: b.id }, query: { type, limit: 200 } }), 'listScanEvents')
        expect(
          page.items.filter((event) => event.type.startsWith('security.')),
          String(type),
        ).toEqual([])
      }

      // Every rejected message was dead-lettered and counted.
      await expect
        .poll(
          async () =>
            metricValue(await scrapeMetrics(adminApi), 'scantor_dead_letters_total', rejected) - metricValue(before, 'scantor_dead_letters_total', rejected),
          {
            timeout: 30_000,
          },
        )
        .toBeGreaterThanOrEqual(bad.length)
      const after = await scrapeMetrics(adminApi)
      const outcome = { kind: 'result', outcome: 'rejected' }
      expect(
        metricValue(after, 'scantor_ingest_messages_total', outcome) - metricValue(before, 'scantor_ingest_messages_total', outcome),
      ).toBeGreaterThanOrEqual(bad.length)
    },
  )

  test(
    'future rounds and results of deleting or deleted scans are dropped; late results of cancelled scans are recorded',
    { tag: ['@ING-008'] },
    async ({ api, adminApi, docker, resultset }) => {
      test.setTimeout(180_000)
      const [running, cancelled, deleting, deleted] = await Promise.all([idleScan(resultset), idleScan(resultset), idleScan(resultset), idleScan(resultset)])
      const dropped = { kind: 'result', outcome: 'dropped' }
      const before = await scrapeMetrics(adminApi)

      // A result for round 2 of a round-1 scan is dropped.
      await withSession(running.id, async (session) => {
        await publish(session, EXCHANGES.results, running.id, resultMessage(running.id, 5, { round: 2 }))
        await sentinel(api, session, running.id, 6)
      })
      expect(await seqsOf(api, running.id)).toEqual([6])

      // Results already queued when their scan is cancelled or deleted: delivery is delayed until afterwards
      // (x-opt-delivery-time), because cancel and delete remove the scan user and close its connections. The results
      // of the deleted scans go first, so once the cancelled scan's result is visible they were processed too (FIFO).
      const deliverAt = Date.now() + 25_000
      for (const scan of [deleted, deleting, cancelled]) {
        await withSession(scan.id, (session) =>
          publish(session, EXCHANGES.results, scan.id, resultMessage(scan.id, 7), { headers: { 'x-opt-delivery-time': deliverAt } }),
        )
      }
      for (const scan of [cancelled, deleting, deleted]) ok(await api.cancelScan(scan.id), 'cancelScan')
      for (const scan of [cancelled, deleting, deleted]) await settleScan(api, scan.id, 'cancelled', 60_000)
      for (const scan of [deleting, deleted]) expect(ok(await api.deleteScan(scan.id), 'deleteScan').scan.state).toBe('deleting')
      // The scanDelete jobs queue behind the whole suite's scan deletions: one scan stays `deleting`, the other gets
      // its tombstone directly (finishScanDeletion).
      await finishScanDeletion(deleted.id)
      expect(ok(await api.getScan(deleted.id), 'getScan').state).toBe('deleted')
      expect(Date.now()).toBeLessThan(deliverAt)

      // The late result of the cancelled scan is recorded.
      await expect.poll(() => analysisStatus(api, cancelled.id, 7), { timeout: 90_000, intervals: [1000] }).toBe(200)
      const late = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${cancelled.id}-7` } }), 'getAnalysis')
      expect(late).toMatchObject({ status: 'succeeded', round: 1, result: { value: 'value-7' } })
      expect(ok(await api.getScan(cancelled.id), 'getScan').state).toBe('cancelled')

      // The results of the deleting and the deleted scan are dropped (counted) and write no document.
      await expect
        .poll(
          async () =>
            metricValue(await scrapeMetrics(adminApi), 'scantor_ingest_messages_total', dropped) -
            metricValue(before, 'scantor_ingest_messages_total', dropped),
          { timeout: 30_000, intervals: [1000] },
        )
        .toBeGreaterThanOrEqual(3)
      for (const scan of [deleting, deleted]) expect(await docker.mongoCount('analyses', { scanId: scan.id }), scan.id).toBe(0)
    },
  )

  test(
    'authenticated results that fail the schema or cannot be stored become failed analyses; other scans keep ingesting',
    { tag: ['@ING-009'] },
    async ({ api, adminApi, resultset }) => {
      const x = await idleScan(resultset)
      const y = await idleScan(resultset)
      const recorded = { kind: 'result', outcome: 'failedRecorded' }
      const before = await scrapeMetrics(adminApi)
      const maxResultBytes = 1024 * 1024
      const blob = 'x'.repeat(maxResultBytes + 1024)

      await withSession(x.id, async (session) => {
        await publish(session, EXCHANGES.results, x.id, resultMessage(x.id, 1, { unexpected: true }))
        await publish(session, EXCHANGES.results, x.id, resultMessage(x.id, 2, { result: null }))
        await publish(session, EXCHANGES.results, x.id, resultMessage(x.id, 3, { result: { 'nul\u0000key': 1 } }))
        await publish(session, EXCHANGES.results, x.id, resultMessage(x.id, 4, { result: { blob } }))
      })
      // The other scan's result, published afterwards, is ingested normally.
      await withSession(y.id, (session) => sentinel(api, session, y.id, 1))
      await expect.poll(async () => (await seqsOf(api, x.id)).length, { timeout: 60_000, intervals: [500, 1000] }).toBe(4)

      const analysis = async (seq: number) => ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${x.id}-${seq}` } }), 'getAnalysis')
      for (const seq of [1, 2]) {
        const failed = await analysis(seq)
        expect(failed).toMatchObject({ status: 'failed', round: 1, attempt: 1, files: [], error: { type: 'platform', phase: 'ingest', retryable: false } })
        expect(failed.error!.message, `seq ${seq}`).toMatch(/^invalid result message: \S/)
        expect(failed.result).toBeUndefined()
      }
      expect((await analysis(1)).error!.message).toContain('additional properties')
      const unstorable = await analysis(3)
      expect(unstorable).toMatchObject({ status: 'failed', error: { type: 'platform', phase: 'ingest' } })
      expect(unstorable.error!.message).toMatch(/^result could not be stored: \S/)
      const oversized = await analysis(4)
      expect(oversized).toMatchObject({ status: 'failed', error: { type: 'validation', phase: 'ingest', retryable: false } })
      expect(oversized.error!.message).toContain(`above SCANTOR_MAX_RESULT_BYTES (${maxResultBytes} bytes)`)

      expect(ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${y.id}-1` } }), 'getAnalysis')).toMatchObject({
        status: 'succeeded',
        result: { value: 'value-1' },
      })
      const after = await scrapeMetrics(adminApi)
      expect(
        metricValue(after, 'scantor_ingest_messages_total', recorded) - metricValue(before, 'scantor_ingest_messages_total', recorded),
      ).toBeGreaterThanOrEqual(4)
    },
  )
})

test.describe('event visibility', () => {
  test(
    'node events are admin only; owners see only the events of their own scans',
    { tag: ['@AUTHZ-016'] },
    async ({ api, anonApi, otherApi, adminApi, resultset }) => {
      const nodes = ok(await adminApi.listNodes(), 'listNodes')
      const builtin = nodes.items.find((node) => node.builtIn)!
      expect((await anonApi.call('listNodeEvents', { path: { nodeId: builtin.id } })).status).toBe(401)
      const denied = await api.call('listNodeEvents', { path: { nodeId: builtin.id } })
      expect(denied.status).toBe(403)
      expect(denied.body).toMatchObject({ error: { code: 'adminRequired' } })
      const nodeEvents = ok(
        await adminApi.call<Page<Event>>('listNodeEvents', { path: { nodeId: builtin.id }, query: { type: 'node.', limit: 200 } }),
        'listNodeEvents',
      )
      expect(nodeEvents.items.length).toBeGreaterThan(0)
      for (const event of nodeEvents.items) expect(event).toMatchObject({ nodeId: builtin.id, userId: null, type: expect.stringMatching(/^node\./) })

      const scan = await idleScan(resultset)
      const own = ok(await api.call<Page<Event>>('listScanEvents', { path: { scanId: scan.id }, query: { limit: 200 } }), 'listScanEvents')
      expect(own.items.map((event) => event.type)).toContain('scan.created')
      for (const event of own.items) expect(event).toMatchObject({ scanId: scan.id, userId: scan.userId })
      const foreign = await otherApi.call('listScanEvents', { path: { scanId: scan.id } })
      expect(foreign.status).toBe(404)
      expect(foreign.body).toMatchObject({ error: { code: 'notFound' } })
    },
  )
})

test.describe('malformed analysis messages', () => {
  test(
    'a runner records attributable malformed messages as validation failures and drops the rest',
    { tag: ['@RT-010'] },
    async ({ api, docker, resultset }) => {
      test.setTimeout(180_000)
      // The schedule waits 20 s before each item, so the runner is idle and consuming while the scan runs.
      const scan = await resultset.start({ scanConfig: { items: ['hold-0', 'hold-1', 'hold-2', 'hold-3'], delay_seconds: 20 } })
      const queue = `scantor.scan.${scan.id}`
      await expect
        .poll(async () => (await docker.rabbitmqQueues()).find((candidate) => candidate.name === queue)?.consumers ?? 0, {
          timeout: 90_000,
          intervals: [1000],
        })
        .toBeGreaterThanOrEqual(1)

      const other = randomUUID()
      const maxAttempts = ok(await api.getScan(scan.id), 'getScan').settings.maxAttempts
      const configBytes = 70 * 1024
      const malformedReasons = async () =>
        ok(await api.call<Page<Event>>('listScanEvents', { path: { scanId: scan.id }, query: { type: 'worker.error', limit: 200 } }), 'listScanEvents')
          .items.map((event) => /malformed analysis message: (.*)$/.exec(event.message)?.[1])
          .filter((reason): reason is string => reason !== undefined)

      await withSession(scan.id, async (session) => {
        const messages = [
          analysisMessage(scan.id, 900, { scanId: other, analysisId: `${other}-900` }),
          analysisMessage(scan.id, 901, { analysisId: `${scan.id}-1` }),
          analysisMessage(scan.id, 902, { attempt: 99 }),
          analysisMessage(scan.id, 903, { config: { item: 'x'.repeat(configBytes), index: 903 } }),
          analysisMessage(scan.id, 904, { round: 0 }),
        ]
        for (const message of messages) await publish(session, EXCHANGES.analyses, scan.id, message, { type: 'analysis' })

        const expected: [number, RegExp][] = [
          [900, /^malformed analysis message: scanId does not match the worker's scan$/],
          [901, /^malformed analysis message: analysisId must be <scanId>-<seq>$/],
          [902, new RegExp(`^malformed analysis message: attempt must be an integer between 1 and ${maxAttempts}$`)],
          [903, /^analysis config is \d+ bytes; the maximum is 65536$/],
        ]
        for (const [seq, message] of expected) {
          await expect.poll(() => analysisStatus(api, scan.id, seq), { timeout: 120_000, intervals: [1000] }).toBe(200)
          const analysis = ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scan.id}-${seq}` } }), 'getAnalysis')
          expect(analysis, `seq ${seq}`).toMatchObject({ status: 'failed', round: 1, error: { type: 'validation', phase: 'validate', retryable: false } })
          expect(analysis.error!.message, `seq ${seq}`).toMatch(message)
        }

        // Unattributable messages (round 0, seq -1) are dropped with a worker error and write no analysis. The runtime
        // reports at most one error per type and phase every 10 s, so the second message is repeated until its
        // report gets through.
        await expect.poll(malformedReasons, { timeout: 60_000, intervals: [1000] }).toContain('round must be an integer ≥ 1')
        const unattributable = analysisMessage(scan.id, -1, { analysisId: `${scan.id}--1` })
        await expect
          .poll(
            async () => {
              await publish(session, EXCHANGES.analyses, scan.id, unattributable, { type: 'analysis' })
              return malformedReasons()
            },
            { timeout: 90_000, intervals: [3000] },
          )
          .toContain('seq must be an integer 0 ≤ seq < 2^53')
      })
      const seqs = await seqsOf(api, scan.id)
      expect(seqs).not.toContain(904)
      expect(seqs.filter((seq) => seq < 0)).toEqual([])
      expect(seqs).toEqual(expect.arrayContaining([900, 901, 902, 903]))
    },
  )
})
