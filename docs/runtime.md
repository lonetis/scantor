# Runtime

This document specifies the **runtime**: the language-agnostic Go process `scantor runtime` that runs inside
every worker container, every test-run and `scantor dev run` container, and every describe/check container
of the task pipeline. It defines the runtime's modes, how it is injected and configured, how it bootstraps
and polls the orchestrator, how it consumes and publishes on RabbitMQ (one channel per process slot plus a
shared confirm publisher), how it manages connector processes, the exact run and schedule paths, the unified
error model, the retry policy, platform-error handling, logging, all limits and timers, graceful shutdown,
and the local-mode output format. All retry, timeout, upload, publish and error-classification logic of
scantor lives here and nowhere else. The broker topology and the ingestor that consumes what the runtime
publishes are in [queue](queue.md); the wire format between the runtime and connector processes is in
[protocol](protocol.md); the HTTP routes it calls are in [api](api.md) §8; persistent state is in
[data model](data-model.md); the system context is in [architecture](architecture.md).

## 1. Overview

### 1.1 Responsibilities

| Concern | The runtime does | It does not |
|---|---|---|
| Configuration | reads the variables the node daemon sets (§3.2) and the base-image ENV contract; gets everything else from `GET /api/runtime/bootstrap` | read `.env`, config files or flags for behaviour |
| Queue | consumes the scan queue (runners), publishes analyses (scheduler, retries), results and attempt events, with publisher confirms and `mandatory` | declare queues or exchanges (its RabbitMQ user has configure `^$`) |
| Connector processes | spawns, supervises, recycles and resizes them; enforces timeouts by killing process groups | parse user-code types (the connector is the authoritative validator) |
| Templates | runs unwrapped templates natively (`internal/templates/<name>`) and serves wrapped template calls | — |
| Errors | classifies every failure into one `ScantorError`, decides retry vs final, computes delivery times | trust `retryable` or `phase` from connectors |
| Files | hashes, size-checks and uploads files through presigned PUT URLs | choose S3 keys (the orchestrator generates them) |
| Liveness | state polls with `busy[]`, clock offset correction, graceful drain | write to MongoDB |

### 1.2 Process model

