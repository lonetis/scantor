# Queue and ingestion

This document specifies everything scantor does with RabbitMQ and how results get from the broker into
MongoDB: the broker configuration, the vhost, exchanges, queues, arguments and bindings and who declares
them when, the per-scan RabbitMQ user (password, permissions, limits, kill switch), the exact AMQP message
formats (properties, headers, bodies; JSON Schemas in `schemas/messages/`), the ingestor algorithm (batching,
guarded upserts, duplicate and poison handling, acks, live counters, recount, completion, circuit breaker),
the dead-letter consumer, how every scan lifecycle operation maps onto broker operations, stall detection,
and the backpressure and resource guards. The producer side (scheduler and runners) is in [runtime](runtime.md);
analysis documents, state machines and the completion function are in [data model](data-model.md); the
reconciler and jobs runner are introduced in [architecture](architecture.md) §4.1.

## 1. Overview

```
 scheduler worker ──publish rk=<scanId>──────────┐
 runner (retry, x-opt-delivery-time) ────────────┤
 orchestrator (retry-failed job) ────────────────┤
                                                 ▼
                                  ┌─[scantor.analyses] topic─┐
                                  │  binding  <scanId>       │
                                  ▼                          │
                   scantor.scan.<scanId>  (quorum, one per scan)
                   delivery-limit · DLX scantor.dead · max-length + reject-publish · consumer timeout
                          │ consume: 1 channel per process slot, prefetch 1
                          ▼
                   runner workers ──publish rk=<scanId> (result | attempt)──► [scantor.results] topic
                                                                                   │ binding #
                                                                                   ▼
                                                                    scantor.results.ingest (quorum)
                                                                                   │
                                                                                   ▼
                                                                       ingestor ──► MongoDB analyses, scans
   dead letters (delivery limit, rejected poison)                                  │ reject (malformed /
   from scantor.scan.* and scantor.results.ingest ──► [scantor.dead] topic ◄────────┘  unauthenticated)
                                                          │ binding #
                                                          ▼
                                                   scantor.dead.ingest (quorum) ──► dead-letter consumer
```

All objects live in the vhost `scantor`. The orchestrator is the only component that declares or deletes
objects; workers (per-scan users) can only consume their own queue and publish with their own routing key.

## 2. Broker configuration

Image `rabbitmq:4.4-management` (4.4 is required for quorum-queue delayed delivery with
`x-opt-delivery-time`). Configuration is environment-only: every `rabbitmq.conf` key is passed through
`RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS` in Erlang app-env syntax; no config or definitions file is mounted.

The compose files ([deployment](deployment.md)) set:

| Container variable | Value |
|---|---|
| `RABBITMQ_DEFAULT_USER` | `${SCANTOR_RABBITMQ_USER}` (the orchestrator's admin user, tag `administrator`; applied only at first init) |
| `RABBITMQ_DEFAULT_PASS` | `${SCANTOR_RABBITMQ_PASSWORD}` (applied only at first init) |
| `RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS` | the line below |

```
-rabbit max_message_size 4194304 -rabbit vm_memory_high_watermark {absolute,"${SCANTOR_RABBITMQ_MEMORY_WATERMARK}"} -rabbit disk_free_limit {absolute,"${SCANTOR_RABBITMQ_DISK_FREE_LIMIT}"} -rabbit consumer_timeout 1800000 -rabbit anonymous_login_user none -rabbit auth_mechanisms ['PLAIN','AMQPLAIN']
```

| Setting | Value | Why |
|---|---|---|
| `max_message_size` | 4 MiB | quorum queues keep messages in memory; the runtime caps result messages at 2 MiB, so 4 MiB only stops abuse. An oversized publish closes the publisher's channel with `406 PRECONDITION_FAILED - message size … is larger than configured max size` (verified on 4.4.0). |
| `vm_memory_high_watermark` | absolute, `SCANTOR_RABBITMQ_MEMORY_WATERMARK` | the relative default is computed from host or VM RAM, not the container limit. The container's memory cap is the separate variable `SCANTOR_RABBITMQ_MEMORY_LIMIT` (compose `mem_limit`), which must leave headroom above the watermark ([deployment](deployment.md) §4.4, §9). |
| `disk_free_limit` | absolute, `SCANTOR_RABBITMQ_DISK_FREE_LIMIT` | the default of 50 MB is far too low for a disk shared with MongoDB and RustFS. Both values accept the byte-size syntax of [architecture](architecture.md) §10 (`2GiB`, `5GiB`; verified). |
| `consumer_timeout` | 30 min (the default, set explicitly) | applies to quorum queues without `x-consumer-timeout` (the two global queues, whose consumers ack within seconds). Scan queues override it per queue (§3.3). On 4.4 the expiry response is `notify_consumer`: the consumer receives `basic.cancel` and its unacked messages return to the queue. |
| `anonymous_login_user` / `auth_mechanisms` | `none` / PLAIN, AMQPLAIN | 4.x enables ANONYMOUS by default; scantor never needs it. |

Other requirements (implemented in [deployment](deployment.md)): `mem_limit: ${SCANTOR_RABBITMQ_MEMORY_LIMIT}`;
`hostname: rabbitmq` and a volume at `/var/lib/rabbitmq` (the data directory is keyed by node name, so a
changing hostname starts an empty broker);
healthcheck `rabbitmq-diagnostics -q check_port_connectivity` (never `check_local_alarms`, an alarm is no reason
to restart); AMQP (5672) published on `SCANTOR_BIND_ADDRESS`, management (15672) on
`SCANTOR_ADMIN_BIND_ADDRESS`; with Traefik, AMQPS terminates on :443 via a TCP HostSNI router and remote nodes
use `SCANTOR_AMQP_PUBLIC_URL` (`amqps://amqp.<domain>:443`). Delayed messages survive a broker restart.

The orchestrator talks to the broker with the admin user over AMQP (`SCANTOR_AMQP_INTERNAL_URL`) and over the
management HTTP API (`SCANTOR_RABBITMQ_MANAGEMENT_URL`, Basic auth). Connection names:
`scantor-orchestrator/<component>/<instanceId>`.

## 3. Topology

### 3.1 Vhost

`scantor`, created with `PUT /api/vhosts/scantor {"description": "scantor", "default_queue_type": "quorum"}`.
Every queue scantor declares is a durable quorum queue (also declared explicitly with `x-queue-type:
quorum`). The admin user gets `PUT /api/permissions/scantor/<SCANTOR_RABBITMQ_USER> {"configure": ".*",
"write": ".*", "read": ".*"}`.

### 3.2 Exchanges

| Exchange | Type | Durable | Purpose | Routing key |
|---|---|---|---|---|
| `scantor.analyses` | topic | yes | analysis messages (scheduler, runner retries, retry-failed job) | `<scanId>` |
| `scantor.results` | topic | yes | result and attempt messages from runners | `<scanId>` |
| `scantor.dead` | topic | yes | dead letters of scan queues and of `scantor.results.ingest`; the broker keeps the original routing key | `<scanId>` |

All three are topic exchanges because RabbitMQ enforces topic permissions only on topic exchanges; that is
what binds a per-scan user to its own routing key (§4.2). None is `internal` or `auto_delete`.

### 3.3 Queues and arguments

| Queue | Arguments | Binding | Consumers |
|---|---|---|---|
| `scantor.scan.<scanId>` (one per non-terminal scan) | `x-queue-type: quorum`; `x-delivery-limit: SCANTOR_DELIVERY_LIMIT`; `x-dead-letter-exchange: scantor.dead`; `x-dead-letter-strategy: at-least-once`; `x-overflow: reject-publish`; `x-max-length: SCANTOR_SCAN_QUEUE_MAX_READY`; `x-consumer-timeout: settings.timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 300000` (ms) | `scantor.analyses`, key `<scanId>` | runner slots of that scan (user `scan-<scanId>`) |
| `scantor.results.ingest` | `x-queue-type: quorum`; `x-delivery-limit: 3`; `x-dead-letter-exchange: scantor.dead`; `x-dead-letter-strategy: at-least-once`; `x-overflow: reject-publish` (required by at-least-once dead-lettering; there is no `x-max-length`, so it never rejects) | `scantor.results`, key `#` | ingestor |
| `scantor.dead.ingest` | `x-queue-type: quorum`; `x-delivery-limit: 20` (no DLX: a message that kills the dead-letter consumer 21 times is dropped and logged by the broker) | `scantor.dead`, key `#` | dead-letter consumer |

Argument semantics (verified on RabbitMQ 4.4.0):

- **Delivery limit.** Counted returns are: client crash or connection loss (container death, network
  partition) and `basic.reject(requeue=true)`. Not counted: `basic.nack(requeue=true)` and consumer-timeout
  cancellations. With limit L a message is delivered at most L + 1 times, then dead-lettered with reason
  `delivery_limit`. The runtime never rejects ([runtime](runtime.md) §12), so the limit only fires for
  analyses whose processing repeatedly killed whole containers.
- **At-least-once dead-lettering** needs a DLX plus `x-overflow: reject-publish`; without the latter it silently
  falls back to at-most-once. Dead letters keep the body, routing key and properties (`user_id`, `type`,
  `message_id`) and carry broker-generated `x-death`, `x-first-death-{queue,reason,exchange}`,
  `x-last-death-*`, `x-delivery-count` and `x-acquired-count` headers. Forged `x-death`/`x-first-death-*`
  headers set by a publisher are **overwritten** by the broker when it dead-letters the message (verified), and
  per-scan users cannot publish to `scantor.dead`; the dead-letter consumer can therefore trust them.
- **`x-max-length` with `reject-publish`** counts ready **and delayed** messages (unacknowledged deliveries do
  not count). Once the queue holds more than the limit, it nacks **every** publish, including those with a
  future `x-opt-delivery-time`; a publisher it refused stays refused until the queue holds at most 80 % of the
  limit again, while a channel that has not published since is accepted as soon as the queue is back at the
  limit (verified on 4.4.0: at limit 5, six delayed messages were accepted and the seventh nacked; with the
  queue full, publishes dated 2 s, 60 s and 1 h ahead were nacked; at limit 10, a refused channel was accepted
  again at 8 messages, not at 9; at limit 2, a new channel was accepted at 2 messages and refused at 3). Quorum queues
  apply `reject-publish` with a lag: publishes already in flight to the leader are accepted, and only later
  publishes of the channel are nacked (verified on 4.4: at `x-max-length` 3, ten publishes in flight were all
  accepted and the following ones nacked). A scan queue can therefore exceed `x-max-length` by up to the
  publishers' unconfirmed windows (512 items per scheduler, [runtime](runtime.md) §11.4), so the bound is
  approximate. This is the scheduler's backpressure (§10); a runner whose retry republish is refused holds
  the delivery instead ([runtime](runtime.md) §8.11).
- **Ready count**: a passive `queue.declare` (allowed without configure permission) reports only the **ready**
  messages of a quorum queue: delayed and unacknowledged ones are missing (verified on 4.4.0: 0 with six delayed
  messages, 9 with nine ready and one unacknowledged). The scheduler reads its share of the queue this way
  ([runtime](runtime.md) §11.4).
- **Requeue**: `basic.nack(requeue=true)` returns a delivery to the **head** of a quorum queue, so the next
  delivery of the channel is usually the same message (verified on 4.4: eight nack-requeues of one message at
  delivery limit 5 redelivered it eight times, with `redelivered` set and without dead-lettering).
- **`x-consumer-timeout`** bounds how long one delivery may stay unacked. It equals the analysis timeout plus
  the upload timeout plus 5 minutes of margin, so a healthy runtime never reaches it ([runtime](runtime.md)
  §8.10). Because it is a queue argument, a running scan's `timeoutMs` cannot change
  ([data model](data-model.md) §4.5.1).
- **Delayed delivery**: a message published with header `x-opt-delivery-time` (AMQP long, epoch ms) is
  enqueued at once but invisible to consumers until that time, without head-of-line blocking. Purging or
  deleting a queue removes delayed messages too.

Queue arguments are immutable. Redeclaring an existing queue with different arguments fails with 406
`PRECONDITION_FAILED` (which closes the declaring channel). The reconciler treats that as "exists" and logs
`queueArgumentsMismatch` once: changing `SCANTOR_DELIVERY_LIMIT` or `SCANTOR_SCAN_QUEUE_MAX_READY` affects new
scans (and scans whose queue is recreated by retry-failed) only. A queue is never deleted to change its
arguments.

### 3.4 Policies

scantor defines **no policies**. Every behaviour of a queue is an explicit argument, so a queue describes
itself and running scans cannot be changed behind their back. Operators must not apply policies matching
`^scantor\.` (some policy keys, such as `delivery-limit`, override arguments).

### 3.5 Who declares what, and when

| Object | Created by | When | Removed by | When |
|---|---|---|---|---|
| vhost `scantor`, admin permissions | orchestrator boot step 5 ([architecture](architecture.md) §4.1) | every boot (idempotent `PUT`) | never | |
| exchanges `scantor.analyses`, `scantor.results`, `scantor.dead` | boot step 5; re-ensured by the reconciler before any topic permission | every boot, every reconciler tick | never | |
| `scantor.results.ingest`, `scantor.dead.ingest` and their bindings | boot step 5 | every boot | never | |
| `scantor.scan.<scanId>` and its binding | reconciler | scan `creating`, `running`, `paused` (including after retry-failed) | reconciler; `scanDelete` job | scan `completed`, `failed`, `cancelled`, `deleting` |
| user `scan-<scanId>`, permissions, topic permissions, user limits | reconciler (after the queue) | same | reconciler; `scanDelete` job | same, **always before the queue** |
| orphans (`scan-*` users and `scantor.scan.*` queues without a scan in `creating`/`running`/`paused`) | – | – | reconciler boot sweep and every tick (diff) | immediately |

Declarations use an AMQP channel of the admin connection (`exchange.declare`, `queue.declare`,
`queue.bind`); users, permissions and limits use the management API. Workers declare nothing (configure
permission `^$`).

**Reconciler topology loop** (every 10 s and on scan change-stream events, under the `reconciler` lock):

1. List the broker state with five calls: `GET /api/queues/scantor?name=^scantor\.scan\.&use_regex=true&page=<n>&page_size=500&columns=name,arguments,messages_ready,messages_unacknowledged,messages_delayed,consumers`
   (paginated), `GET /api/users`, `GET /api/permissions`, `GET /api/topic-permissions`, `GET /api/user-limits`.
2. Desired set D = scans with `state ∈ {creating, running, paused}`.
3. For each scan in D, ensure in this order, issuing only the calls whose object is missing or different:
   exchanges (boot already did; re-declare is cheap) → queue (`queue.declare` with §3.3 arguments) → binding →
   user → vhost permissions → topic permissions on both exchanges → user limits. When a `creating` scan is
   complete, set `state: running`, `startedAt` (conditional on `state: creating`). A failure sets the scan
   condition `topologyFailed` and is retried next tick.
4. For each `scan-*` user or `scantor.scan.*` queue whose scan is not in D (terminal, deleting, deleted or
   unknown): `DELETE /api/users/scan-<scanId>` first, then `DELETE /api/queues/scantor/scantor.scan.<scanId>`
   (404 counts as done).
5. The queue counts from step 1 feed metrics, the scan `progress` display and stall detection (§9). They lag
   by the management statistics interval (about 5–12 s) and are never used for correctness decisions other
   than stall detection, which requires the condition to persist for minutes.

Diffing against list calls keeps the cost at five HTTP calls per tick regardless of the number of scans.

## 4. Per-scan RabbitMQ user

### 4.1 Name and password

- Name: `scan-<scanId>`.
- Password: `base64url(HMAC-SHA256(HKDF(SCANTOR_SECRET, "amqp"), scanId))` without padding
  ([architecture](architecture.md) §9). It is never stored: the reconciler recomputes it to create the user,
  and `GET /api/runtime/bootstrap` recomputes it for workers. Recreating the user (retry-failed, broker reset)
  yields the same password, so running workers reconnect without a new bootstrap.
- Created with `PUT /api/users/scan-<scanId> {"password": "<password>", "tags": []}`. No tags: the user cannot log
  into the management API (401) but can use AMQP.

### 4.2 Permissions

Vhost permissions (`PUT /api/permissions/scantor/scan-<scanId>`); the scan id is a lowercase uuid and contains no
regex metacharacters other than `-`, which is literal outside character classes:

```json
{ "configure": "^$", "write": "^scantor\\.(analyses|results)$", "read": "^scantor\\.scan\\.5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f$" }
```

Topic permissions (`PUT /api/topic-permissions/scantor/scan-<scanId>`, one call per exchange; the exchanges must
exist first, otherwise the broker answers 400 `no_such_exchange`):

```json
{ "exchange": "scantor.analyses", "write": "^5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f$", "read": "^$" }
{ "exchange": "scantor.results",  "write": "^5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f$", "read": "^$" }
```

| A worker of scan S can | A worker of scan S cannot |
|---|---|
| consume `scantor.scan.S` (and passively declare it) | declare, delete or bind anything |
| publish to `scantor.analyses` and `scantor.results` with routing key `S` | publish with another routing key (403 `ACCESS_REFUSED`, channel closed) |
| set `user_id = scan-S` (the broker validates it) | set any other `user_id` (406 `PRECONDITION_FAILED`, channel closed) |
| purge its own queue `scantor.scan.S` (RabbitMQ authorises `queue.purge` with the read permission; the scan only loses its own messages, which stall detection records as `lost`, §9) | publish to `scantor.dead`, the default exchange, or any other exchange |
| | read or purge any other queue |

### 4.3 User limits

`PUT /api/user-limits/scan-<scanId>/max-connections {"value": C}` and `…/max-channels {"value": H}` with

```
C = 2 × (settings.workers + 1)          # runners + scheduler, ×2 for reconnect overlap
H = C × (settings.processes + 2)        # slot channels + publisher + spare per connection
```

`max-channels` counts channels across all of the user's connections. The reconciler updates both limits in the
same tick in which `scaleScan` changes the settings, before placement changes assignments, so a larger
`processes` value reaches a runtime only after the limit allows the extra channels. A runtime that hits a limit
sees a channel or connection error and treats it as a transient platform error.

### 4.4 Kill switch

`DELETE /api/users/scan-<scanId>` removes the user with its permissions and limits and force-closes all its live
connections with `CONNECTION_FORCED` (verified on 4.4.0). Every worker of the scan, including workers on
partitioned remote nodes, loses broker access at once; reconnects fail with `ACCESS_REFUSED`. The runtime then
aborts its work and exits ([runtime](runtime.md) §6.6). This is why cancel deletes the user before anything
else (§8).

## 5. Messages

Bodies are UTF-8 JSON with camelCase fields; times in bodies are integer epoch milliseconds. JSON Schemas
(draft 2020-12): `schemas/messages/analysis.schema.json`, `schemas/messages/result.schema.json`,
`schemas/messages/attempt.schema.json`. The Go runtime and the TypeScript ingestor share them (Go via the
embedded `schemas/`, TS via the orchestrator build).

### 5.1 AMQP properties and headers

| Property | Analysis | Result / attempt |
|---|---|---|
| `content_type` | `application/json` | `application/json` |
| `delivery_mode` | 2 (persistent) | 2 |
| `type` | `analysis` | `result` or `attempt` (informational; the body `kind` is authoritative) |
| `message_id` | fresh uuid per publish (correlates `basic.return` with the confirm) | fresh uuid per publish |
| `user_id` | `scan-<scanId>` (runtime) or the admin user name (retry-failed job); validated by the broker | `scan-<scanId>`; **required** |
| `app_id` | `scantor-runtime/<version>` or `scantor-orchestrator/<version>` | `scantor-runtime/<version>` |
| `timestamp` | publish time, seconds (AMQP timestamp) | same |
| headers | only `x-opt-delivery-time` (AMQP long, epoch ms) on retry republishes | none |

Every publish uses `mandatory: true` and publisher confirms. Exchanges and routing keys: analyses →
`scantor.analyses`, key `<scanId>`; results and attempt events → `scantor.results`, key `<scanId>`. The attempt
number lives only in the body.

### 5.2 Analysis message

Published by the scheduler (attempt 1), by runners for retries (attempt + 1, same `scheduledAt`) and by the
retry-failed job (round + 1, attempt 1). Consumed by runners.

```json
{
  "v": 1,
  "analysisId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "seq": 1234,
  "round": 1,
  "attempt": 1,
  "config": { "origin": "https://example.org" },
  "scheduledAt": 1761040805000
}
```

| Field | Type | Rule |
|---|---|---|
| `v` | 1 | message format version |
| `analysisId` | string | `<scanId>-<seq>` |
| `scanId` | uuid | equals the routing key |
| `seq` | integer | 0 ≤ seq < 2^53 |
| `round` | integer ≥ 1 | retry-failed generation |
| `attempt` | integer 1 … 20 | ≤ the scan's `maxAttempts` |
| `config` | object | analysis config, ≤ `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` serialized |
| `scheduledAt` | epoch ms | first publish of this seq in this round (server-corrected clock) |

### 5.3 Result message

Published by a runner when an analysis reaches a final outcome (succeeded, or failed without retry).

```json
{
  "v": 1,
  "kind": "result",
  "analysisId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "seq": 1234,
  "round": 1,
  "attempt": 2,
  "executionId": "b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e",
  "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "config": { "origin": "https://example.org" },
  "status": "succeeded",
  "result": { "status": 200, "title": "Example", "screenshot": { "id": "e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a", "name": "screenshot.png", "size": 48213, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "contentType": "image/png" } },
  "error": null,
  "files": [
    { "id": "e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a", "name": "screenshot.png", "size": 48213, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "contentType": "image/png" }
  ],
  "logTail": "fetching https://example.org\n",
  "timings": { "scheduledAt": 1761040805000, "startedAt": 1761040896000, "finishedAt": 1761040897200, "durationMs": 1200 }
}
```

Failed variant: `"status": "failed"`, `"result": null`, `"files": []`, and

```json
"error": { "type": "taskError", "message": "ConnectionResetError: [Errno 104] Connection reset by peer", "retryable": true, "phase": "run", "attempt": 3, "stack": "Traceback (most recent call last):\n  …", "at": 1761040990000 }
```

| Field | Rule |
|---|---|
| `kind` | `"result"` |
| `executionId` | uuid of this delivery's execution ([runtime](runtime.md) §8.3) |
| `workerId`, `nodeId` | from the worker's bootstrap; informational |
| `config` | copied from the analysis message (the ingestor needs it to create the document) |
| `status` | `succeeded` (then `result` is an object and `error` null) or `failed` (then `error` is set and `result` null) |
| `result` | ≤ `SCANTOR_MAX_RESULT_BYTES` serialized |
| `error` | ScantorError ([runtime](runtime.md) §9); never of type `cancelled`, which the runtime does not publish |
| `files` | FileRefs `{id, name, size, sha256, contentType}` of this execution (`name` 1–255 characters without NUL, `/` or `\`); keys are never sent |
| `logTail` | ≤ 32 KiB; the whole message ≤ 2 MiB |
| `timings` | `{scheduledAt, startedAt, finishedAt, durationMs}` of this attempt |

### 5.4 Attempt message

Published by a runner before it republishes an analysis for a retry ([runtime](runtime.md) §10.3).

```json
{
  "v": 1,
  "kind": "attempt",
  "analysisId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "seq": 1234,
  "round": 1,
  "attempt": 1,
  "executionId": "a1c0b9d8-7e6f-4a5b-8c4d-3e2f1a0b9c8d",
  "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "config": { "origin": "https://example.org" },
  "error": { "type": "timeout", "message": "run exceeded 30000 ms", "retryable": true, "phase": "run", "attempt": 1, "at": 1761040890000 },
  "logTail": "fetching https://example.org\n",
  "timings": { "scheduledAt": 1761040805000, "startedAt": 1761040860000, "finishedAt": 1761040890000, "durationMs": 30000 }
}
```

`attempt` is the number of the attempt that failed; `error.retryable` is always true; `logTail` ≤ 4 KiB.

### 5.5 Identity and trust

The ingestor treats bodies as untrusted input from the worker of one scan:

1. The scan identity comes only from the AMQP `user_id` property, which the broker validated against the
   authenticated user: it must match `^scan-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`.
   The routing key must equal that scan id (always true thanks to topic permissions; checked anyway).
2. `body.scanId` must equal it and `body.analysisId` must equal `<scanId>-<seq>`.
3. `_id = "<scanId>-<seq>"` is built from the credential-derived scan id; every filter contains `{_id, scanId}`.
4. Documents are built field by field from validated values. The body is never spread into a document or used
   as an update document; values such as `result` and `config` are stored as nested values only (MongoDB 9.0
   accepts `$`-prefixed and dotted keys inside nested values; verified).
5. `userId` comes from the scan document, never from the message. `workerId`/`nodeId` are informational and
   stored only when they are uuids.
6. File keys are recomputed by the ingestor (`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`,
   [data model](data-model.md) §9) with the same function the presign route uses; a key is never read from a
   message.

A malicious worker can therefore at most write wrong data into analyses of its own scan.

### 5.6 Versioning

`v` is 1. Changes within `v: 1` are additive: consumers of analysis messages (runtimes, which may be older than
the orchestrator that publishes retry-failed messages) ignore unknown fields, so the analysis schema allows
additional properties. Result and attempt messages are produced by runtimes of the orchestrator's version or the
previous minor version and consumed by the orchestrator, which always knows every field; their schemas are
closed. A breaking change would introduce `v: 2` with a transition period in which consumers accept both.

## 6. Ingestor

The ingestor runs in the `ingestor` component of the orchestrator (`orchestrator/server/services/ingestor/`,
amqplib 2.x, MongoDB driver 7.x). It owns one AMQP connection with two channels: the **result consumer** on
`scantor.results.ingest` and the **dead-letter consumer** on `scantor.dead.ingest` (§7). Both share the scan-state
cache, the write functions, the counters and the circuit breaker.

### 6.1 Consumer

`basic.qos(SCANTOR_INGEST_PREFETCH)`, `basic.consume(scantor.results.ingest, noAck: false, consumerTag:
"scantor-ingestor-<instanceId>")`. Deliveries are appended to the current batch. Exactly one flush runs at a
time; deliveries arriving during a flush go into the next batch (bounded by the prefetch).

### 6.2 Per-message validation

Checks 1–3 run when a delivery arrives; checks 4–7 run at the start of the flush that contains it:

| # | Check | On failure |
|---|---|---|
| 1 | `user_id` present and of the form `scan-<uuid>`; routing key equals that uuid | **reject** (`basic.reject(requeue=false)` → dead-lettered with reason `rejected` → security event, §7) |
| 2 | body ≤ 4 MiB, valid UTF-8 JSON object | reject |
| 3 | `body.scanId` and `body.analysisId` consistent with the credential (§5.5); `seq` an integer 0 ≤ seq < 2^53; `round` an integer ≥ 1; `attempt` an integer ≥ 1; `kind` ∈ {`result`, `attempt`} | reject |
| 4 | scan lookup (§6.3): scan unknown, `deleting` or `deleted` | **drop**: acked with the batch, nothing written (metric `scantor_ingest_messages_total{outcome="dropped"}`) |
| 5 | `body.round > scan.round`: the cached entry may predate a retry-failed round increase, so the scan is first re-read from MongoDB, bypassing the cache, and the entry refreshed (§6.3); the check applies to the fresh `scan.round` | drop when `body.round` still exceeds the fresh `scan.round` (logged at `warn` as `futureRound`) |
| 6 | the rest of the body against `result.schema.json` / `attempt.schema.json` (ajv, compiled once) | **record**: the analysis is written with the minimal failed document of §6.5, message "invalid result message: <first schema error>" (the message is authenticated and attributable, so the user should see it) |
| 7 | the update document serializes to BSON (`BSON.serialize`, catching serializer errors such as NUL bytes in keys, which `BSON.calculateObjectSize` does not reject) and stays below 15 MiB | record with the minimal failed document, message "result could not be stored: <reason>" |

Scans in every other state (`creating`, `running`, `paused`, `completed`, `failed`, `cancelled`) are ingested:
late results of cancelled scans are recorded, late duplicates of completed scans are absorbed by the guards.

### 6.3 Scan-state cache

An in-memory map `scanId → {state, round, userId, schedulingState, confirmed, fetchedAt}`:

- **Fill:** at the start of each flush, all scan ids of the batch that are missing are loaded with one
  `scans.find({_id: {$in: […]}}, {projection})`. Ids without a document are cached as unknown for 60 s.
- **Invalidation:** a change stream on `scans` (any insert, update, replace or delete; resume token kept in
  memory) deletes the entry of the changed scan, so the next flush reloads it. If the change stream fails, it is
  reopened with backoff and the whole cache is cleared; while it is down, entries older than 5 s are reloaded.
- **Stale round:** the change-stream event of a retry-failed round increase can arrive after the first round
  R + 1 results (and while the stream is down an entry may be up to 5 s old). A message whose `round` exceeds
  the cached round is therefore never dropped on the cached value: the flush reloads those scans with one
  `scans.find({_id: {$in: […]}}, {projection})` that ignores the cache, replaces their entries, and repeats
  check 5 (§6.2) against the fresh round.
- **Race with delete:** a result can be written in the instant between a scan entering `deleting` and the cache
  seeing it. The `scanDelete` job closes this window: it deletes the queue and user first (no new results can be
  produced) and ends with a final `deleteMany({scanId})` sweep after a settle delay of
  `2 × SCANTOR_INGEST_FLUSH_INTERVAL + 10 s` ([architecture](architecture.md) §11.3).

### 6.4 Batching and flush

A flush starts when the batch holds `SCANTOR_INGEST_BATCH_SIZE` messages, or `SCANTOR_INGEST_BATCH_MAX_BYTES` of
bodies, or `SCANTOR_INGEST_FLUSH_INTERVAL` has passed since the first message of the batch arrived.

```
flush(batch):
  1. load missing scan states (§6.3); apply checks 4–7 of §6.2 per message
  2. build one update operation per remaining message (§6.5)
  3. bulkWrite(ops, {ordered: false, writeConcern: {w: "majority"}})
  4. classify the outcome per operation (§6.6); run the follow-up bulkWrite if needed
  5. settle deliveries (§6.7)
  6. update live counters, rate window and breaker per scan (§6.8, §6.10); trigger completion checks (§6.9)
```

### 6.5 Guarded upserts

With `R = body.round`, `n = body.attempt`, `now` = the flush time, and `attemptEntry = {attempt: n, round: R,
executionId, workerId, nodeId, startedAt, finishedAt, durationMs, error (null on success), logTail (last 4 KiB)}`.
All operations are `updateOne` with `upsert: true`; `_id` and `scanId` are always equality conditions of the
filter, so an inserted document gets them from the filter.

**Succeeded result** (status rule: a later success beats any failure in the same round):

```js
filter: { _id, scanId, $or: [ { round: { $lt: R } },
                              { round: R, status: { $in: ["pending", "retrying", "failed", "lost", "cancelled"] } } ] }
update: { $set: { seq, round: R, status: "succeeded", attempt: n, config, result, files /* with keys */, logTail,
                  timings: { scheduledAt, startedAt, finishedAt, durationMs }, workerId, nodeId, executionId, updatedAt: now },
          $unset: { error: "" },
          $setOnInsert: { userId, createdAt: now },
          $push: { attempts: { $each: [attemptEntry], $slice: -10 } } }
```

**Failed result** (the first terminal result wins, except that a success replaces a failure):

```js
filter: { _id, scanId, $or: [ { round: { $lt: R } },
                              { round: R, status: { $in: ["pending", "retrying", "lost", "cancelled"] } } ] }
update: { $set: { seq, round: R, status: "failed", attempt: n, config, error, files: [], logTail, timings,
                  workerId, nodeId, executionId, updatedAt: now },
          $unset: { result: "" },
          $setOnInsert: { userId, createdAt: now },
          $push: { attempts: { $each: [attemptEntry], $slice: -10 } } }
```

**Attempt event** → `retrying` (ignored once the analysis is final or a later attempt was recorded):

```js
filter: { _id, scanId, $or: [ { round: { $lt: R } },
                              { round: R, status: { $in: ["pending", "retrying"] }, attempt: { $lt: n } } ] }
update: { $set: { seq, round: R, status: "retrying", attempt: n, config, error, files: [], timings,
                  workerId, nodeId, executionId, updatedAt: now },
          $unset: { result: "" },
          $setOnInsert: { userId, createdAt: now },
          $push: { attempts: { $each: [attemptEntry], $slice: -10 } } }
```

**Minimal failed document** (used for checks 6 and 7 of §6.2 and as the per-operation fallback of §6.6): the
failed-result filter with

```js
update: { $set: { seq, round: R, status: "failed", attempt: n, files: [], updatedAt: now,
                  error: { type: "platform", phase: "ingest", retryable: false, attempt: n, at: now,
                           message: "<reason, ≤ 1 KiB>" } },
          $unset: { result: "", logTail: "" },
          $setOnInsert: { userId, createdAt: now },
          $push: { attempts: { $each: [{ attempt: n, round: R, executionId, error: <same>, logTail: "" }], $slice: -10 } } }
```

(`config` is omitted because it may be the cause; `executionId` only if it is a uuid.) The error type is
`validation` instead of `platform` when the result exceeds `SCANTOR_MAX_RESULT_BYTES` ([security](security.md)
ING-4): the task produced it.

When the document exists and the filter does not match, the upsert tries to insert a second document with the
same `_id` and fails with **E11000** for that one operation: the message is a duplicate or was superseded
(older round, later attempt already recorded, already final). Other operations of the unordered batch still
apply (verified on MongoDB 9.0.4). The resulting rules ([data model](data-model.md) §6.3): a later success beats
a failure in the same round; otherwise the first terminal result wins; older rounds never overwrite newer ones;
duplicate deliveries never double-count.

### 6.6 bulkWrite outcome handling

| Outcome | Handling |
|---|---|
| success | every operation applied (inserted, or matched and updated) |
| `MongoBulkWriteError` with only `writeErrors` | per operation: code **11000** → candidate duplicate (below); any other code (for example 10334 `BSONObjectTooLarge`, 17419 document too large after update, 2 `BadValue`) → replace the operation with the minimal failed document for that analysis |
| follow-up | one more unordered `bulkWrite` containing (a) every E11000 operation again, unchanged, and (b) the minimal failed documents. A second E11000 is final: duplicate, acked. Retrying E11000 once makes the guard correct when two writers race on a not-yet-existing document (the result consumer and the dead-letter consumer run concurrently): the first insert wins the race, the retry then evaluates the guard against the existing document. Any other error in the follow-up: log at `error` with the analysis id, metric `scantor_ingest_write_failed_total`, and ack (never block the queue). |
| whole-batch failure: network error, server selection timeout, `NotWritablePrimary` (10107), `writeConcernError`, operation timeout, or any exception that is not a `MongoBulkWriteError` | **nothing is acked.** `basic.nack(multiple=true, requeue=true)` up to the highest delivery tag received so far (nack is not counted toward the delivery limit), `basic.cancel` the consumer, back off 1 s → 30 s (×2, full jitter) until `db.admin().ping()` succeeds on a writable primary, then `basic.consume` again. |
| the same batch fails as a whole 3 times in a row while the ping succeeds | **isolation mode** for the next delivery of those messages: write them one per `bulkWrite`; a message whose single write still fails with a non-transient error is recorded with the minimal failed document, or acked and logged if even that fails. This bounds the damage of an unknown poison message to that message. |

### 6.7 Acknowledgement

After the bulkWrite and its follow-up have returned (or after a whole-batch failure has been handled):

1. Messages that failed checks 1–3 were already rejected individually (`basic.reject(tag, requeue=false)`) when
   they arrived.
2. Every other message of the batch (applied, duplicate, dropped, recorded as failed) is settled with one
   `basic.ack(deliveryTag = highest tag of the batch that was not rejected, multiple = true)`. Rejected tags are
   no longer outstanding, so the multiple-ack covers exactly the remaining ones; if every message of the batch was
   rejected, no ack is sent.

Acks are sent only after MongoDB acknowledged the writes with majority write concern, so a crash at any point
redelivers the batch and the guards absorb the replay.

### 6.8 Live counters (hints) and rate

After each flush, per scan with at least one applied operation (not E11000, not dropped):

```js
scans.updateOne({ _id: scanId },
  { $inc: { "stats.succeeded": s, "stats.failed": f, "stats.retrying": r },
    $set: { "stats.ratePerMin": rate, updatedAt: now } })
```

`s`, `f`, `r` count applied succeeded, failed (including minimal and dead-lettered failures) and attempt
operations. These are **hints** for a live UI: they never decrement (`retrying → succeeded` is counted as one more
success without one less retry), so they drift until the next recount overwrites `stats` with exact values.
A failed hint update is logged and ignored.

`ratePerMin`: per scan, five one-minute buckets of applied terminal operations (succeeded + failed); the rate is
their sum divided by the number of minutes covered (1–5). It lives in memory only and restarts empty after an
orchestrator restart. ETA is computed by the API from `expectedTotal`, the recount and this rate
([api](api.md) §2).

### 6.9 Recount and completion

The recount and the completion function are shared by the ingestor and the reconciler and defined in
[data model](data-model.md) §6.1:

```js
// recount (authoritative), index {scanId: 1, status: 1, seq: 1}
analyses.aggregate([{ $match: { scanId } }, { $group: { _id: "$status", n: { $sum: 1 } } }])
// → $set stats.{pending, retrying, succeeded, failed, lost, cancelled}, stats.recountedAt

// completion (idempotent, the only path to completed/failed)
if (succeeded + failed + lost + cancelled >= scheduling.confirmed)
  scans.findOneAndUpdate(
    { _id: scanId, state: "running", round: R, "scheduling.state": { $in: ["done", "failed"] } },
    { $set: { state: scheduling.error ? "failed" : "completed", stateReason, stats, completedAt: now, updatedAt: now } })
```

The ingestor triggers `checkCompletion(scanId)` (recount, then the conditional update) after a flush when, from
the cache, `scheduling.state ∈ {done, failed}`, the scan is `running`, and the hint terminal count
(`succeeded + failed + lost + cancelled`) is at least `scheduling.confirmed`; at most once per scan per 10 s.
Other triggers (reconciler): scheduler `done`, end of retry-failed, resume, every 60 s per running scan, and once
more two minutes after a scan entered a terminal state to absorb late duplicates. A paused scan is recounted (never
completed) at the same 60 s cadence while its `updatedAt` is newer than `stats.recountedAt`, so results of work that
finished during the drain do not leave drifted hints on it. A hint that overestimates only causes an early recount;
one that underestimates delays completion until the periodic recount.

### 6.10 Circuit breaker

Per scan, in memory: a sliding window of length `SCANTOR_BREAKER_WINDOW` in 10-second buckets counting **applied**
attempt outcomes: successes = applied succeeded results; failures = applied failed results (any type, including
dead-lettered crashes and ingest failures) + applied attempt events. Duplicates (E11000) do not count.

After each flush, for each running scan: if `attempts ≥ SCANTOR_BREAKER_MIN_ATTEMPTS` and
`failures / attempts ≥ SCANTOR_BREAKER_RATIO`, the scan is auto-paused:

```js
scans.findOneAndUpdate({ _id: scanId, state: "running" },
  { $set: { state: "paused", pausedAt: now, updatedAt: now,
            stateReason: { code: "failureRate", message: "<p>% of the last <a> attempts failed", at: now },
            breaker: { trippedAt: now, ratio, attempts, windowMs } } })
```

plus condition `breakerTripped {ratio, attempts, windowMs}` and event `scan.stateChanged` (`reason:
failureRate`). Workers then drain exactly as on a user pause (§8). The window of a scan is cleared whenever the
scan leaves `running`, so a resumed scan starts with a fresh window. `SCANTOR_BREAKER_MIN_ATTEMPTS=0` disables the
breaker.

### 6.11 Metrics

Exposed through `/api/metrics` ([architecture](architecture.md) §4.1). [deployment](deployment.md) §13.1 is
the single metric catalogue (types, labels, meaning); the queue and ingestor metrics it lists are
`scantor_ingest_messages_total{kind, outcome="applied|duplicate|dropped|rejected|failedRecorded"}`, `scantor_ingest_flush_seconds` (histogram),
`scantor_ingest_batch_size` (histogram), `scantor_ingest_whole_batch_failures_total`,
`scantor_ingest_write_failed_total`, `scantor_ingest_lag_messages` (ready count of `scantor.results.ingest`),
`scantor_dead_letters_total{source="scan|results", reason}`, `scantor_breaker_trips_total`, and the per-scan
queue gauges `scantor_scan_queue_messages{scanId, state="ready|unacked|delayed"}`.

## 7. Dead-letter consumer

Consumes `scantor.dead.ingest` with `basic.qos(50)`, one message at a time (dead letters are rare). The source is
taken from the broker-set header `x-first-death-queue`.

| Source (`x-first-death-queue`) | Reason (`x-first-death-reason`) | Handling |
|---|---|---|
| `scantor.scan.<id>` | `delivery_limit` | The analysis repeatedly killed the containers processing it. Validate: routing key = `<id>` (enforced at the original publish by topic permissions), `user_id` absent, `scan-<id>` or the admin user, body a valid analysis message of scan `<id>`. Scan state checks as §6.2 checks 4–5. Write the failed-result upsert of §6.5 with `config` from the body, `attempt` from the body, no files, no log tail, and `error = {type: "crash", phase: "run", retryable: false, attempt, at: now, message: "every worker that received this analysis died while processing it (delivered <x-delivery-count> times, delivery limit <SCANTOR_DELIVERY_LIMIT>)", details: {deathReason, deathQueue, deliveryCount, acquiredCount}}` (values from the `x-first-death-reason`, `x-first-death-queue`, `x-delivery-count` and `x-acquired-count` headers). Counts as a failure for the breaker and the hints. |
| `scantor.scan.<id>` | any other (`rejected` from a misbehaving runtime) | as above with `type: "platform"`, `phase: "platform"`, message "dead-lettered (<reason>)" |
| `scantor.results.ingest` | `rejected` | A message the result consumer rejected (§6.2 checks 1–3). Re-run those checks to obtain the reason and write event `security.ingestRejected` `{reason, routingKey, userIdProperty}` with `userId: null` (admin-only), at most one event per (routing key, reason) per 60 s; always increment `scantor_dead_letters_total`. Nothing else is written. |
| `scantor.results.ingest` | `delivery_limit` | The result was delivered 4 times without being acked (repeated orchestrator crashes while it was in flight). Process it alone through the normal path (§6.2–§6.6) as a batch of one; if that fails with anything other than a transient MongoDB error, record the minimal failed document when the identity is valid, otherwise log and drop. |
| anything else | – | log at `error`, ack |

Writes use the same guarded upserts and follow-up rules as the result consumer, so a crash record never
overwrites a real result: if a duplicate execution already published a result, the guard keeps it. Transient
MongoDB failures are handled like whole-batch failures (§6.6): `basic.nack(requeue=true)`, cancel, back off,
re-consume. Every other outcome is acked.

## 8. Lifecycle operations on the broker

API handlers only change intent in MongoDB ([architecture](architecture.md) §11.3); the reconciler and jobs
perform the broker operations below.

| Operation | Broker operations, in order | Effect on workers | Effect on ingestion |
|---|---|---|---|
| **pause** (user or breaker) | none: queue (ready and delayed) and user stay | state polls return `drain`: slots cancel their consumers, in-flight analyses finish within `SCANTOR_WORKER_DRAIN_GRACE`, the rest is nacked with requeue (uncounted); the scheduler checkpoints and exits; workers are removed | results keep being ingested; completion cannot happen while paused; delayed retries become due and wait in the queue |
| **resume** | the topology loop re-ensures queue and user (normally a no-op) | new runners consume; a new scheduler (if scheduling is unfinished) gets `epoch + 1` and resumes from the checkpoint | completion check |
| **scale** | user limits raised (§4.3) before assignments change | slots opened or closed; workers added or drained | – |
| **cancel** | (1) `DELETE /api/users/scan-<id>`: force-closes every connection of the scan (kill switch); (2) `DELETE /api/queues/scantor/scantor.scan.<id>`: drops ready, delayed and unacked messages | runtimes lose their connections, get `ACCESS_REFUSED` and `stop`; workers are removed | results already in `scantor.results.ingest` are still recorded; then the reconciler sets `pending`/`retrying` analyses to `cancelled` and recounts (never-run seqs count as cancelled implicitly) |
| **retry-failed** (failed and lost analyses with a config) | the scan is `running` again, so the topology loop recreates queue, binding and user (same password); the `scanRetryFailed` job waits until the queue exists, then publishes (below) | new runners consume round R + 1 | round R + 1 results apply; late round-R messages are superseded (E11000) |
| **delete** | job step 1: user absent, then queue absent (idempotent; normally already gone because the scan was terminal) | – | results of `deleting`/`deleted` scans are dropped; the job ends with a final sweep (§6.3) |
| **completed / failed** (terminal cleanup) | user deleted, then queue deleted (the topology loop's step 4) | idle workers are removed (they hold nothing: every confirmed analysis is final) | late duplicates are absorbed by the guards; final recount after 2 minutes |
| **restart** | none on the original; the clone is a new scan with its own queue and user | – | – |

**retry-failed publisher** (`scanRetryFailed` job, `reconciler` component, `params.round = R + 1`, cursor
`{phase, afterSeq}`; `R` is the round before the retry). Retried are `failed` **and `lost`** analyses that
still have a stored `config` (lost documents converted from `pending`/`retrying` by stall detection keep it,
§9); gap-filled `lost` documents without a config and all `cancelled` analyses are not retried (the user
restarts the scan instead):

1. `materialize` (only for scans that were cancelled): walk `{scanId, seq}` and insert `cancelled` documents
   (no config) for missing seqs `< scheduling.confirmed`, so they are visible and countable.
2. `reset`: in batches of 1000 by seq, `updateMany({scanId, status: {$in: ["failed", "lost"]}, round: {$lte: R},
   config: {$exists: true}, seq: {$gt: afterSeq, $lte: batchEnd}}, {$set: {status: "pending", round: R + 1,
   attempt: 0, updatedAt}})`; then a recount.
3. `publish`: wait until `scantor.scan.<id>` exists (management API, 5 s polling). Then read documents
   `{scanId, status: "pending", round: R + 1}` in seq order (batches of 1000 after `afterSeq`) and publish each
   config as an analysis message `{round: R + 1, attempt: 1, scheduledAt: now}` on the admin connection's confirm
   channel with `mandatory` and `user_id = SCANTOR_RABBITMQ_USER`. Nacked messages (queue full): wait 2 s ± 20 %,
   republish only the nacked ones, repeat. Returned messages (queue missing): wait for the topology loop and
   retry. After a batch is fully confirmed, persist `afterSeq`. A crash resumes from the cursor; re-published
   seqs are duplicates the guards absorb.
4. `finish`: `scheduling.state` → `failed` if `scheduling.error` is set, else `done`; recount; completion check.

## 9. Stall detection and lost gap fill

Messages can disappear without a result: an operator purges or deletes a queue, the broker loses its volume, a
bug drops a delivery. Without detection such a scan would stay `running` forever. The reconciler evaluates every
running scan each tick:

| Condition (all must hold continuously for `SCANTOR_SCAN_STALL_AFTER`) | Source |
|---|---|
| `state = running` and `scheduling.state ∈ {done, failed}` (not during retry-failed) | MongoDB |
| `messages_ready + messages_unacknowledged + messages_delayed = 0` for `scantor.scan.<id>` (a missing queue counts as 0) | management API list (§3.5) |
| no runner of the scan reported a non-empty `busy[]` | in-memory state polls |
| the latest recount has `succeeded + failed + lost + cancelled < scheduling.confirmed` | recount |

The duration requirement covers the lag of management statistics and of state polls. When it is met:

1. Walk the index `{scanId: 1, seq: 1}` with projection `{seq, status}`, comparing against `0 …
   scheduling.confirmed − 1`.
2. For missing seqs: `insertMany(ordered: false)` in batches of 1000 of documents `{_id, scanId, userId, seq,
   round: scan.round, status: "lost", attempt: 0, attempts: [], files: [], error: {type: "platform", phase:
   "platform", retryable: false, attempt: 0, at: now, message: "lost: no message for this analysis remained in the
   queue and no worker was processing it"}, createdAt, updatedAt}` (no config). E11000 (a result arrived
   meanwhile) is ignored.
3. For existing documents with `status ∈ {pending, retrying}`, one pipeline update: `updateMany({scanId, status:
   {$in: ["pending", "retrying"]}}, [{$set: {status: "lost", updatedAt: now, error: {type: "platform", phase:
   "platform", retryable: false, attempt: "$attempt", at: now, message: <as above>}}}])`. They keep their config
   ([data model](data-model.md) §6.3).
4. Raise the condition `stalled {lost: n}`, write event `scan.lostAnalyses {count: n}`, run the completion
   function. The scan completes with a warning; retry-failed (§8) re-runs the `lost` analyses that kept their
   config, and a restart re-runs everything.

A late result for a `lost` analysis still applies (the guards allow `lost → succeeded|failed` in the same round).

## 10. Backpressure and resource guards

| Guard | Mechanism | Effect |
|---|---|---|
| scan queue size | `x-max-length = SCANTOR_SCAN_QUEUE_MAX_READY` with `x-overflow: reject-publish`; the scheduler keeps at most half of it (`amqp.maxLength / 2`, ready messages plus its unconfirmed publishes) | the scheduler reads the ready count and waits while its share is used up ([runtime](runtime.md) §11.4), so the other half stays free for retries, which count toward the limit while they are delayed (verified on 4.4 by `internal/runtime/worker` `TestSchedulerShareWithRabbitMQ`). Publishes that the full queue still refuses (more retries delayed than half the limit, a queue filled by retry-failed) are nacked; the scheduler then waits 2 s ± jitter and republishes only the nacked seqs. Quorum queues accept publishes already in flight to the leader, so the queue can exceed the limit by up to the unconfirmed windows of its publishers (§3.3; verified on 4.4 by `TestSchedulerBackpressureWithRabbitMQ`). |
| retries never lost | runners publish retries with `x-opt-delivery-time ≥ server now + 1 s` into the half of the queue the scheduler leaves free; a full queue nacks them too (§3.3), so a refused retry is backpressure: the runner holds the delivery, republishes until the retry is due, then runs the next attempt on the held delivery, and gives the delivery back (`basic.nack(requeue=true)`, uncounted) only when its holding budget cannot cover another attempt ([runtime](runtime.md) §8.11) | a full queue cannot turn a retry into a lost or failed analysis, and it does not make the runner unhealthy |
| retry-failed | same nack-and-wait loop (§8), without the scheduler's share: it publishes up to the broker's limit | large retry-failed jobs respect the same bound; while such a job keeps the queue full, the retries of its analyses are refused and held by their runners ([runtime](runtime.md) §8.11) |
| analyses per scan | `SCANTOR_MAX_ANALYSES_PER_SCAN` (start-time estimate, runtime enforcement) | bounds per-scan broker and database volume |
| message size | broker `max_message_size` 4 MiB; runtime caps result messages at 2 MiB, results at `SCANTOR_MAX_RESULT_BYTES`, configs at `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` | large data goes to S3 as files |
| memory and disk alarms | absolute `vm_memory_high_watermark` and `disk_free_limit` (§2) | during an alarm the broker blocks publishers. Runtimes stop consuming and wait ([runtime](runtime.md) §6.5). The ingestor keeps consuming (consumers are not blocked), which drains `scantor.results.ingest` and relieves memory. The reconciler polls `GET /api/health/checks/alarms` every tick and raises `brokerAlarm` on running scans; `startScan` answers 503 `brokerAlarm`; `/api/health` reports `degraded`. |
| connections and channels per scan | user limits (§4.3) | one scan cannot exhaust broker connection or channel capacity |
| delivery limit | `SCANTOR_DELIVERY_LIMIT` on scan queues | a poison analysis that kills containers stops after L + 1 deliveries and is recorded as `crash` |
| failure storms | circuit breaker (§6.10) | a broken task is paused before it burns its whole retry budget across the fleet |
| ingestor memory | `SCANTOR_INGEST_PREFETCH` × message size (worst case prefetch × 2 MiB); batches flush early at `SCANTOR_INGEST_BATCH_MAX_BYTES` | lower the prefetch for tasks with very large results |
| ingest results queue | no `x-max-length`: results must never be refused, because runtimes would hold their deliveries and retry; its growth is bounded by runner throughput and, ultimately, by the memory/disk alarms | lag is visible as `scantor_ingest_lag_messages` |
| queue count | one quorum queue per non-terminal scan; terminal scans delete theirs | stays far below the ~5000-queue level where quorum-queue churn needs a topology review |

## 11. Failure scenarios

| Event | What happens |
|---|---|
| a runner's retry republish is refused because the scan queue is full | the runner holds the delivery and republishes; when the retry is due it runs the next attempt on the held delivery; only when the holding budget cannot cover another attempt does it give the delivery back with `basic.nack(requeue=true)` (uncounted; the next delivery re-runs the same attempt) ([runtime](runtime.md) §8.11) |
| a runner container is killed mid-analysis | its connection dies; the broker returns the delivery (delivery count + 1) to another runner, which checks the status (`redelivered`) and runs it again. If the killed runner had already published, the duplicate is absorbed. |
| a remote node is partitioned longer than the AMQP heartbeat | the broker closes the connection and requeues its deliveries; other runners execute them. When the partition heals, the old runtime publishes its finished results after reconnecting (duplicates absorbed). If the node stays offline, its workers become `lost` and their tokens stop working. |
| the orchestrator crashes between the bulkWrite and the ack | the batch is redelivered; every operation is E11000 (or re-applies identically); counters are hints and the recount fixes them; completion is a single conditional update. |
| RabbitMQ restarts | quorum queues, delayed messages, users and permissions persist; runtimes and the ingestor reconnect with backoff; unconfirmed publishes are repeated. |
| RabbitMQ loses its volume | vhost, exchanges and global queues are recreated at the next orchestrator boot; the topology loop recreates scan queues and users within one tick; runtimes reconnect with the unchanged HMAC passwords; lost messages are found by stall detection (§9). |
| MongoDB is down | the ingestor nacks and pauses (§6.6); results accumulate in `scantor.results.ingest`; runtimes keep working. |
| a worker publishes a forged result for another scan | impossible: its routing key and `user_id` are bound to its own scan by the broker; identity comes only from `user_id` (§5.5). |
| a malformed or unauthenticated message reaches the ingest queue | rejected to `scantor.dead`, recorded as a rate-limited security event (§7). |
| a scan is deleted while results are queued | the cache drops them; the delete job's final sweep removes any write that raced the state change. |
| two schedulers run after a partition | both publish; the stale one is fenced by 409 `staleEpoch` or 401 within seconds; duplicate seqs are absorbed. |

## 12. Decisions

Made in this document and flagged for lead review:

1. **Broker memory and disk limits** come from `SCANTOR_RABBITMQ_MEMORY_WATERMARK` (the absolute
   `vm_memory_high_watermark`) and `SCANTOR_RABBITMQ_DISK_FREE_LIMIT` (absolute values in the platform's
   byte-size syntax), interpolated into `RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS`; `SCANTOR_RABBITMQ_MEMORY_LIMIT`
   is only the container memory cap (lead ruling, [deployment](deployment.md) naming).
2. **No RabbitMQ policies**; all behaviour is in explicit queue arguments. Argument mismatches on redeclare are
   tolerated, never fixed by deleting a queue.
3. **Dead-letter queue arguments**: `scantor.results.ingest` uses `x-overflow: reject-publish` without a length
   limit (needed for at-least-once dead-lettering); `scantor.dead.ingest` has delivery limit 20 and no DLX.
4. **Topology reconciliation by diff** against five management list calls per tick, instead of per-scan GETs.
5. **User limits**: `max-connections = 2 × (workers + 1)`, `max-channels = max-connections × (processes + 2)`,
   updated before assignments change.
6. **Authenticated but schema-invalid results are recorded** as failed (`platform`/`ingest`) instead of being
   rejected, so the user sees them; only unauthenticated or unattributable messages are rejected.
7. **The dead-letter consumer writes `security.ingestRejected` events** by re-running the cheap identity checks,
   rate-limited per routing key and reason; the result consumer's hot path writes no events.
8. **E11000 operations are retried once** in a follow-up bulkWrite, which makes the guards correct with
   concurrent writers (the result and dead-letter consumers already are two).
9. **Isolation mode** after three consecutive whole-batch failures with a healthy primary.
10. **Dead-lettered analyses become `crash` failures** with the broker's death headers in `details`; dead letters
    from `rejected` runtimes become `platform` failures.
11. **Stall detection also converts `pending`/`retrying` documents to `lost`** (data-model §6.3), so analyses
    reset by retry-failed whose messages vanished are not stuck either; such `lost` documents keep their config
    and are retried by retry-failed together with `failed` ones (lead ruling); `cancelled` analyses are never
    retried.
12. **Ingestor cache** is filled per flush with one `$in` query and invalidated by a change stream; the delete race is
    closed by the delete job's final sweep.
13. **Result and attempt messages carry `config`**, so the first write of an analysis creates a complete document.
14. **Retries keep half of a scan queue**: delayed retries count toward `x-max-length` and a full queue refuses
    future-dated publishes too (§3.3), so the scheduler fills at most half of the queue ([runtime](runtime.md)
    §11.4) and a runner holds a retry that the queue still refuses ([runtime](runtime.md) §8.11). The retry-failed
    publisher does not keep the share yet (§13).

## 13. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Separate ingestor service and multiple ingestors | `SCANTOR_COMPONENTS=ingestor` runs it alone; competing consumers on `scantor.results.ingest` are safe because every write is a guarded upsert and E11000 is retried once; breaker windows and rates would need a shared store (or per-instance approximations) to be exact. |
| Multi-replica orchestrator | the topology loop and jobs already run under `locks`; the ingestor needs no lock. |
| Scan priorities | quorum queues support message priorities (32 levels, always on); the scheduler would set `priority`, and placement could favour high-priority scans. |
| Cron / recurring scans | each occurrence is a normal scan with its own queue and user; no topology change. |
| STS S3 credentials, multipart > 5 GiB | no broker change; messages already carry only FileRefs. |
| `ctx.memo`, `ctx.expectTotal` | handled over HTTP (`scheduler/resolved`); no message change. |
| Streams for audit or replay | a RabbitMQ stream bound to `scantor.results` could keep a replayable history without touching the ingest path. |
| Per-tenant broker isolation | a vhost per tenant would only change the vhost name in bootstrap and in the reconciler; permissions are already per user. |
| Federation / multiple brokers | `user_id` must be preserved across links (`trust-user-id`); identity rules would otherwise need signed bodies. |
| Larger fleets | quorum queues can be spread over a RabbitMQ cluster (`x-quorum-initial-group-size`); nothing in the message contract assumes a single node. |
| Retry-failed share of the queue | the `scanRetryFailed` publisher could read the ready count like the scheduler (`checkQueue` on a channel of its own) and publish each batch in slices of the free half of the queue, so retry-failed rounds leave room for retries as well. |