```
worker container scantor-w-<workerId>  (HostConfig.Init = true)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ PID 1  docker-init (tini)  ── forwards SIGTERM/SIGINT to its child                       │
│  └─ /scantor/scantor runtime worker                         (the runtime)                │
│       ├─ HTTP client ──────────► SCANTOR_URL/api/runtime/*   (Bearer swt_…)               │
│       ├─ AMQP connection ──────► bootstrap.amqp.url          (user scan-<scanId>)         │
│       │    ├─ publisher channel  (confirm mode, shared by all slots and the scheduler)   │
│       │    ├─ slot channel 0     qos prefetch 1, one consumer on scantor.scan.<scanId>   │
│       │    └─ slot channel P−1   …                                                       │
│       ├─ slot 0 ── connector process (own process group, fd 3 ⇄ fd 4, stdout/stderr pipes) │
│       └─ slot P−1 ── connector process                                                   │
│ /tmp/scantor/  proc-<slot>-<gen>/ (per-process TMPDIR)  x-<executionId>/ (per execution) │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

A **slot** (internal runtime term, never shown to users) is the pairing of one connector process with one
AMQP slot channel. `processes` slots exist per runner worker. The scheduler worker has no slot channels:
it has either one connector process (custom schedule) or none (unwrapped template, executed natively).

### 1.3 Code layout

`internal/runtime/` itself holds only what every part shares: `LoadConfig` (the environment of §3.2),
the classified Go error `Error` (also returned by `internal/templates`) and the AMQP message bodies of
`schemas/messages/` (analysis, result, attempt); it imports none of its sub-packages. Sub-packages:
`bootstrap` (HTTP client, bootstrap, state poll, clock, error reports, scheduler routes), `amqpx`
(connection, slot channels, publisher), `pool` (process spawn, handshake, recycle, resize), `runner` (run
path), `scheduler` (schedule path, checkpoints), `worker` (worker-mode wiring: transport check, bootstrap,
inner `dockerd`, AMQP, role, signals, exit code), `local`, `describe`, `check`, `pipeline` (the task-pipeline
events of describe and check, §16), `scerr` (the error model, truncation and retry policy), `logtail`,
`upload`, `canonical` (RFC 8785 JSON), `dind` (the inner `dockerd`, §4.4); `internal/runtime/internal/`
holds the test fakes (`fakeapi` orchestrator, `fakebroker`, `fakeconn` scripted connector). The hidden
`scantor runtime worker|local|describe|check` commands are registered in `internal/cli/runtime.go`. Shared
code: `internal/protocol` (connector messages), `internal/templates` (native templates), `internal/api`
(wire types and the transport policy check shared with the node daemon, §4.2), `internal/languages`.

## 2. Modes

| Mode | Command (entrypoint) | Started by | AMQP | Platform API | Connector processes | Output |
|---|---|---|---|---|---|---|
| **worker** (role `scheduler`) | `/scantor/scantor runtime worker` | node daemon | publish only | `/api/runtime/*` | 0 (native template) or 1 | JSON logs on stderr |
| **worker** (role `runner`) | `/scantor/scantor runtime worker` | node daemon | consume + publish | `/api/runtime/*` | `processes` | JSON logs on stderr |
| **local** | `/scantor/scantor runtime local --spec /scantor/in/spec.json` | CLI `dev run` / `dev debug`, `testRun` job | none | none | 1 (schedule) then `processes` | NDJSON events on stdout (§15), files in `/scantor/out` |
| **describe** | `/scantor/scantor runtime describe --entry <entry>` | task pipeline (`scantor task build`) | none | none | 1 | NDJSON task-pipeline events on stdout (§16) |
| **check** | `/scantor/scantor runtime check --entry <entry>` | task pipeline | none | none | 0 (runs `SCANTOR_CHECK_CMD`) | NDJSON task-pipeline events on stdout (§16) |

The role of a worker is not a command-line choice: it comes from the worker token and is returned by
bootstrap (`worker.role`). "Scheduler mode" and "runner mode" in other documents mean worker mode with that
role. Flags exist only on `local`, `describe` and `check`, which are invoked by scantor's own code, never by
users; they carry inputs (paths, the entry), not configuration.

## 3. Injection and environment

### 3.1 Injection

The runtime is never part of an image. Every consumer injects its own static binary (`CGO_ENABLED=0`,
linux, the consumer's architecture) into the task container:

1. `ContainerCreate` with `Entrypoint: ["/scantor/scantor", "runtime", "<mode>", …flags]`, `Cmd: []`,
   `WorkingDir` unset (the image's `WORKDIR /task` applies), managed labels and the hardening profile
   ([nodes](nodes.md), [security](security.md)).
2. `CopyToContainer(path: "/")` of one tar stream with these entries (owner 0:0):

   | Entry | Mode | Present in |
   |---|---|---|
   | `scantor/` | `0755` dir | all modes |
   | `scantor/scantor` | `0755` file (the consumer's own binary; a CLI on darwin/windows extracts the linux binary from the scantor image `<prefix>scantor:<tag>`, image-reference rule of [architecture](architecture.md) §4.2: compiled-in defaults, replaced by `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG` when `SCANTOR_IMAGE_TAG` is non-empty) | all modes |
   | `scantor/in/` | `0755` dir | local |
   | `scantor/in/spec.json` | `0644` | local |
   | `scantor/in/uploads/<uploadId>` | `0644` | local, when the configs reference uploads |
   | `scantor/out/` | `01777` dir | local |

3. `ContainerStart`.

The image's `USER` is kept: the runtime and its connector processes run as whatever user the task image
declares (root for the stock base images). Nothing the runtime writes at run time lives under `/scantor`
except `/scantor/out` (local mode); all scratch data goes to `/tmp/scantor` (§7.1), which is world-writable
in every base image.

The runtime version is the consumer's version: node daemons inject their own, so a node upgrade upgrades the
runtime of every worker it starts, including workers of old revisions. The orchestrator accepts runtimes of
its own and the previous minor version ([api](api.md) §1.10). The connector protocol version is negotiated in
the handshake (`hello`/`welcome`, §7.2).

### 3.2 Environment the runtime reads

| Variable | Set by | Used in modes | Meaning |
|---|---|---|---|
| `SCANTOR_URL` | node daemon (from the endpoint profile: `SCANTOR_INTERNAL_URL` on the built-in node, `SCANTOR_PUBLIC_URL` on remote nodes) | worker | orchestrator base URL |
| `SCANTOR_WORKER_TOKEN` | node daemon (from the assignment) | worker | `swt_<workerId>.<mac>`; read once at start, then removed from the runtime's own environment |
| `SCANTOR_CA_CERT` | node daemon (passthrough of its own value) | worker | optional PEM bundle appended to the system roots for HTTPS, AMQPS and S3 |
| `SCANTOR_ALLOW_INSECURE_TRANSPORT` | node daemon (passthrough) | worker | `true` permits plaintext to public hosts (§4.2) |
| `SCANTOR_DIND` | node daemon (sysbox and privileged DinD workers only, [nodes](nodes.md) §6.9) | worker | `1` = start the inner `dockerd` before any connector process (§4.4); absent otherwise |
| `SCANTOR_LANGUAGE` | base image ENV | all | the image's language names (`typescript javascript` in `scantor-base-js`); informational (logs; fallback of the `start` event's `language`, §15.3) |
| `SCANTOR_CONNECTOR_CMD` | base image ENV | worker, local, describe | command template that starts a connector process |
| `SCANTOR_DEBUG_CMD` | base image ENV | local (`debug: true`) | command template that starts a connector under a debugger |
| `SCANTOR_DEBUG_PORT` | base image ENV | local (`debug: true`) | port the debugger listens on (reported in the `start` event) |
| `SCANTOR_CHECK_CMD` | base image ENV | check | static type-check command template; empty = skipped |
| `TMPDIR` | image (optional) | all | parent of the work root; default `/tmp` |

Operator-facing variables (`SCANTOR_CA_CERT`, `SCANTOR_ALLOW_INSECURE_TRANSPORT`) are documented only in
`.env.example`, where the node daemon reads them. The others are internal contracts, not operator
configuration: the node daemon sets `SCANTOR_URL`, `SCANTOR_WORKER_TOKEN` and `SCANTOR_DIND`
([nodes](nodes.md) §6.3), and the base-image variables belong to the base image contract ([tasks](tasks.md)
§4.2). Everything else (limits, intervals, credentials, data-source URLs) comes from bootstrap (worker mode)
or the local spec (local mode).

### 3.3 Command templates

`SCANTOR_CONNECTOR_CMD`, `SCANTOR_DEBUG_CMD` and `SCANTOR_CHECK_CMD` are command templates, never passed to a
shell:

1. Split into arguments on ASCII whitespace; a double-quoted span (`"…"`) is one argument without the quotes;
   `\"` and `\\` are the only escapes inside quotes. An unterminated quote is an error.
2. In every argument, replace the literal token `{entry}` with the entry (bootstrap `revision.entry`, the
   local spec `entry`, or `--entry`).
3. Resolve the first argument like `execvp`: an argument containing `/` is a path (a relative path is
   relative to `/task`), any other is looked up in `PATH` of the runtime's environment; execute with
   `execve` and working directory `/task`.

Examples: `python -m scantor.serve {entry}`, `node /node_modules/@scantor/connector/serve.js {entry}`,
`{entry}` (Go: the entry is the binary `/task/task`).

### 3.4 Environment of connector processes

A connector process gets the runtime's environment (that is, the image ENV plus the variables above) with
these changes:

| Change | Variables |
|---|---|
| removed | `SCANTOR_WORKER_TOKEN`, `SCANTOR_URL`, `SCANTOR_CA_CERT`, `SCANTOR_ALLOW_INSECURE_TRANSPORT` |
| set | `TMPDIR=/tmp/scantor/proc-<slot>-<gen>` (deleted when the process is recycled) |
| set | the protocol variables defined in [protocol](protocol.md) (fd numbers, protocol versions offered) |

User code therefore never sees platform credentials. The per-scan AMQP password and presigned URLs live only
in the runtime's memory.

## 4. Worker mode startup

### 4.1 Sequence

```
start ─► read env, drop SCANTOR_WORKER_TOKEN from os environ ─► transport check (§4.2)
      ─► GET /api/runtime/bootstrap  (retry 1 s → 60 s, jittered, forever)
            401 → exit 0 · 426 → log, exit 1 · action "stop" → exit 0
      ─► clock offset from serverTime (§5.2)
      ─► mkdir /tmp/scantor (0700), remove leftovers of a previous container start
      ─► SCANTOR_DIND=1: start dockerd, wait for /var/run/docker.sock (≤ 60 s) (§4.4)
      ─► AMQP connect (§6.1)
      ─► role scheduler ─► §11
         role runner    ─► spawn `processes` connector processes in parallel (§7)
                            each slot: handshake hello → welcome → ready (§7.2) ─► free-space check
                                       ─► open slot channel ─► basic.consume
      ─► state-poll loop (§5) runs from here on, in parallel
```

The first successful bootstrap moves the worker to `running` ([data model](data-model.md) §6.6) and, for
the scheduler, `scheduling.state` to `running`. The runtime keeps the bootstrap document in memory for its
whole life; the only values that change later come from state polls (`action`, `processes`) and scheduler
responses (`staleEpoch`).

Bootstrap fields used (exact shapes in [api](api.md) §8.1):

| Field | Used for |
|---|---|
| `worker.{id, role, scanId, nodeId, epoch}` | identity in messages, logs and scheduler calls |
| `scan.round` | `round` of messages the **scheduler** publishes (runners take the round from each message) |
| `scan.taskConfig`, `scan.scanConfig` | passed to every `schedule`/`run` call, secrets in clear text |
| `scan.settings.{processes, timeoutMs, maxAttempts, backoff, maxAnalysesPerProcess}` | pool size, timeouts, retry policy, recycling |
| `revision.{entry, protocolVersion, schedule}` | `{entry}`, logging of the negotiated version (§7.2), native vs connector schedule |
| `amqp.{url, vhost, username, password, queue, analysesExchange, resultsExchange, routingKey, heartbeatSeconds, consumerTimeoutMs}` | connection, consume, publish, holding budget |
| `uploads.{mode, maxFileBytes, maxFilesPerAnalysis, timeoutMs}` | file limits, PUT timeouts (`mode` is `presigned`) |
| `limits.*` (including `maxProcessesPerWorker` and `minFreeTmpBytes`) | §17 |
| `intervals.*` | §17 |
| `scheduler.{checkpoint, resolved, uploads, dataSources, restarts}` | §11; `restarts` (the scan's current `scheduling.restarts`) gives the `schedule` ctx `attempt` (§11.1) |

### 4.2 Endpoint profile and transport security

The runtime does not know which endpoint profile its node uses; it simply uses `SCANTOR_URL`, then the AMQP
URL from bootstrap, then the presigned URLs from the orchestrator, all of which the orchestrator computed for
the node's profile ([architecture](architecture.md) §8). Before the first connection to each of these three
endpoints the runtime applies the platform transport rule ([security](security.md)):

- `https://` and `amqps://` are always allowed; TLS verification is always on (system roots plus
  `SCANTOR_CA_CERT`). There is no skip-verify option.
- `http://` and `amqp://` are allowed only when every address the host resolves to is loopback
  (`127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64.0.0/10`, used by
  WireGuard and Tailscale overlays) or IPv6 ULA (`fc00::/7`), or when
  `SCANTOR_ALLOW_INSECURE_TRANSPORT=true`. The check runs in the dialer on the actual peer address, so DNS
  changes cannot bypass it ([architecture](architecture.md) §6.3, [nodes](nodes.md) §11). Compose service
  names (`orchestrator`, `rabbitmq`, `rustfs`) resolve to private addresses, so the built-in node needs no
  flag.
- A refused orchestrator URL is a fatal startup error (exit 1). A refused AMQP URL is reported through
  `POST /api/runtime/errors` (`fatal: true`, type `platform`, phase `bootstrap`) and exits 1. A refused
  presigned URL is a deterministic upload failure (§8.8).

### 4.3 HTTP client

Every request carries `Authorization: Bearer <worker token>`, `User-Agent: scantor-runtime/<version>`,
`X-Scantor-Version: <version>` and a timeout (bootstrap 30 s, others 15 s).

| Route | Retries | Special responses |
|---|---|---|
| `GET /api/runtime/bootstrap` | forever, 1 s → 60 s, ×2, full jitter | 401 → exit 0; 426 → exit 1 |
| `POST /api/runtime/state` | none (next poll) | 401 → `stop` |
| `POST /api/runtime/uploads/presign` | within the holding budget (§8.10), 1 s → 30 s | 400/403 → deterministic failure (§8.8) |
| `POST /api/runtime/analyses/status` | none (one try, 5 s timeout); failure → run anyway | |
| `POST /api/runtime/scheduler/{resolved,checkpoint,done}` | 1 s → 60 s until success | 409 `staleEpoch` → exit 0 (§11.8) |
| `POST /api/runtime/errors` | at most 3 tries; at most one report per (type, phase) per 10 s, except fatal reports and the restart reports of §11.9 | |

A 401 on any route means the worker is no longer active (stopped, lost, scan terminal): the runtime behaves
as for `action: "stop"` (§14.2).

### 4.4 Docker-in-Docker workers (`SCANTOR_DIND=1`)

The node daemon sets `SCANTOR_DIND=1` only on workers of privileged revisions, which run as Sysbox or
privileged containers with an anonymous volume at `/var/lib/docker` ([nodes](nodes.md) §6.9). The runtime,
not the task, starts the inner Docker daemon; the task image must contain it (task Dockerfiles install
Docker when they need it, [tasks](tasks.md)). Only worker mode reads `SCANTOR_DIND`.

1. After a successful bootstrap with `action: "run"` and before the AMQP connection, resolve `dockerd` in
   `PATH`. If it is missing: report `POST /api/runtime/errors {fatal: true, error: {type: "validation",
   phase: "bootstrap", message: "SCANTOR_DIND=1 but dockerd is not installed in the task image; install
   Docker in the task's Dockerfile"}}` and exit 1.
2. Start `dockerd` without arguments (default socket `/var/run/docker.sock`, data in `/var/lib/docker`) as a
   child in its own process group, with stdin `/dev/null`. Its stdout and stderr are mirrored into the
   runtime log like connector output (§13.2, `stream: "dockerd"`) and the last 4 KiB are kept.
3. Wait until `/var/run/docker.sock` exists and answers `GET /_ping` with 200 (polled every 250 ms), at most
   **60 s**. On timeout or an early exit of `dockerd`: report a fatal `platform`/`bootstrap` error ("dockerd
   did not become ready within 60 s", `context.stderrTail` = the kept output), kill the process group and
   exit 1.
4. Continue with the AMQP connection and the connector processes. `dockerd` is not part of any slot: killing
   a connector's process group never touches it, and connector processes reach it through the default
   socket (`SCANTOR_DIND` stays in their environment, so user code can detect DinD).
5. If `dockerd` exits while the worker runs, the runtime reports a fatal error (type `platform`, phase
   `platform`, "dockerd exited with <code>"), runs the drain sequence (§14.1, giving back what cannot finish)
   and exits 1.
6. On shutdown `dockerd` is stopped last (§14.1 step 5, §14.2): `SIGTERM`, then `SIGKILL` to its process
   group after 3 s.

Exit 1 in steps 1, 3 and 5 makes the node daemon restart the container with crash-loop backoff and raise
`crashLoop` ([nodes](nodes.md) §6.5), so a task image without Docker is visible on the scan page.

## 5. State polling and the corrected clock

### 5.1 Poll loop

Every `nextPollMs` of the last response (initially `intervals.statePollMs`) ± `intervals.statePollJitter`
(uniform), the runtime sends `POST /api/runtime/state` ([api](api.md) §8.2):

| Request field | Value |
|---|---|
| `processes.running` | slots with a ready connector process and an open slot channel |
| `processes.busy` | slots currently executing an analysis; for the scheduler 1 while a schedule run is in progress and 0 while it starts its connector or waits out a restart backoff (§11.9) |
| `busy[]` | per busy slot `{seq, round, attempt, executionId, startedAt, progress}`; `progress` is the last value the connector reported with a `progress` call, else null |
| `consuming` | true when at least one slot has an active consumer |
| `clockOffsetMs` | current offset (§5.2), rounded |
| `tmpFreeBytes` | free bytes of the filesystem holding `/tmp/scantor` |
| `counters` | cumulative since start: `succeeded`, `failed` (final failed results), `retried` (attempt events), `redeliveredSkipped` |
| `scheduler` | scheduler only: `{published, confirmed, nacked, backpressure}` |

Response handling:

| Response | Behaviour |
|---|---|
| `action: "run"`, `processes: P` | resize the pool to P (§7.4), clamped to 1 … `limits.maxProcessesPerWorker`; the scheduler ignores `processes` |
| `action: "drain"` | graceful drain, then exit 0 (§14.1) |
| `action: "stop"` | abort, then exit 0 (§14.2) |
| network error, 5xx, timeout | keep the last known state and keep working; log at `warn` once per minute |
| 401 | `stop` |

The orchestrator returns a higher `processes` only after the node has applied the larger container limits,
and a lower one immediately ([architecture](architecture.md) §11.3), so the runtime never needs to reason about
memory limits itself.

### 5.2 Clock offset

`x-opt-delivery-time` and all message timestamps are compared with the broker's and orchestrator's clocks,
not the node's ([queue](queue.md) §10). The runtime keeps a corrected clock:

- Each bootstrap, state, checkpoint and done response carries `serverTime` (epoch ms). With `t0` and `t1` the
  local wall-clock times before sending and after receiving, `rtt = t1 − t0` (measured with the monotonic
  clock) and `sample = serverTime + rtt/2 − t1`.
- The first sample sets `offset`. Later samples with `rtt ≤ 2000 ms` update it as an EWMA:
  `offset = 0.8 × offset + 0.2 × sample`. Samples with a larger rtt are discarded.
- `serverNow() = localNow() + offset`. Every timestamp the runtime produces (`scheduledAt`, `startedAt`,
  `finishedAt`, `ScantorError.at`, delivery times) uses `serverNow()`; durations use the monotonic clock.
- `clockOffsetMs` is reported in every state poll; the orchestrator raises the scan condition `clockSkew`
  for offsets above 2 s ([data model](data-model.md) §4.5.4). Correction makes skew harmless for retries, so
  the condition is informational.

## 6. AMQP

amqp091-go v1.16.0 (no built-in recovery; the runtime implements reconnects).

### 6.1 Connection

- One connection per worker: `amqp.DialConfig(url, {Vhost, SASL PLAIN(username, password), Heartbeat:
  heartbeatSeconds, Properties: {connection_name: "scantor-runtime/<role>/<workerId>"}, TLSClientConfig})`.
- Watchers: `NotifyClose` (connection), `NotifyBlocked` (connection), per channel `NotifyClose`,
  `NotifyCancel`, and on the publisher `NotifyPublish` (confirms) and `NotifyReturn`.
- The runtime never declares exchanges or queues and never binds. A missing queue shows up as a 404
  `NOT_FOUND` channel error on `basic.consume` (§6.6).

### 6.2 Slot channels (runners)

Per slot: one channel, `Qos(prefetchCount: 1, prefetchSize: 0, global: false)`, and one consumer
`Consume(queue, consumerTag: "w-<workerId8>-s<slot>-<gen>", autoAck: false, exclusive: false)` where
`workerId8` is the first 8 characters of the worker id and `gen` increments on every re-consume.

Rules:

- A slot consumes only while its connector process is ready (handshake finished with `ready`, not
  recycling), free space is above
  `limits.minFreeTmpBytes`, the worker is healthy (§12) and the connection is not blocked (§6.5).
- Prefetch 1 means a slot holds at most one unacknowledged delivery, which is always the analysis it is
  executing. There is never a backlog of undispatched messages to give back.
- To stop receiving while keeping the current delivery ackable (recycle, resize, drain, unhealthy), the slot
  calls `basic.cancel(consumerTag)`. Deliveries of a consumer the **client** cancelled stay owned by the
  channel and are still acked or nacked normally.
- A slot channel is used only for `basic.consume`, `basic.ack` (`multiple=false`) and `basic.nack`
  (`multiple=false, requeue=true`). It never publishes and never calls `basic.reject`.

### 6.3 Shared confirm publisher

All publishes of a worker (results, attempt events, retry republishes, scheduler analyses) go through one
channel in confirm mode, owned by a publisher goroutine:

1. `Confirm(noWait: false)` once per channel; `NotifyReturn(buffer 256)`.
2. Each publish: `PublishWithDeferredConfirmWithContext(ctx, exchange, routingKey, mandatory: true,
   immediate: false, msg)` with the properties of [queue](queue.md) §5.1, including `MessageId` = a fresh
   uuid per publish (the correlation key for returns) and `UserId` = `amqp.username`.
3. The publish completes when its confirmation arrives:
   - `basic.ack` → success, unless a `basic.return` with the same `MessageId` was received first (amqp091-go
     dispatches the return before the ack of the same message, so the runtime drains the return channel
     before evaluating an ack) → **returned**.
   - `basic.nack` → **nacked** (for scan queues: queue full under `x-overflow=reject-publish`).
   - no confirmation within 30 s, or the channel/connection closed → **unconfirmed** (outcome unknown; the
     publish is retried, duplicates are harmless).
4. A publisher channel that closes (for example 406 for an oversized message, 403 for a permission bug) is
   reopened; all unconfirmed publishes are reported as unconfirmed to their callers.

What each outcome means for each publish kind is defined where the publish happens (§8.9, §10.3, §11.4).

### 6.4 Consumer cancellation (NotifyCancel)

The broker cancels a consumer when the queue is deleted (scan cancelled or terminal) or when the consumer
timeout fires (`x-consumer-timeout`, [queue](queue.md) §3.3). In both cases the broker has **already
returned** the slot's unacked delivery to the queue (or dropped it with the queue), and a later `basic.ack` for
it would be silently ignored. Handling:

1. Mark the slot's current delivery as **detached**: the analysis continues to completion and its result
   (or attempt event and republish) is published normally, because the ingestor deduplicates
   ([queue](queue.md) §6.5). A detached delivery is never acked or nacked.
2. Close the slot channel after the analysis finishes; open a new channel and `basic.consume` again.
3. A consume that fails with 404 `NOT_FOUND` means the queue is gone: the slot stays idle, the runtime polls
   state immediately and follows the returned action (normally `stop`). Retries of the consume use
   1 s → 30 s backoff.

The consumer timeout is set so that a healthy runtime never hits it (§8.10); hitting it is logged at
`error` with the analysis id.

### 6.5 Connection blocked (NotifyBlocked)

During a RabbitMQ memory or disk alarm the broker blocks publishing connections. On `Blocking{Active: true}`:

- every slot cancels its consumer after its current analysis (no new work while results cannot be
  published);
- publishes wait for `Blocking{Active: false}`; while waiting, the holding budget of each delivery keeps
  running (§8.10);
- the scheduler stops pulling items from its generator;
- the state poll reports `consuming: false`.

On unblock, slots re-consume and publishing resumes.

### 6.6 Connection loss and the kill switch

On connection loss (`NotifyClose` with an error, including `CONNECTION_FORCED`):

1. All slot deliveries become detached (the broker returns them when it notices the dead connection; this
   counts toward the delivery limit, [queue](queue.md) §3.3). Running analyses continue.
2. Reconnect with 1 s → 30 s backoff (×2, full jitter). While disconnected, finished analyses wait for the
   publisher; no slot consumes.
3. After reconnecting: reopen the publisher, publish the waiting results/attempt events/republishes (each
   still bounded by its holding budget measured from its original delivery), then reopen slot channels and
   re-consume. The scheduler republishes every unconfirmed seq (§11.4).
4. A reconnect refused with `ACCESS_REFUSED` (403) means the per-scan RabbitMQ user no longer exists: the
   scan was cancelled or became terminal (deleting the user is the cancel kill switch,
   [queue](queue.md) §4.4), or the broker lost its users and the reconciler has not recreated them yet. The
   runtime aborts all running analyses as in §14.2 (there is nowhere to publish), polls state immediately and
   exits 0 on `stop`/401. If the state poll is not conclusive, it keeps retrying; after 60 s of continuous
   `ACCESS_REFUSED` it exits 0 (if the worker is still desired, the node daemon starts it again).

## 7. Process pool

### 7.1 Spawn

For slot `s`, generation `g`:

1. `mkdir /tmp/scantor/proc-<s>-<g>` (0700).
2. Create two pipes: `A` (runtime writes, connector reads) and `B` (connector writes, runtime reads), plus
   stdout and stderr pipes. `exec.Cmd` with `ExtraFiles = [A.read, B.write]`, so the child sees them as
   **fd 3** and **fd 4**; stdin is `/dev/null`; `Dir = /task`; `Env` per §3.4.
3. `SysProcAttr{Setpgid: true, Pdeathsig: SIGKILL}`: the connector leads its own process group (pgid = its
   pid), so `kill(-pgid, SIGKILL)` reaches every child it spawns (browsers, shells); `Pdeathsig` kills it if
   the runtime dies.
4. Immediately after `Start`, write `1000` to `/proc/<pid>/oom_score_adj` (raising the value needs no
   privilege). Under memory pressure the kernel OOM killer then picks connector processes, never the runtime.
   Failure to write is logged at `warn` and ignored.
5. Perform the handshake on fds 3/4 (§7.2).

Per-execution directories live next to the process directories: `/tmp/scantor/x-<executionId>/` with
`tmp/` (ctx `tmpDir`) and `files/` (where the connector places file contents before registering them, §8.4).
Both are deleted after the execution's outcome has been published (or given back). The work root
`/tmp/scantor` is on the container's disk-backed writable layer: worker containers have **no tmpfs at
`/tmp`** ([nodes](nodes.md) §6.3), so files of up to `uploads.maxFileBytes` never count against the
container's memory limit. `tmpFreeBytes` (§5.1) and the `limits.minFreeTmpBytes` check (§6.2, §12) are the
`statfs` free bytes of the filesystem holding `/tmp/scantor` (inside a container this is the node's Docker
data filesystem).

### 7.2 Handshake and protocol versions

The handshake is `hello` → `welcome` → `ready` ([protocol](protocol.md) §4, §5.2):

1. The connector sends `hello {protocol: {min, max}, connector: {language, version, runtime?}, pid}` within
   **30 s** of start, before it imports user code.
2. The runtime supports protocol versions N and N−1 (N = the newest version it implements) and chooses
   `v = min(N, hello.protocol.max)`. If `v < max(N−1, hello.protocol.min)` there is no common version: it
   sends `error` with id `hello` (type `validation`, "connector protocol <min>..<max> is not supported by
   runtime <version> (protocol <N−1>..<N>); publish a new revision to rebuild the task on a current base
   image"), closes fd 3 and kills the process group. Otherwise it sends `welcome {protocolVersion: v, mode,
   runtime: {version}, limits, cancelGraceMs: 5000}`; `limits` carries `maxLineBytes` and the runtime's
   current `maxResultBytes`, `maxAnalysisConfigBytes`, `maxFileBytes` and `maxFilesPerAnalysis`.
3. The connector imports the entry, builds the task definition and sends `ready` within **120 s** of
   `welcome`. On failure it sends `error` with id `hello` (`taskError` for an exception at import,
   `validation` for an invalid definition, with message and stack) and exits 1.
4. Only after `ready` does the runtime send requests. In debug mode (§15.5) the `hello` and `ready`
   timeouts are disabled.

In worker mode `revision.protocolVersion` (the version negotiated when the revision was described) is only
logged next to the negotiated `v`: the connector in the image is the one that was described, so a newer
runtime negotiates the same or a compatible version. A process that exits before `ready`, misses a timeout,
sends a handshake `error`, writes invalid JSON on fd 4, or sends any other message first is a spawn failure
(§7.5).

### 7.3 Recycling

A process is replaced (graceful shutdown of the old one, spawn of a new one with `gen+1`) when:

| Trigger | Notes |
|---|---|
| it has handled `settings.maxAnalysesPerProcess` analyses | counted per process |
| an analysis timed out | the process group was already killed (§8.5) |
| it crashed or violated the protocol | already dead or killed |
| it was sent `cancel` (shutdown, §14) | a cancelled process is never reused ([protocol](protocol.md) §10.4) |
| its `TMPDIR` cannot be cleaned | defensive |

Graceful shutdown: send `shutdown {graceMs: 5000}` ([protocol](protocol.md) §5.9), close fd 3, wait 5 s for
exit, then `kill(-pgid, SIGKILL)` and reap. Its `proc-<s>-<g>` directory is removed.

Recycling never holds a queued message: when the slot knows the process must be replaced after the current
analysis, it cancels its consumer (§6.2) **before** acking, then recycles, then re-consumes after the new
process sent `ready`.

### 7.4 Live resize

The target is `processes` from the latest state poll (`run` action).

- **Up** (target > current slots): spawn the missing processes in parallel; each new slot opens its channel and
  consumes after `ready`.
- **Down** (target < current slots): choose slots to remove, idle slots first, then the most recently
  started analyses last (highest slot index breaks ties). An idle slot cancels its consumer, closes its
  channel and shuts down its process at once. A busy slot cancels its consumer, finishes its analysis (publish
  and ack as usual), then closes and shuts down. `processes.running` in the next poll reflects the slots
  still open, which lets the orchestrator lower the container limits afterwards.
- Resizes never touch `basic.qos`; each slot always has prefetch 1.

### 7.5 Spawn failures

A spawn failure is: the command cannot be started, the process exits before `ready`, no `hello` within 30 s or
no `ready` within 120 s of `welcome`, no common protocol version, a handshake `error`, or a protocol violation
before `ready` (§7.2). The runtime keeps the last 4 KiB of the process's stderr.

| Situation | Behaviour |
|---|---|
| no handshake of the worker has succeeded yet | retry the slot 3 times (1 s, 2 s, 4 s); then report `POST /api/runtime/errors` with `fatal: true`, phase `bootstrap`, type `platform` (for a handshake `error`: the connector's type `taskError` or `validation` with its message and stack), `context.stderrTail`, and exit 1. The node daemon restarts the container with backoff and raises `crashLoop` ([nodes](nodes.md)). |
| later respawn of a slot fails | the slot retries with 1 s → 60 s backoff without consuming; 3 consecutive failures across the worker make the worker unhealthy (§12) |

## 8. Runner: the run path

```
broker            slot                     connector          orchestrator             RustFS
  │── deliver(m) ──►│ parse + validate (8.1) │                     │                       │
  │                 │ redelivered? ──────────┼── analyses/status ─►│ (8.2)                 │
  │                 │ run(ctx, config) ─────►│ (8.3)               │                       │
  │                 │◄── file / log / progress (8.4)               │                       │
  │                 │◄── result | error ─────│   or exit / deadline kill (8.5)             │
  │                 │ classify (8.6) · checks (8.7)                │                       │
  │                 │──────────── uploads/presign ────────────────►│ (8.8)                 │
  │                 │──────────────────── PUT × n ────────────────────────────────────────►│
  │◄─ publish result / attempt + republish (mandatory, confirm) (8.9)                      │
  │── confirm ─────►│                         │                     │                       │
  │◄── ack(m) ──────│  cleanup x-<executionId>, maybe recycle       │                       │
```

### 8.1 Delivery and message validation

The slot receives one delivery. Before anything else it records `deliveredAt` (monotonic) for the holding
budget. Then it parses the body as an analysis message ([queue](queue.md) §5.2,
`schemas/messages/analysis.schema.json`):

| Check | On failure |
|---|---|
| JSON object, `v == 1`, required fields present and typed | malformed |
| `scanId == worker.scanId` and `analysisId == scanId + "-" + seq` | malformed |
| `0 ≤ seq < 2^53`, `round ≥ 1`, `1 ≤ attempt ≤ settings.maxAttempts` | malformed |
| `config` serialized size ≤ `limits.maxAnalysisConfigBytes` | `validation` failure of the analysis (published as failed result, §8.9) |

A **malformed** message cannot be attributed reliably. If `seq` and `round` are usable integers, the runtime
publishes a failed result for them with a `validation` error (phase `validate`, "malformed analysis message:
<reason>"); otherwise it logs at `error`, reports a worker error and acks the delivery (it is dropped, never
requeued). Only this scan's user and the orchestrator can publish to the scan queue, so malformed messages
indicate a bug, not an attack on other tenants.

Unknown body fields are ignored (forward compatibility, [queue](queue.md) §5.6).

### 8.2 Redelivered status check

If the delivery has `redelivered = true` (the broker returned it after a container death, connection loss or
consumer timeout), the runtime asks whether the analysis already reached a final state:

- Requests from all slots within a 20 ms window are coalesced into one `POST /api/runtime/analyses/status
  {seqs}` (≤ 1000 seqs).
- Skip rule ([api](api.md) §8.4): ack without running when the document's `round` is greater than the message
  `round`, or equal with `status ∈ {succeeded, failed}`. `counters.redeliveredSkipped` increments.
- Every other answer (`null`, `pending`, `retrying`, `lost`, `cancelled`, older round) and every failure of the
  call (orchestrator unreachable, timeout) → run the analysis. Running twice is always safe.

A redelivery re-executes the **same** attempt number with a new `executionId`: a container death is not a
`run` failure and does not consume an attempt. Repeated container deaths are caught by the queue's delivery
limit, which dead-letters the message and records the analysis as failed with type `crash`
([queue](queue.md) §7).

### 8.3 Dispatch

1. `executionId` = new uuid v4; `startedAt = serverNow()` (timings); arm the deadline timer at monotonic
   now + `settings.timeoutMs` (§8.5); `deadlineMs = localNow() + settings.timeoutMs`, on the container's own
   wall clock, because connectors arm their timers against it ([protocol](protocol.md) §5.1).
2. Create `/tmp/scantor/x-<executionId>/{tmp,files}`.
3. Reset the slot's log capture (§13.1).
4. Send `run {id, ctx, analysisConfig, taskConfig}` with ctx `{scanId, analysisId, seq, round, attempt,
   executionId, deadlineMs, tmpDir: "/tmp/scantor/x-<executionId>/tmp", filesDir:
   "/tmp/scantor/x-<executionId>/files"}` ([protocol](protocol.md) §5.1, §5.5). The analysis config is
   passed as received; the connector parses it with the native model and is the authoritative validator.
5. Add the slot to `busy[]`.

### 8.4 During the run

The connector may send these calls while `run` is in flight (exact messages in [protocol](protocol.md)):

| Call | Runtime behaviour |
|---|---|
| `log` (`ctx.log(level, message, fields)`) | appended to the analysis log capture as one line `[<level>] <message>` followed by ` key=value` per field, on the stderr stream (§13.1) |
| `progress` | stored as `busy[].progress` (last value wins) |
| `file` (`ctx.files.put`) | see below |

`file` registration. The connector has written the content to a path inside `filesDir` (for `put(name,
data)` it writes the data; for `put(name, path)` it copies the file there) and sends `file {id, parent, name,
path, contentType}`. The runtime:

1. Requires `path` to resolve inside this execution's `filesDir` (opened with `O_NOFOLLOW`; must be a regular
   file). Otherwise the call fails with a `validation` error.
2. Requires `name` to be 1–255 characters without NUL, `/` or `\`, and unique within the execution.
3. Enforces `uploads.maxFilesPerAnalysis` and `uploads.maxFileBytes`.
4. Computes `size` and `sha256` while reading the file once.
5. Generates `fileId` (uuid v4) and answers with `fileRef {id, fileRef: {id: fileId, name, size, sha256,
   contentType}}` (`contentType` null becomes `application/octet-stream`).

Violations are answered with `error` (type `validation`); the connector raises it in user code. If
user code does not handle it, the attempt fails with that `validation` error (non-retryable). Uploads happen
only after the run succeeded (§8.8), so files of failed attempts are never uploaded.

### 8.5 Timeout enforcement

The deadline timer (monotonic, armed at dispatch, §8.3) fires after `settings.timeoutMs`. The runtime
never sends `cancel` for a deadline ([protocol](protocol.md) §5.9). When it fires while `run` is still in flight:

1. `kill(-pgid, SIGKILL)` on the connector's process group (no grace: user code had `ctx.deadline` and
   `ctx.signal`, and the connector's own deadline timer at `deadlineMs`, to stop early).
2. Outcome: `ScantorError{type: "timeout", retryable: true, phase: "run", message: "run exceeded <timeoutMs>
   ms"}`.
3. The process is recycled (§7.3).

### 8.6 Outcome classification

| What happened | Outcome |
|---|---|
| `result` reply | candidate success → checks (§8.7) |
| `error` reply with type `taskError`, `fatal`, `retry` or `validation` | that type; `retryable` set by the runtime from the type (§9.2); `retry` may carry `delayMs` |
| `error` reply with type `cancelled` after the runtime sent `cancel` for this request (the v1 runtime sends `cancel` only while shutting down: `drain` in §14.1, `stop` in §14.2) | `cancelled`: not retried and not an attempt; nothing is published; after `cancel{drain}` the delivery is given back with `basic.nack(requeue=true)` (uncounted), after `cancel{stop}` it is neither acked nor nacked (it returns or is dropped with the queue) |
| `error` reply with type `cancelled` without a preceding `cancel`, arriving at most 1 s before the deadline timer or later (the connector's deadline timer fired first) | `timeout` (§8.5); the process group is killed |
| `error` reply with any other type, or `cancelled` earlier than that | treated as `taskError` (connectors cannot claim `timeout`, `crash` or `platform`) |
| process exited or was killed (not by the runtime) | `crash`, `retryable: true`, `details: {exitCode, signal, oomKilled}` |
| invalid JSON on fd 4, a message that fails its schema, a reply to an unknown request id, or a second reply ([protocol](protocol.md) §7.3) | `crash` with `details: {protocolError}`; process recycled |
| deadline | `timeout` (§8.5) |

`oomKilled` is true when the process died of `SIGKILL` that the runtime did not send and the `oom_kill` counter
in `/sys/fs/cgroup/memory.events` increased during the execution (best effort; false when the file is not
readable).

The phase of an outcome is `run`, except `validation` errors, which use phase `validate`.

### 8.7 Result checks

The runtime does not validate results against the Result schema (the connector already did). It checks:

1. The `result` value is a JSON object.
2. Its compact serialization is at most `limits.maxResultBytes`. Otherwise the outcome becomes
   `ScantorError{type: "validation", retryable: false, phase: "validate", message: "result is <n> bytes;
   the maximum is <max>; store large data with ctx.files.put"}`.

The size of the whole result message is checked when it is built (§8.9).

### 8.8 File uploads

Only for a successful outcome with at least one registered file:

1. `POST /api/runtime/uploads/presign {seq, round, attempt, executionId, files: [{fileId, name, size,
   sha256, contentType}]}` — one call for all files of the execution ([api](api.md) §8.3). The orchestrator
   takes the scan from the worker token, validates each `fileId`, checks the quota and generates the keys
   `files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`.
2. Apply the transport rule (§4.2) to each URL, then `PUT` each file with exactly the returned headers
   (`Content-Type`, `Content-Length`), at most 4 in parallel per execution, each with timeout
   `uploads.timeoutMs`. A `PUT` is retried on network errors and 5xx (1 s → 30 s) within the holding budget;
   an expired URL triggers one new presign call for the remaining files.
3. The result message lists the FileRefs (without keys); the ingestor derives the keys
   ([queue](queue.md) §6.5).

| Failure | Classification |
|---|---|
| network error, timeout, 5xx, 429 from presign or PUT | transient platform error: retry within the holding budget; when the budget is exhausted, give the delivery back (§8.10) and make the worker unhealthy (§12). Nothing is recorded on the analysis. |
| presign 400 `validationFailed` | `validation` (phase `upload`, non-retryable), message from the response |
| presign 403 `quotaExceeded` | `platform` (phase `upload`, `retryable: false`): "storage quota exceeded" — recorded so the user sees it; retry-failed after freeing storage |
| PUT 4xx (signature, policy) or a URL refused by the transport rule | `platform` (phase `upload`, `retryable: false`) |

### 8.9 Publish and ack

The outcome (after §8.7 and §8.8) leads to exactly one of three publish plans. Messages are defined in
[queue](queue.md) §5; all go through the shared publisher (§6.3) with `mandatory`, confirms and
`user_id = amqp.username`.

| Plan | When | Publishes (all must be confirmed) | Then |
|---|---|---|---|
| **succeeded** | success | result `{kind: "result", status: "succeeded", result, files, logTail ≤ logTailBytes}` to `scantor.results` | ack |
| **retry** | retryable error and `attempt < settings.maxAttempts` | (1) attempt event `{kind: "attempt", error, logTail ≤ logTailEarlierBytes}` to `scantor.results`; (2) the analysis message with `attempt + 1` (same `seq`, `round`, `config`, `scheduledAt`) to `scantor.analyses`, header `x-opt-delivery-time` (§10.2) | ack |
| **failed** | non-retryable error, or retryable with `attempt == settings.maxAttempts` | result `{kind: "result", status: "failed", error, files: [], logTail ≤ logTailBytes}` to `scantor.results` | ack |

Building the result message: if its serialized size exceeds `limits.maxResultMessageBytes`, the runtime first
shortens `logTail` (keeping the end), then error `details`, then `stack`; if it is still too large, the plan
becomes **failed** with `validation` "result message exceeds <max> bytes".

Publish outcomes:

| Outcome | Results / attempt events (`scantor.results`) | Retry republish (`scantor.analyses`) |
|---|---|---|
| confirmed | done | done |
| nacked | transient platform error: retry with 1 s → 30 s backoff within the holding budget | the scan queue is full (`reject-publish` refuses future-dated messages too, [queue](queue.md) §3.3): **backpressure**, not a platform error; hold the delivery (§8.11) |
| returned (unroutable) | the ingest binding is missing: transient platform error (the orchestrator re-ensures it at boot) | the scan queue is gone (cancelled or terminal): drop the plan, do not ack, poll state now |
| unconfirmed | republish (duplicates are absorbed) | republish |

Ack: when every publish of the plan is confirmed, `basic.ack(deliveryTag, multiple=false)` on the slot
channel — unless the delivery is detached (§6.4, §6.6), in which case nothing is acked. A failing ack (channel
closed) is logged; the message will be redelivered and the duplicate execution deduplicated.

Then: delete `/tmp/scantor/x-<executionId>`, update counters, remove the slot from `busy[]`, recycle if due
(§7.3), otherwise wait for the next delivery.

### 8.10 Holding budget

A delivery may stay unacked at most until the queue's consumer timeout
(`amqp.consumerTimeoutMs = settings.timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 5 min`, [queue](queue.md) §3.3).
The **holding budget** of a delivery is `consumerTimeoutMs − (now − deliveredAt) − 60 s`.

- The run itself is bounded by `timeoutMs` and each upload by `uploads.timeoutMs`, so a healthy runtime always
  finishes with at least about 4 minutes of budget left.
- Every platform retry while holding the delivery (presign, PUT, publish, waiting for unblock or reconnect) is
  capped by the remaining budget.
- When the budget is exhausted before the plan is confirmed, the runtime gives the delivery back with
  `basic.nack(requeue=true)` (not counted toward the delivery limit), discards the outcome, and makes the
  worker unhealthy (§12). The analysis will run again elsewhere. A retry that the full scan queue refused is
  the exception (§8.11).

### 8.11 Refused retries

A full scan queue nacks the retry republish of the retry plan (§8.9) although it is future-dated
([queue](queue.md) §3.3), and it accepts publishes again only once it is down to 80 % of its limit. The
attempt event is already confirmed at that point. A refused retry is backpressure: the analysis must neither be
lost nor fail, and the worker stays healthy (it is not a transient platform failure, §12, and raises no
`workerErrors`). The slot keeps the delivery and:

1. Republishes the retry every 500 ms ± 20 % (uniform), never later than its delivery time `due` (§10.2),
   with `x-opt-delivery-time = max(due, serverNow() + 1000)`. A confirmed republish ends the plan as usual
   (ack); a returned one drops it as in §8.9.
2. When `due` has passed and the queue still refuses, the slot runs attempt `n + 1` **on the held delivery**,
   provided the remaining holding budget (§8.10) covers a whole attempt (`settings.timeoutMs +
   uploads.timeoutMs`). A process that must be recycled (§7.3) is replaced first, within the budget. The
   attempt is an ordinary execution: its outcome takes a publish plan of §8.9, so a further retry can be held
   again, and the final result acks the original delivery. The backoff is honoured because the attempt starts
   only after `due`.
3. Otherwise the slot keeps republishing until the budget ends, then gives the delivery back with
   `basic.nack(requeue=true)` (uncounted, §12). The broker redelivers it at the head of the queue, so the same
   attempt `n` runs again (its attempt event is a duplicate the ingestor ignores).
4. A draining worker runs no further attempt: a refused retry is given back at once. A stopping worker settles
   nothing (§14.2). A detached delivery (§6.4, §6.6) ends the hold too: the broker already returned it, so it
   runs again elsewhere.

While a slot holds a refused retry, `busy[]` keeps reporting the failed attempt, so stall detection
([queue](queue.md) §9) does not consider the analysis gone.

## 9. Unified error model

### 9.1 ScantorError

Every failure anywhere in the runtime, connectors or ingestor is represented as one `ScantorError`
([data model](data-model.md) §4.6):

```json
{
  "type": "timeout",
  "message": "run exceeded 30000 ms",
  "retryable": true,
  "phase": "run",
  "attempt": 1,
  "stack": null,
  "details": null,
  "at": 1761040890000
}
```

In AMQP bodies `at` is epoch milliseconds; MongoDB stores a Date; the REST API (including the runtime's
requests to `/api/runtime/*`) and local-mode events use ISO 8601. The runtime
sets `type`, `retryable`, `phase`, `attempt` and `at`; connectors supply only `type` (one of the five they
may use: `taskError`, `fatal`, `retry`, `validation`, `cancelled`), `message`, `stack`, `details` and, for `retry`, `delayMs`.

### 9.2 Types

| Type | Produced by | `retryable` | Meaning |
|---|---|---|---|
| `taskError` | connector (any uncaught exception in user code) | true | ordinary failure of user code |
| `fatal` | connector (`Fatal(msg)`) | false | user code says retrying is pointless |
| `retry` | connector (`Retry(msg, delay?)`) | true | user code asks for a retry, optionally after `delayMs` |
| `timeout` | runtime (deadline, §8.5; schedule item timeout, §11.9) | true | |
| `crash` | runtime (process exit, signal, OOM, protocol violation); dead-letter consumer (delivery limit) | true (runtime) / false (dead-lettered) | |
| `validation` | connector (config or result rejected by the native model); runtime (sizes, malformed messages, file limits, non-deterministic schedule, `maxAnalysesPerScan`) | false | input or output is invalid; retrying cannot help |
| `platform` | runtime (uploads, publishing, bootstrap, worker health); ingestor (phase `ingest`); reconciler (`lost`) | see §9.4 | infrastructure, not user code |
| `cancelled` | connector (reply to a `cancel` the runtime sent, §8.6); runtime (local mode: total timeout or interrupt) | false | the analysis was aborted; not retried and not an attempt; never published for scans (aborted scan work is given back or dropped with the queue) |

### 9.3 Phases

| Phase | Where |
|---|---|
| `bootstrap` | worker startup: bootstrap call, transport check, inner `dockerd` (§4.4), AMQP connect, connector spawn and handshake, protocol version |
| `schedule` | scheduler: connector `schedule` stream, native template, resolution, publish-side validation of items |
| `run` | the `run` call: user-code errors, timeouts, crashes |
| `validate` | `validation` errors during a run (connector model rejection, result size, malformed message, file limits) |
| `upload` | presign and PUT |
| `publish` | publishing results, attempt events and republishes |
| `platform` | other worker-level conditions (disk space, unhealthy state, state poll) and the reconciler's `lost` gap fill |
| `ingest` | ingestor-side failures ([queue](queue.md) §6.6) |

### 9.4 What each error leads to

| Error | Runner | Scheduler |
|---|---|---|
| `taskError`, `retry`, `timeout`, `crash` with attempts left | attempt event + delayed republish + ack (an attempt) | in-process restart of the schedule with backoff (§11.9) |
| the same with attempts exhausted | failed result + ack | — |
| `fatal`, `validation` | failed result + ack | `scheduler/done` with `outcome: "failed"` |
| transient `platform` (network, 5xx, 429, blocked, unconfirmed publish, disk low, spawn failures) | **not an attempt**: hold within the budget, then nack with requeue; worker becomes unhealthy (§12) | retried in place; reported through `POST /api/runtime/errors` |
| deterministic `platform` (`quotaExceeded`, upload 4xx, refused URL) | failed result (`retryable: false`) + ack | `scheduler/done` failed |
| `cancelled` | never published; after `cancel{drain}` the delivery is given back with `basic.nack(requeue=true)` (uncounted); after `cancel{stop}` it is neither acked nor nacked (§8.6, §14.2) | never published |

`retryable` on a final failed result keeps the type's value: a `taskError` that exhausted its attempts is
stored with `retryable: true` and the attempt number equal to `maxAttempts`.

### 9.5 Bounds and truncation

| Field | Bound | Truncation |
|---|---|---|
| `message` | 4 KiB UTF-8 | cut at a rune boundary, suffix `…` |
| `stack` | 16 KiB | keep the first 8 KiB and the last 8 KiB, joined by `\n…[<n> bytes truncated]…\n` (Python puts the error last, JavaScript and Go first) |
| `details` | 4 KiB as compact JSON | replaced by `{"truncated": true}` |

## 10. Retry policy

### 10.1 Backoff

From `scan.settings` (immutable while the scan exists):

- After failed attempt `n` (1-based): `delay = min(backoff.maxMs, backoff.initialMs × backoff.factor^(n−1))`.
- With `backoff.jitter`, `delay` is drawn uniformly from `[delay/2, delay]`.
- For a `retry` error with `delayMs`, `delay = clamp(delayMs, 1000, backoff.maxMs)` without jitter.

### 10.2 Delivery time

The retry republish carries the AMQP header `x-opt-delivery-time` as an AMQP long (int64, epoch ms), which
RabbitMQ 4.4 quorum queues honour by keeping the message invisible until then ([queue](queue.md) §10):

```
deliveryTime = clamp(serverNow() + delay, serverNow() + 1000, serverNow() + backoff.maxMs)
```

The floor of 1 s keeps jitter from producing sub-second delays. A future-dated publish is **not** exempt from
`reject-publish`: a full scan queue refuses it ([queue](queue.md) §3.3), which §8.11 handles. Because
`serverNow()` is the corrected clock (§5.2), node clock skew neither hides retries nor turns backoff into a
storm.

### 10.3 Attempt events

Each retry first publishes an attempt event, so the analysis shows status `retrying` with its attempt
history while it waits ([queue](queue.md) §5.4). The ingestor applies it with a guarded upsert that ignores
duplicates and stale attempts. Message bodies never carry attempt history; each attempt is recorded once, by
its own event or by the final result.

### 10.4 What is not an attempt

- A redelivery after container death, connection loss or consumer timeout (§8.2).
- A give-back after an exhausted holding budget, a drain, an unhealthy worker or a refused retry (nack with
  requeue, §8.11).
- An analysis that ended `cancelled` after a `cancel` (§8.6), which is given back or dropped with the queue.
- A skipped redelivery whose analysis is already final.

## 11. Scheduler

The scheduler worker turns the scan config into the stream of analysis messages. Exactly one scheduler with
the current epoch exists while `scheduling.state ∈ {pending, running}`.

### 11.1 Native template vs connector schedule

| `revision.schedule` | Item source | Connector processes |
|---|---|---|
| `{kind: "template", template: <name>}` (unwrapped template, or schedule omitted = `single`) | `internal/templates/<name>` in the runtime, natively | none |
| `{kind: "custom"}` | `schedule {id, ctx, scanConfig, taskConfig}` request to one connector process; the connector streams `analysis` items and ends with `done {count}` or `error` ([protocol](protocol.md) §5.4) | 1 |

The `schedule` ctx is `{scanId, analysisId: null, seq: null, round: null, attempt, executionId: null,
deadlineMs: null, tmpDir: "/tmp/scantor/x-schedule-<attempt>/tmp", filesDir: null}` with `attempt` = the
scheduler start count: bootstrap `scheduler.restarts` + 1, plus 1 for every in-process restart (§11.9).
`scanConfig` is the effective scan config (not the resolved one; templates resolve their own inputs).

Inside a custom schedule, user code may call a wrapped template. The connector sends a `template` request
with an initial credit; the runtime runs the native template and streams `templateItem` messages back with
credit-based flow control (it never sends more items than the initial credit plus all `templateCredit`
grants), resolving it like an unwrapped template (§11.2) with the key `call:<n>`, where `n` is the 0-based
index of the template call within this schedule request. `templateCancel` stops the stream and is answered
with `templateDone {count}`. Exact messages are in [protocol](protocol.md) §5.8 and §6.2; template behaviour
in [templates](templates.md).

Item flow control: the runtime pulls the next item (native iterator `Next()`, or the next `analysis` line
from fd 4 of the connector) only while the publish window has room (§11.4), so a slow broker slows the
generator instead of filling memory. For a custom schedule this is plain pipe backpressure: while the runtime
does not read fd 4, the connector's writes block ([protocol](protocol.md) §6.1).

### 11.2 Resolution and provenance

Templates with non-deterministic inputs (`latest` Tranco list, latest CrUX month, list files) resolve them to
concrete values **before the first item is published** ([templates](templates.md)):

1. If bootstrap `scheduler.resolved[key]` exists, use it and skip resolution (resume always uses the stored
   resolution).
2. Otherwise run the template's resolve step with `scheduler.dataSources` (from `SCANTOR_TRANCO_URL`,
   `SCANTOR_CRUX_URL`) and `scheduler.uploads` (presigned GETs of referenced uploads, verified against their
   `sha256`), producing `{template, scanConfig (resolved), provenance, expectedTotal}`.
3. `POST /api/runtime/scheduler/resolved {epoch, key, template, scanConfig, provenance, expectedTotal}`. If the
   response has `stored: false`, another scheduler epoch resolved first: use the returned `resolution`.
4. Generate items from the resolved scan config only.

A stored resolution (step 1, or the `stored: false` answer of step 3) whose `template` differs from the
template the schedule calls under the same key fails scheduling with a non-retryable `validation` error
`schedule() is not deterministic: template call <key> used template <a> before and <b> now`.

Data-source downloads follow the HTTP policy of [templates](templates.md) §7.2 (10 s to connect, 10 minutes
per request, 3 tries, size caps); their errors are classified as in [templates](templates.md) §8 (network
and upstream failures are retryable `platform` errors in phase `schedule`, §11.9; unavailable inputs and
exceeded size caps are non-retryable).

### 11.3 Resume and `tailHash`

Bootstrap `scheduler.checkpoint = {confirmed: N, tailHash}`.

- `N = 0`: start at seq 0.
- `N > 0`: regenerate the stream from the beginning, discarding items `0 … N−2` without publishing; compute
  the hash of item `N−1` and compare it with `tailHash`. A mismatch, or a stream that ends before item `N−1`,
  fails scheduling with `ScantorError{type: "validation", retryable: false, phase: "schedule", message:
  "schedule() is not deterministic: item <N−1> hash mismatch on resume"}` (or "… produced only <k> items on
  resume"). Then continue publishing from seq `N`.

Item hash: `"sha256:" + hex(SHA-256(JCS(config)))`, where JCS is the JSON Canonicalization Scheme (RFC 8785:
object keys sorted by UTF-16 code units, no insignificant whitespace, ECMAScript number formatting). The hash is
computed by the runtime from the item as received, so it is independent of connector serialization details
and stable across runtime versions. Determinism requirements for user schedules (stored effective configs,
`PYTHONHASHSEED=0`, no live inputs) are documented for task authors in [tasks](tasks.md) and `docs/guide/`.

### 11.4 Publishing with confirms

For each item at position `seq`:

1. Check `seq < limits.maxAnalysesPerScan` and `size(config) ≤ limits.maxAnalysisConfigBytes` (§11.6).
2. Build the analysis message `{v: 1, analysisId: "<scanId>-<seq>", scanId, seq, round: scan.round, attempt: 1,
   config, scheduledAt: serverNow()}` and remember `(seq, hash, body)` in the **window**.
3. Publish to `analysesExchange` with routing key `<scanId>` (§6.3).

The window holds at most 512 unconfirmed or nacked items and at most 8 MiB of bodies; when full, the scheduler
stops pulling items. Confirm outcomes per seq:

| Outcome | Meaning | Action |
|---|---|---|
| confirmed | the item is in the queue | mark confirmed; advance the prefix (§11.5); drop the body |
| nacked | the scan queue is full (`x-max-length`, `x-overflow=reject-publish`): **backpressure** | mark nacked; enter backpressure: wait `intervals.backpressureWaitMs` ± 20 % (uniform), then republish **only the nacked seqs** in seq order; repeat until confirmed. No new items are pulled while any seq is nacked. |
| returned | no queue bound: the scan was cancelled or became terminal | stop publishing; poll state; exit 0 on `stop`/`drain` |
| unconfirmed | channel or connection lost | republish after reconnect (duplicates are harmless) |

Backpressure is not an error and not a restart; `scheduler.backpressure` in state polls is true while
waiting. Republished seqs may arrive in the queue out of order; analyses are independent.

### 11.5 Contiguous confirmed prefix and checkpoints

`confirmed` is the length of the longest prefix `0 … confirmed−1` whose seqs are all confirmed (on resume it
starts at `N`). `tailHash` is the hash of item `confirmed−1` (null when `confirmed = 0`). Confirms arrive out of
order across backpressure, so the prefix only advances past a seq once it is confirmed.

Checkpoints: `POST /api/runtime/scheduler/checkpoint {epoch, confirmed, tailHash}` whenever the prefix has grown
and either `intervals.checkpointMs` elapsed or `intervals.checkpointItems` items were confirmed since the last
checkpoint. Failures are retried at the next interval; publishing continues meanwhile (an older checkpoint
only means more duplicate items after a crash). The orchestrator stores it with `$max` semantics and an epoch
guard ([data model](data-model.md) §7).

### 11.6 Limits

| Limit | Error (non-retryable, phase `schedule`) |
|---|---|
| item `seq ≥ limits.maxAnalysesPerScan` | `validation`: "schedule() produced more than <max> analyses (SCANTOR_MAX_ANALYSES_PER_SCAN)" |
| item config larger than `limits.maxAnalysisConfigBytes` | `validation`: "analysis config <seq> is <n> bytes; the maximum is <max>" |
| item is not a JSON object | `validation`: "analysis config <seq> is not an object" |

Items before the failing one stay published and are executed; the scan ends `failed` once they are final
([data model](data-model.md) §6.1).

### 11.7 Done

When the stream ends and the window is empty (all items confirmed):

`POST /api/runtime/scheduler/done {epoch, outcome: "done", confirmed, tailHash}`, retried until it succeeds or
returns 409. On a non-retryable scheduling error the runtime first waits for outstanding confirms (bounded
by 60 s), then sends `{epoch, outcome: "failed", confirmed, tailHash, error}`. After a successful `done` the
runtime exits 0; the orchestrator removes the scheduler from the desired set.

### 11.8 Epoch fencing

Each scheduler worker gets a scan epoch at creation (`worker.epoch`); a replacement gets `epoch + 1`. Every
scheduler call carries the epoch; the orchestrator answers 409 `staleEpoch` for an old one. On 409 the runtime
stops pulling and publishing at once, does not call `done`, closes its connection and exits 0. A stale
scheduler may still publish a few items before it learns of the new epoch; they are duplicates of seqs the new
scheduler also publishes, and the ingestor deduplicates them. A scheduler whose worker was marked `lost` is
additionally fenced by 401 on every call.

### 11.9 Errors and restarts

| Failure | Behaviour |
|---|---|
| retryable (`taskError`, `retry`, `timeout`, `crash`, data-source `platform`) | report `POST /api/runtime/errors` (phase `schedule`, `fatal: false`), which increments `scheduling.restarts` and raises the scan condition `schedulerRestarting` until a state poll reports the restarted schedule running (`processes.busy: 1`, §5.1) (these restart reports are exempt from the per-(type, phase) rate limit of §4.3, because the orchestrator counts restarts from them; the restart backoff paces them); wait `min(backoff.maxMs, backoff.initialMs × factor^(restarts−1))` from the scan settings; recycle the connector process; resume in-process from the runtime's own current `confirmed`/`tailHash` (§11.3). When `restarts` exceeds `SCANTOR_SCHEDULER_MAX_RESTARTS`, the orchestrator fails scheduling and the next state poll returns `stop`. |
| non-retryable (`fatal`, `validation`, deterministic `platform`) | `done` with `outcome: "failed"` (§11.7), exit 0 |
| item timeout | no `analysis`, `templateCredit` or `done` message from the connector for `settings.timeoutMs` while the runtime is pulling ([protocol](protocol.md) §6.2): `timeout`, retryable |
| container death | the node daemon restarts the container; the runtime bootstraps again and resumes from the stored checkpoint |

Connection loss, blocked connections and backpressure are not scheduler errors; the generator simply pauses.

### 11.10 Scheduler state polls and drain

The scheduler polls state like a runner, with `busy: []` and the `scheduler` counters. `drain` (pause,
scale-in of the scheduler, scan terminal): stop pulling; send `cancel {id: <schedule id>, reason: "drain"}`
to a connector with a `schedule` request in flight and discard every item it still writes (the next scheduler
regenerates them; a `cancelled` reply is not an error); wait for outstanding confirms up to
`intervals.drainGraceMs`; send a final checkpoint; shut down or kill the connector process; exit 0 without
`done`. `stop`: as §14.2. A resumed scan gets a new scheduler with `epoch + 1` that resumes from the
checkpoint.

## 12. Platform errors and the unhealthy state

Transient platform errors are worker problems, not analysis problems: they never consume attempts and never
reach the delivery limit through the runtime.

The worker becomes **unhealthy** when any of these holds:

- a holding budget was exhausted (§8.10);
- 3 transient platform failures (presign, PUT, publish) within 60 s, across all slots (a retry republish
  refused by the full scan queue is backpressure and never counts, §8.11);
- 3 consecutive connector spawn failures (§7.5);
- free space under `/tmp/scantor` below `limits.minFreeTmpBytes`.

While unhealthy:

1. Every slot cancels its consumer; slots with a running analysis finish it and try to publish within its
   budget, otherwise give it back with `basic.nack(requeue=true)`.
2. Report `POST /api/runtime/errors {fatal: false, error: {type: "platform", phase: "platform" | "upload" |
   "publish" | "bootstrap", …}, context}` (scan condition `workerErrors`).
3. Back off 5 s, 10 s, 20 s … 5 min (×2, full jitter), then probe: a successful state poll, an open AMQP
   connection, a ready connector process per slot and enough free space. On success, slots re-consume; on
   failure, back off again.

The runtime **never uses `basic.reject`**. Reject increments the delivery count, so a broken worker that
rejects would dead-letter every message of the scan within seconds; giving work back is always
`basic.nack(requeue=true)`, which the broker does not count. The delivery limit therefore only ever fires for
messages whose processing repeatedly killed whole containers.

The runtime keeps working when the orchestrator is unreachable: AMQP does not depend on it, state polls keep
the last known state, and uploads (which need presign) count as transient failures. Only an explicit `stop`,
a 401, or the deletion of the per-scan RabbitMQ user stops it.

## 13. Logs

### 13.1 Per-analysis log tails

- While an analysis runs, the runtime captures the connector process's stdout and stderr and the `log` calls
  (§8.4) into one ring buffer that keeps the **last** `limits.logTailBytes` bytes (32 KiB).
- Output a process writes while no analysis is running (startup, between analyses) is not attributed to any
  analysis; it only goes to the runtime log.
- The tail sent with a final result is at most `limits.logTailBytes`; with an attempt event at most
  `limits.logTailEarlierBytes` (4 KiB, the end of the buffer). Truncation keeps the end and cuts at a UTF-8
  rune boundary; a truncated tail starts with `…[<n> bytes truncated]\n`.
- Tails are stored as text; ANSI escape sequences are kept and rendered safely by the UI ([ui](ui.md)).
- Attribution is exact because a process runs one analysis at a time; documented logging is `ctx.log`,
  which stays correct if per-process multiplexing is added later.

### 13.2 Runtime logs

The runtime writes JSON lines to **stderr** (Go `log/slog` JSON handler), which the node's Docker `local` log
driver rotates ([nodes](nodes.md)) and `getWorkerLogs` tails:

```json
{"time":"2026-10-21T10:01:37.201Z","level":"INFO","msg":"analysis finished","component":"runtime","version":"1.4.0","role":"runner","scanId":"5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f","workerId":"9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","nodeId":"2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a","slot":1,"pid":431,"analysisId":"5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234","seq":1234,"round":1,"attempt":2,"executionId":"b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e","outcome":"succeeded","durationMs":1200}
```

| Rule | |
|---|---|
| Correlation fields | `scanId`, `workerId`, `nodeId`, `role` on every line; `analysisId`, `seq`, `round`, `attempt`, `executionId`, `slot`, `pid` on lines about an analysis; the same names are used by the orchestrator and the node daemon |
| Levels | `DEBUG` (off), `INFO` (lifecycle: bootstrap, consume, resize, recycle, analysis finished, drain), `WARN` (transient platform errors, skew, slow confirms), `ERROR` (unhealthy, consumer timeout hit, malformed messages, fatal) |
| Connector output | stdout/stderr lines are mirrored as `{"msg":"connector output","stream":"stdout"\|"stderr","line":"…"}` with the analysis fields (output of the inner `dockerd`, §4.4, as `{"msg":"dockerd output","stream":"dockerd","line":"…"}`), each line ≤ 16 KiB, at most 64 KiB/s per worker in total (excess dropped; a `WARN` line reports the dropped count once per minute) |
| Secrets | the worker token, AMQP password, presigned URL query strings and config values are never logged |

## 14. Shutdown

### 14.1 SIGTERM and `drain`

The node daemon stops a container with `ContainerStop(timeout = drainGraceMs + 5 s)`; docker-init forwards
SIGTERM to the runtime. The `drain` action starts the same sequence without a signal.

1. Stop taking work: every slot cancels its consumer; the scheduler stops pulling items.
2. Running analyses continue; each one that finishes within `intervals.drainGraceMs − 1 s` (measured from the
   start of the drain) publishes and acks normally.
3. At `intervals.drainGraceMs − 1 s − cancelGraceMs` (5 s; at once when that is not positive): send
   `cancel {id: <run id>, reason: "drain"}` to
   every process still running an analysis (besides `cancel{stop}` in §14.2, the only `cancel` the v1
   runtime sends, [protocol](protocol.md) §5.9). A `cancelled` reply ends the analysis without publishing anything and its delivery is given back at
   once with `basic.nack(requeue=true)` (uncounted, §8.6); a normal reply that arrives before the grace
   deadline is handled as usual. Cancelled processes are not reused.
4. At the grace deadline (`drainGraceMs − 1 s`): kill the remaining process groups and give their deliveries
   back with `basic.nack(requeue=true)` (uncounted). The scheduler sends a final checkpoint.
5. Within at most 5 s in total (the margin of the node's stop timeout): shut down idle connector processes
   (`shutdown`, then kill), close slot channels, wait for outstanding confirms on the publisher, close the
   connection, report the final state poll (best effort), stop the inner `dockerd` if one runs (§4.4), exit
   0.

A second SIGTERM or a SIGINT skips to step 4. Docker sends SIGKILL 5 s after the grace if the runtime is
still alive.

SIGTERM or SIGINT before the role has started (bootstrap retries, the inner `dockerd`, the AMQP connect,
the connector start) ends the worker at once with exit 0, without a report: nothing was taken from the
queue yet.

### 14.2 `stop`

Used for cancelled or terminal scans and lost workers: stop consuming and pulling, send `cancel {id,
reason: "stop"}` to every process with a request in flight (`run` or `schedule`) and kill every process group
as soon as all of them have replied, at the latest after `cancelGraceMs` (5 s), so user code gets a short
chance to release external resources. Publish nothing, do not ack or nack (closing the connection returns or
drops the deliveries; for cancelled scans the queue is already deleted), close the connection, stop the
inner `dockerd` if one runs, exit 0.

### 14.3 Exit codes (worker mode)

| Code | Meaning |
|---|---|
| 0 | the runtime decided to stop: drain/stop finished, 401, scan not running at bootstrap, stale epoch, scheduler done, persistent `ACCESS_REFUSED` |
| 1 | fatal: invalid environment, refused transport, 426 incompatible version, connector never started (§7.5), unsupported protocol, inner `dockerd` missing, not ready within 60 s or exited (§4.4) |
| other | crash of the runtime itself (Go panic exits 2) |

The node daemon restarts a container only while its worker is still in the desired set, with crash-loop
backoff for non-zero exits ([nodes](nodes.md)).

## 15. Local mode

Local mode runs a task without queue or platform: `schedule` (limited) and then `run`, in one container. It
backs `scantor dev run`, `scantor dev debug` and platform test runs ([architecture](architecture.md) §11.1).

### 15.1 Invocation and spec

`/scantor/scantor runtime local --spec /scantor/in/spec.json`. The consumer writes the spec with the injection
tar (§3.1). Configs in the spec are already effective (validated with defaults by the consumer: ajv in the
`testRun` job, the CLI's validator for `dev run`).

```json
{
  "v": 1,
  "runId": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
  "entry": "main.py",
  "taskConfig": { "greeting": "Hi" },
  "scanConfig": {},
  "analysisConfig": null,
  "limit": 5,
  "processes": 1,
  "timeoutMs": 300000,
  "maxAttempts": 1,
  "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true },
  "maxAnalysesPerProcess": 1000,
  "totalTimeoutMs": 600000,
  "debug": false,
  "dataSources": { "tranco": "https://tranco-list.eu", "crux": "https://raw.githubusercontent.com/zakird/crux-top-lists/main" },
  "uploads": { "4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b": { "path": "/scantor/in/uploads/4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b", "sha256": "2c26b46b…" } },
  "resolved": {},
  "limits": { "maxAnalysisConfigBytes": 65536, "maxResultBytes": 1048576, "maxFileBytes": 1073741824, "maxFilesPerAnalysis": 100, "logTailBytes": 32768, "logTailEarlierBytes": 4096 },
  "outDir": "/scantor/out"
}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | ✓ | 1 |
| `runId` | ✓ | used as ctx `scanId`; analysis ids are `<runId>-<seq>` (the test-run id, or `local` for the CLI); ctx `round` is always 1 and the `schedule` ctx `attempt` is 1 |
| `entry` | ✓ | substituted for `{entry}` |
| `taskConfig` | ✓ | effective task config |
| `scanConfig` / `analysisConfig` | one of them | with `analysisConfig`, `schedule` is skipped and `run` is called once with seq 0 |
| `limit` | ✓ | maximum number of items taken from the schedule stream (1–50 for test runs) |
| `processes` | – (1) | concurrent `run` calls |
| `timeoutMs`, `maxAttempts`, `backoff`, `maxAnalysesPerProcess` | ✓ | as scan settings |
| `totalTimeoutMs` | – (none) | wall-clock limit of the whole local run |
| `debug` | – (false) | §15.5 |
| `dataSources`, `uploads`, `resolved` | – | as in scheduler bootstrap; uploads are local files, which the runtime serves to templates through a loopback HTTP server inside the container (templates read uploads through URLs) |
| `limits` | ✓ | as bootstrap limits |
| `outDir` | – (`/scantor/out`) | where files and nothing else are written |

### 15.2 Behaviour

1. Spawn one connector process, perform the handshake (§7.2, `welcome.mode` `local`), then send `describe`
   to learn the schedule kind (local mode has no revision; the connector version comes from `hello`); emit
   `start`.
2. Items: with `analysisConfig`, the single item seq 0. Otherwise run the schedule exactly like the scheduler
   (native template with resolution, or the connector's `schedule`), emitting `resolved` and `scheduled`
   events, until the stream ends or `limit` items were taken; then the schedule is abandoned (the connector
   process is recycled). No item hashing or checkpointing.
3. Run the items with `processes` concurrent connector processes, using the run path of §8 without AMQP:
   timeouts, crash detection, recycling, result checks, file registration and the retry policy are identical.
   Backoff delays are capped at 2 s each so the dev loop stays fast; `retry` delays likewise.
4. Files are written to `<outDir>/files/<seq>/<fileId>/<safeName>` (same `safeName` rules as S3 keys,
   [data model](data-model.md) §9); the consumer fetches `outDir` with `CopyFromContainer` after the container
   exits. Local-mode containers must not mount a tmpfs over `/scantor/out`.
5. Emit `end` and exit with the code of §15.4.

Total timeout, SIGTERM or SIGINT: kill all process groups (no `cancel` is sent); in-flight analyses end with a
`result` event of status `failed` and error type `cancelled` (not retried); `end` has reason `timeout` or
`interrupted`.

### 15.3 Output events

stdout carries one JSON object per line (NDJSON), nothing else; the runtime's own diagnostics go to stderr.
Times are ISO 8601 UTC strings with milliseconds (this output is user-visible through `scantor dev run -o
json`); `ScantorError.at` uses the same format.

| `type` | Fields | When |
|---|---|---|
| `start` | `at, runtimeVersion, language, protocolVersion, connector {language, version}, schedule {kind, template?}, limit, processes, debugPort?` (`language` is the language the connector loaded the entry as, `hello.connector.language`; `SCANTOR_LANGUAGE` is only the fallback, because it lists every language of the image) | after `describe` |
| `resolved` | `at, key, template, scanConfig, provenance, expectedTotal` | a template resolved (key `schedule` or `call:<n>`) |
| `scheduled` | `at, seq, config` | an item was taken from the stream |
| `log` | `at, seq (or null), attempt (or null), stream: "stdout"\|"stderr", text` | each output line (≤ 16 KiB; longer lines are split); `ctx.log` lines appear on `stderr` as `[<level>] <msg>`; at most 1 MiB of `log` events per analysis, then one `[log output truncated]` line |
| `attempt` | `at, seq, attempt, error, nextAttemptAt` | a retryable failure with attempts left |
| `result` | `at, seq, status: "succeeded"\|"failed", attempt, config, result (or null), error (or null), files: [{id, name, size, sha256, contentType, path}], logTail, attempts: Attempt[], timings: {scheduledAt, startedAt, finishedAt, durationMs}` | the analysis is final; `path` is relative to `outDir` |
| `error` | `at, error` | a failure not tied to an analysis (connector start, describe, resolution, schedule) |
| `end` | `at, reason: "done"\|"limit"\|"scheduleFailed"\|"startFailed"\|"timeout"\|"interrupted", summary: {analyses, succeeded, failed}, exitCode` | last line |

Example:

```
{"type":"start","at":"2026-10-21T09:10:01.020Z","runtimeVersion":"1.4.0","language":"python","protocolVersion":1,"connector":{"language":"python","version":"1.4.0"},"schedule":{"kind":"template","template":"single"},"limit":5,"processes":1}
{"type":"scheduled","at":"2026-10-21T09:10:01.030Z","seq":0,"config":{}}
{"type":"log","at":"2026-10-21T09:10:01.035Z","seq":0,"attempt":1,"stream":"stderr","text":"[info] greeting Hi"}
{"type":"result","at":"2026-10-21T09:10:01.071Z","seq":0,"status":"succeeded","attempt":1,"config":{},"result":{"text":"Hi"},"error":null,"files":[],"logTail":"[info] greeting Hi\n","attempts":[],"timings":{"scheduledAt":"2026-10-21T09:10:01.030Z","startedAt":"2026-10-21T09:10:01.031Z","finishedAt":"2026-10-21T09:10:01.071Z","durationMs":40}}
{"type":"end","at":"2026-10-21T09:10:01.090Z","reason":"done","summary":{"analyses":1,"succeeded":1,"failed":0},"exitCode":0}
```

The `testRun` job maps these events to `testRunAnalyses` documents, the S3 log `test-runs/<id>/log.ndjson`
and the SSE events of `streamTestRun` ([api](api.md) §4.11); the CLI pretty-prints them or passes them through
with `-o json`.

### 15.4 Exit codes

Matching the CLI ([architecture](architecture.md) §4.2); the highest applicable code wins:

| Code | Condition |
|---|---|
| 3 | invalid spec, unwritable `outDir`, total timeout, interrupt, or a runtime failure |
| 2 | the connector could not start or describe, the protocol is unsupported, or an `error` event of type `validation` occurred outside an analysis (for example a scan config the connector rejects) |
| 1 | at least one analysis failed, or `schedule` failed with a non-validation error |
| 0 | everything succeeded (including zero items) |

### 15.5 Debug (`scantor dev debug`)

With `debug: true`: connector processes are started with `SCANTOR_DEBUG_CMD` instead of
`SCANTOR_CONNECTOR_CMD`; `processes` is forced to 1; the `hello` and `ready` timeouts, per-analysis timeouts
(ctx `deadlineMs` is null) and `totalTimeoutMs` are disabled (the debugger waits for attach and may pause);
the `start` event reports
`debugPort = SCANTOR_DEBUG_PORT`. Publishing the port (bound to 127.0.0.1) and Go debug builds are the CLI's
job ([development](development.md)).

## 16. Describe and check modes

Both are run by the task pipeline in a `scantor-b-*` container with the worker hardening profile, `--network
none` and a container timeout ([tasks](tasks.md)). They write task-pipeline NDJSON events to stdout:
`{"phase", "type": "log"|"error"|"result", …}` with errors as BuildError `{phase, file?, line?, column?,
message}` ([data model](data-model.md) §4.2).

**describe** (`--entry <entry>`):

1. Spawn the connector with `SCANTOR_CONNECTOR_CMD` and perform the handshake (§7.2: `hello` 30 s, protocol
   version, `ready` 120 s; `welcome.mode` `describe`).
2. Send `describe`; receive `description` (JSON Schemas of task config, scan config and analysis config in
   input mode, Result in output mode, the schedule kind and connector warnings) within 60 s.
3. Build the describe output (`schemas/describe.schema.json`) exactly as [tasks](tasks.md) §7 steps 1–6
   specify; those steps are normative. In particular: for an unwrapped template (`schedule.kind ==
   "template"`, which must exist in `internal/templates`) the scan and analysis config schemas are replaced by
   the canonical schemas of `schemas/templates/<name>.json` (step 2); every schema is normalised, with
   `default` dropped from `writeOnly` properties and the root required to be `type: object` (step 3); open
   config roots, invalid defaults and the supported subset are checked (step 4); `secretPaths`,
   `uploadPaths` and `fileRefPaths` are derived (step 5). `protocolVersion` and `connector` come from the
   handshake; the language mismatch check against the manifest is the pipeline's (step 1).
4. Emit `{"phase":"describe","type":"result","description": Description}` ([data model](data-model.md) §4.2)
   and exit 0. Connector output is emitted as `log` events; failures (the describe errors of
   [tasks](tasks.md) §7) as `error` events with exit code 2; the message of a failed start includes the
   connector's handshake `error` message and stack or the last 4 KiB of stderr (for example an import
   error).

**check** (`--entry <entry>`): run `SCANTOR_CHECK_CMD` (§3.3) in `/task` with a 300 s timeout. Each output
line is a `log` event; lines of the form `<file>:<line>[:<column>]: <message>` additionally become `error`
events. Result `{"phase":"check","type":"result","ok": <exit code == 0>, "exitCode", "skipped"}`; an empty
`SCANTOR_CHECK_CMD` gives `skipped: true, ok: true`. Exit 0 when ok, 2 otherwise.

## 17. Limits and timers

Values with an env source are configured only through that variable (documented in `.env.example`) and reach
the runtime through bootstrap or the local spec. Values without one are fixed constants of the runtime or of
the orchestrator's bootstrap response.

| Item | Value / source | Bootstrap field |
|---|---|---|
| analysis config size | `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` | `limits.maxAnalysisConfigBytes` |
| result size | `SCANTOR_MAX_RESULT_BYTES` | `limits.maxResultBytes` |
| result message size | 2 MiB (broker `max_message_size` is 4 MiB) | `limits.maxResultMessageBytes` |
| log tail final / earlier attempts | 32 KiB / 4 KiB | `limits.logTailBytes` / `limits.logTailEarlierBytes` |
| error message / stack / details | 4 KiB / 16 KiB / 4 KiB | `limits.stackBytes` (stack) |
| analyses per scan | `SCANTOR_MAX_ANALYSES_PER_SCAN` | `limits.maxAnalysesPerScan` |
| processes per worker | `SCANTOR_MAX_PROCESSES_PER_WORKER` | `limits.maxProcessesPerWorker` |
| minimum free space in `/tmp/scantor` | `SCANTOR_WORKER_MIN_FREE_TMP_BYTES` | `limits.minFreeTmpBytes` |
| file size / files per analysis | `SCANTOR_MAX_FILE_BYTES` / `SCANTOR_MAX_FILES_PER_ANALYSIS` | `uploads.maxFileBytes` / `uploads.maxFilesPerAnalysis` |
| upload (presigned URL expiry, PUT timeout) | `SCANTOR_UPLOAD_TIMEOUT` | `uploads.timeoutMs` |
| per-analysis timeout | scan setting `timeoutMs` | `scan.settings.timeoutMs` |
| consumer timeout | `timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 5 min` | `amqp.consumerTimeoutMs` |
| holding-budget safety margin | 60 s | – |
| drain grace | `SCANTOR_WORKER_DRAIN_GRACE` | `intervals.drainGraceMs` |
| state poll | 5 s ± 20 % (response `nextPollMs` overrides) | `intervals.statePollMs`, `intervals.statePollJitter` |
| checkpoint | every 5 s or 1000 confirmed items | `intervals.checkpointMs`, `intervals.checkpointItems` |
| backpressure wait | 2 s ± 20 % | `intervals.backpressureWaitMs` |
| scheduler window | 512 items / 8 MiB | – |
| scheduler restarts | `SCANTOR_SCHEDULER_MAX_RESTARTS` (enforced by the orchestrator) | – |
| data-source requests | 10 min timeout, 3 tries | – |
| AMQP heartbeat | 30 s | `amqp.heartbeatSeconds` |
| confirm wait | 30 s | – |
| AMQP reconnect backoff | 1 s → 30 s | – |
| bootstrap retry backoff | 1 s → 60 s | – |
| HTTP request timeout | 30 s bootstrap, 15 s others, 5 s status check | – |
| `hello` timeout / `ready` timeout (after `welcome`) | 30 s / 120 s | – |
| process shutdown grace / `cancel` grace (`welcome.cancelGraceMs`) | 5 s / 5 s | – |
| `describe` reply / check command | 60 s / 300 s | – |
| inner `dockerd` readiness (DinD) / its stop grace | 60 s / 3 s | – |
| spawn failures | 3 at startup → exit 1; respawn backoff 1 s → 60 s | – |
| unhealthy backoff | 5 s → 5 min | – |
| unhealthy trigger | 3 transient platform failures within 60 s | – |
| redelivered status batch | 20 ms window, ≤ 1000 seqs | – |
| clock EWMA | α = 0.2, samples with rtt > 2 s discarded | – |
| retry delivery time | ≥ server now + 1 s, ≤ server now + `backoff.maxMs` | – |
| republish of a refused retry | every 500 ms ± 20 % within the holding budget | – |
| upload parallelism | 4 PUTs per execution | – |
| wrapped template credit | 256 items | – |
| error reports | ≤ 1 per (type, phase) per 10 s | – |
| connector output mirrored to runtime log | ≤ 64 KiB/s, lines ≤ 16 KiB | – |
| local mode | backoff capped at 2 s; ≤ 1 MiB of `log` events per analysis | – |

## 18. Decisions

Made in this document (item 7 in part and items 14–16 implement lead rulings):

1. **Bootstrap fields for the runtime**: `revision.entry` (the runtime must substitute `{entry}` in
   `SCANTOR_CONNECTOR_CMD` and cannot rely on `/task/scantor.yaml` being copied into the image),
   `amqp.consumerTimeoutMs` (one formula, owned by the orchestrator), `limits.maxProcessesPerWorker` and
   `limits.minFreeTmpBytes` (variable `SCANTOR_WORKER_MIN_FREE_TMP_BYTES`) are adopted in [api](api.md) §8.1.
   `scheduler.restarts` (the scan's `scheduling.restarts`), which the `schedule` ctx `attempt` needs
   ([protocol](protocol.md) §5.1), is also adopted in [api](api.md) §8.1.
2. **Runtime-generated `fileId`**: `ctx.files.put` returns the final FileRef during `run`, but uploads happen in
   one presign batch after the run succeeded; the runtime therefore generates `fileId` (uuid v4) and the
   presign request carries it. The orchestrator still generates the whole key and validates the id.
3. **Files are uploaded only for successful runs**; failed attempts upload nothing.
4. **Transient platform errors are not attempts** and are never recorded on analyses; only deterministic
   platform rejections (`quotaExceeded`, upload 4xx, refused URLs) produce failed results.
5. **Redeliveries re-execute the same attempt** with a new `executionId`; container death is bounded by the
   queue's delivery limit, not by `maxAttempts`.
6. **Recycle before ack**: a slot cancels its consumer before acking when its process must be replaced, so no
   message is ever held during a respawn.
7. **Work root `/tmp/scantor`** (honours `TMPDIR`) on the disk-backed writable layer, with no tmpfs at `/tmp`
   in worker containers (lead ruling); per-process `TMPDIR`; per-execution directories with a `files/` area
   that the connector writes into; free space is reported for that filesystem. Local mode writes only to
   `/scantor/out` (decisions §10 calls it `/out`).
8. **Command templates are split without a shell** with the rules of §3.3.
9. **Schedule errors are retried in-process** (connector recycled, resume from the in-memory prefix); the
   orchestrator counts restarts from error reports and stops the scheduler above the limit. A schedule item
   timeout equal to `settings.timeoutMs` catches hung generators.
10. **`tailHash` uses RFC 8785 (JCS)** canonical JSON computed by the runtime.
11. **Local mode** reads a spec file injected with the binary, describes the task itself, takes items first and
    runs them afterwards, caps backoff at 2 s, and reports ctx logs on the stderr stream.
12. **Malformed analysis messages** become failed `validation` results when `seq` and `round` are usable, and are
    otherwise dropped with a worker error.
13. **`ACCESS_REFUSED` on reconnect** aborts in-flight work and exits after 60 s unless state polls say
    otherwise.
14. **Handshake** `hello` → `welcome` → `ready` as in [protocol](protocol.md) §4; spawn failures cover the
    whole handshake.
15. **`cancel` only on shutdown**: the v1 runtime sends `cancel{drain}` near the end of a drain and
    `cancel{stop}` on `stop`; a connector's `cancelled` reply becomes type `cancelled`, which is neither
    retried nor an attempt and is never published. Deadlines are enforced by killing the process group; a
    `cancelled` reply from the connector's own deadline timer counts as `timeout`.
16. **The runtime starts the inner `dockerd`** of DinD workers (`SCANTOR_DIND=1`, set by the node daemon),
    waits up to 60 s for its socket and fails the worker with a clear error when the task image lacks
    Docker.
17. **A refused retry runs on the held delivery** (§8.11): RabbitMQ 4.4 refuses future-dated publishes to a
    full queue, and the runner has nowhere else to put attempt `n + 1`. Holding the delivery and running the
    next attempt once it is due keeps slots productive, so slots that hold refused retries cannot starve the
    queue that would make room for them; giving the delivery back is the fallback when the holding budget
    cannot cover another attempt.

## 19. Future extensions

| Extension | How the design accommodates it |
|---|---|
| STS-scoped S3 credentials and multipart uploads > 5 GiB | `uploads.mode` is an enum (`presigned` today); the upload step is one package (`internal/runtime/upload`) that can switch to the SDK transfer manager with `POST /api/runtime/s3-credentials`; keys are already per scan prefix. |
| `ctx.memo` | Resolutions are already a keyed map persisted through `scheduler/resolved`; a memo is another key kind with a size cap and a new protocol call. |
| `ctx.expectTotal` | `expectedTotal` is already part of a resolution; a protocol call from custom schedules would post it the same way. |
| Per-process multiplexing | Protocol messages carry request ids and ctx is per call; `busy[]` is keyed by `executionId`; only log attribution (which relies on one analysis per process) would move entirely to `ctx.log`. |
| Cron / recurring scans | Each occurrence is an ordinary scan; nothing changes in the runtime. |
| Scan priorities | Quorum-queue message priorities could be set by the scheduler (`priority` property) without touching the run path. |
| Multi-arch task builds | The runtime is a static binary per architecture; consumers inject the one matching the node. |
| New languages | Only a base image with the ENV contract and a connector; the runtime has no language switch. |
| Per-analysis resource accounting | Process groups and cgroup files already exist; CPU time and peak memory could be added to `timings`. |
| Live log streaming for scans | The per-analysis capture is a ring buffer; it could be forwarded on demand like worker log tails. |
| DinD in test runs and `dev run` | Local mode could honour `SCANTOR_DIND=1` with the same `dockerd` start (§4.4) once consumers can run privileged local-mode containers. |
