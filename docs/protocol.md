# Connector protocol

This document specifies the connector protocol: the only interface between the language-agnostic
runtime (`scantor runtime`, [runtime](runtime.md)) and the connector processes that run user code
([tasks](tasks.md) §5). It defines the transport (file descriptors 3 and 4, NDJSON), request ids, the
version negotiation in `hello`, every message type with its fields and an example, flow control for
template streams, the error object, size limits and timeouts, the process lifecycle with signals and
process groups, and the conformance harness every connector must pass. Machine-readable schemas live in
`schemas/protocol/` (one file per message type plus `common.schema.json` and `message.schema.json`). The
runtime is injected by the platform and may be newer than the connector baked into a task image, so this
protocol is the single cross-version contract of a task revision.

## 1. Overview

```
                     container (task image + injected runtime)
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  /scantor/scantor runtime (worker | local | describe)                        │
 │     │ spawns SCANTOR_CONNECTOR_CMD per process slot (own process group)       │
 │     │                                                                         │
 │     │  fd 3  (runtime → connector)  NDJSON requests: run, schedule, …          │
 │     ├──────────────────────────────────────────►┌───────────────────────────┐ │
 │     │  fd 4  (connector → runtime)  NDJSON       │ connector process          │ │
 │     │◄──────────────────────────────────────────│  (python | node | go)      │ │
 │     │  stdout, stderr (captured as logs)         │  user code: schedule, run  │ │
 │     │◄──────────────────────────────────────────└───────────────────────────┘ │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- The runtime is always the client of user code: it sends requests (`describe`, `schedule`, `run`) and
  control messages (`cancel`, `shutdown`); the connector answers.
- During a request the connector may call back into the runtime (`file`, `template`) and emit
  fire-and-forget messages (`log`, `progress`).
- The connector is the authoritative validator of every value user code consumes or produces; the runtime
  checks only well-formed JSON, sizes, ids and message order.

## 2. Transport

| Aspect | Rule |
|---|---|
| Channels | fd 3: runtime → connector (the connector reads); fd 4: connector → runtime (the connector writes). Both are anonymous pipes created by the runtime. stdin is `/dev/null`. stdout and stderr are separate pipes captured by the runtime (§8). |
| Encoding | UTF-8. One JSON object per line, terminated by a single `\n`; no `\r`, no blank lines, no pretty printing, no BOM. JSON strings escape control characters, so a message never contains a raw newline. |
| Size | A line is at most `limits.maxLineBytes` bytes including the newline (8 MiB in protocol v1, announced in `welcome`). |
| Writing | Each side writes whole lines atomically (one writer or a mutex); interleaved partial lines are a protocol violation. |
| Reading | Receivers ignore unknown fields. The runtime treats an unknown `type` from a connector as a protocol violation (§7.3). A connector answers an unknown request `type` with `error` (type `validation`, message `unsupported request <type>`) and keeps serving. |
| Without fds | A connector started without readable fd 3 and writable fd 4 writes `scantor: this program is a scantor task connector; run it with "scantor dev run"` to stderr and exits with code 2. |
| Schemas | Every message type has a strict schema (`additionalProperties: false`) in `schemas/protocol/<type>.schema.json`; `message.schema.json` has the unions `#/$defs/connectorToRuntime` and `#/$defs/runtimeToConnector`. The conformance harness validates every line a connector writes (§12). |

## 3. Request ids and correlation

| Field | Rule |
|---|---|
| `type` | required on every message |
| `id` | required on every message except `log` and `progress`. 1–64 characters of `[A-Za-z0-9._:-]`. |
| `parent` | on connector-initiated messages (`file`, `template`, `log`, `progress`): the id of the runtime request in whose context user code made the call; `null` on `log` outside any request (for example at import time) |

- Ids of runtime-initiated requests and of connector-initiated requests are separate namespaces. A reply
  always carries the id of the request it answers; the message `type` determines the namespace. The
  handshake uses the fixed id `hello`.
- Each side chooses its ids freely and never reuses an id within a process lifetime (the reference
  runtime uses `d<n>`, `s<n>`, `r<n>`, `x<n>`; connectors use `c<n>`).
- Protocol v1 has **at most one runtime request** (`describe`, `schedule` or `run`) in flight per process;
  `cancel` and `shutdown` may arrive at any time. Within a request, the connector may have several
  `file` and `template` requests in flight concurrently (for example parallel `files.put` in async code),
  each with its own id.
- Ids and `parent` make per-process multiplexing an additive change (§14).

## 4. Handshake and version negotiation

```
runtime                                   connector
   │  spawn (fds 3/4, own process group)     │
   │◄──────── hello {protocol:{min,max}} ─────│  written before importing user code
   │── welcome {protocolVersion, limits} ────►│      (or error id "hello" → terminate)
   │                                          │  import entry, build the definition
   │◄──────────── ready ──────────────────────│      (or error id "hello", exit 1)
   │── run / schedule / describe ───────────►│
```

1. The connector writes `hello` immediately after start, before importing user code, so protocol
   incompatibilities are reported even when the entry would fail to import.
2. The runtime of protocol version **N** supports versions **N−1 and N**. It chooses
   `v = min(N, hello.protocol.max)`; if `v < max(N−1, hello.protocol.min)` there is no common version: the
   runtime sends `{"type":"error","id":"hello","error":{"type":"validation","message":"connector protocol
   1..1 is not supported by runtime 2.3.0 (protocol 3..4); publish a new revision to rebuild the task on
   a current base image"}}`, closes fd 3 and terminates the process (§11). Otherwise it sends `welcome`.
3. The connector imports the entry and validates the task definition, then writes `ready`. On failure it
   writes `error` with id `hello` (type `taskError` for an exception raised by user code at import,
   `validation` for an invalid definition), including the message and stack, and exits with code 1.
4. Only after `ready` does the runtime send requests.

Protocol version policy: any change to the message set, a field or a semantic increments the version
(current: **1**). The runtime keeps the code path of version N−1, so every task image keeps working for
at least one runtime release after a protocol change; connectors should advertise the widest range they
implement. Describe stores the negotiated version on the revision (`description.protocolVersion`).

## 5. Message catalogue

| Type | Direction | `id` refers to | Reply / outcome |
|---|---|---|---|
| `hello` | C → R | `hello` | `welcome` or `error` |
| `welcome` | R → C | `hello` | `ready` or `error` |
| `ready` | C → R | `hello` | – |
| `describe` | R → C | new runtime id | `description` or `error` |
| `description` | C → R | the describe | – |
| `schedule` | R → C | new runtime id | `analysis`* then `done`, or `error` |
| `analysis` | C → R | the schedule | – |
| `done` | C → R | the schedule | – |
| `run` | R → C | new runtime id | `result` or `error` |
| `result` | C → R | the run | – |
| `error` | both | the request it terminates | – |
| `cancel` | R → C | the in-flight request | the request ends with `error` (`cancelled`) or its normal reply |
| `shutdown` | R → C | new runtime id | process exit 0 |
| `file` | C → R | new connector id | `fileRef` or `error` |
| `fileRef` | R → C | the file request | – |
| `log` | C → R | – (`parent`) | – |
| `progress` | C → R | – (`parent`) | – |
| `template` | C → R | new connector id | `templateItem`* then `templateDone`, or `error` |
| `templateItem` | R → C | the template request | – |
| `templateCredit` | C → R | the template request | – |
| `templateCancel` | C → R | the template request | `templateDone` |
| `templateDone` | R → C | the template request | – |

### 5.1 `ctx` object

Carried by `schedule` and `run`; the connector exposes it to user code ([tasks](tasks.md) §5.2).

| Field | Type | Meaning |
|---|---|---|
| `scanId` | string | scan id; in local mode the spec's `runId` (the test-run id, or `local` for `scantor dev run`) |
| `analysisId` | string \| null | `<scanId>-<seq>`; null in `schedule` |
| `seq` | integer \| null | analysis seq; null in `schedule` |
| `round` | integer \| null | retry-failed round of the analysis (1 in local mode); null in `schedule` |
| `attempt` | integer ≥ 1 | attempt of this analysis in the current round; in `schedule` the scheduler start count (`scheduling.restarts + 1`) |
| `executionId` | string \| null | uuid of this execution (one delivery of the analysis); null in `schedule` |
| `deadlineMs` | integer \| null | epoch milliseconds (container clock) at which the call ends; null when there is none (`schedule`, `dev debug`). Connectors arm a timer at this instant that cancels user code (§10.4). |
| `tmpDir` | string | absolute path of an empty, writable directory private to this call (`/tmp/scantor/x-<executionId>/tmp`); deleted after the call |
| `filesDir` | string \| null | where the connector places file contents before registering them (`/tmp/scantor/x-<executionId>/files`); null in `schedule` |

### 5.2 Handshake messages

`hello` (C → R):

| Field | Type | Meaning |
|---|---|---|
| `id` | `"hello"` | |
| `protocol` | `{min, max}` | protocol versions the connector implements |
| `connector` | `{language, version, runtime?}` | `language` the entry is loaded as (`python`, `typescript`, `javascript`, `go`; the JS connector decides by entry extension), connector version (the scantor version the base image was built with, its `VERSION` build argument: semver `X.Y.Z` for releases; development builds report `dev`, Go `0.0.0-dev`), language runtime description |
| `pid` | integer | the connector's process id |

```json
{"type":"hello","id":"hello","protocol":{"min":1,"max":1},"connector":{"language":"python","version":"1.4.0","runtime":"cpython 3.14.0"},"pid":17}
```

`welcome` (R → C):

| Field | Type | Meaning |
|---|---|---|
| `id` | `"hello"` | |
| `protocolVersion` | integer | negotiated version |
| `mode` | `worker` \| `local` \| `describe` | runtime mode |
| `runtime` | `{version}` | runtime (scantor) version |
| `limits` | `{maxLineBytes, maxResultBytes, maxAnalysisConfigBytes, maxFileBytes, maxFilesPerAnalysis}` | §9; the connector may enforce them early for better messages |
| `cancelGraceMs` | integer | time the connector has to end a cancelled request (§10.4) |

```json
{"type":"welcome","id":"hello","protocolVersion":1,"mode":"worker","runtime":{"version":"1.4.0"},"limits":{"maxLineBytes":8388608,"maxResultBytes":1048576,"maxAnalysisConfigBytes":65536,"maxFileBytes":1073741824,"maxFilesPerAnalysis":100},"cancelGraceMs":5000}
```

`ready` (C → R): `{"type":"ready","id":"hello"}`.

Handshake failure (C → R), then exit 1:

```json
{"type":"error","id":"hello","error":{"type":"taskError","message":"ModuleNotFoundError: No module named 'httpx'","stack":"Traceback (most recent call last):\n  File \"/task/main.py\", line 1, in <module>\n    import httpx\nModuleNotFoundError: No module named 'httpx'\n"}}
```

### 5.3 Describe

`describe` (R → C): `{"type":"describe","id":"d1"}`. Sent in `describe` mode and in `local` mode (once
after the handshake, to learn the schedule kind, [runtime](runtime.md) §15.2); never in `worker` mode.
Connectors answer it in any mode.

`description` (C → R):

| Field | Type | Meaning |
|---|---|---|
| `schemas` | `{taskConfig, scanConfig, analysisConfig, result}` | raw JSON Schemas exported by the connector: configs in input mode, result in output mode ([tasks](tasks.md) §6.1) |
| `schedule` | `{kind: "custom"}` \| `{kind: "template", template}` | `template` when the task's schedule is a template proxy passed unwrapped, or omitted (`single`) |
| `warnings` | string[] (≤ 100) | connector-side findings, e.g. a nested model that allows unknown keys |

```json
{"type":"description","id":"d1","schemas":{"taskConfig":{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"}},"additionalProperties":false},"scanConfig":{"type":"object","properties":{},"additionalProperties":false},"analysisConfig":{"type":"object","properties":{},"additionalProperties":false},"result":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}},"schedule":{"kind":"template","template":"single"},"warnings":[]}
```

The runtime turns it into the describe output (`schemas/describe.schema.json`, [tasks](tasks.md) §7).

### 5.4 Schedule

`schedule` (R → C):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | |
| `ctx` | ctx | §5.1 |
| `scanConfig` | object | effective scan config (resolved form is not applied: templates resolve their own inputs) |
| `taskConfig` | object | effective task config (secrets in plaintext) |

```json
{"type":"schedule","id":"s1","ctx":{"scanId":"5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f","analysisId":null,"seq":null,"round":null,"attempt":1,"executionId":null,"deadlineMs":null,"tmpDir":"/tmp/scantor/x-schedule-1/tmp","filesDir":null},"scanConfig":{"count":3},"taskConfig":{"greeting":"Hello"}}
```

`analysis` (C → R), one per yielded item, in order; the runtime assigns `seq` by arrival:

```json
{"type":"analysis","id":"s1","config":{"n":0}}
```

`done` (C → R): `{"type":"done","id":"s1","count":3}`. `count` must equal the number of `analysis`
messages sent for this request; a mismatch is a protocol violation.

Or `error` (C → R): `{"type":"error","id":"s1","error":{"type":"taskError","message":"boom","stack":"…"}}`.

The runtime discards replayed items when resuming from a checkpoint and verifies determinism
([templates](templates.md) §6); the connector is not aware of resumption. Backpressure: when the
scheduler cannot publish (full queue), the runtime stops reading fd 4; the pipe fills and the
connector's writes block (§6.1).

### 5.5 Run

`run` (R → C):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | |
| `ctx` | ctx | §5.1 |
| `analysisConfig` | object | the analysis config as scheduled |
| `taskConfig` | object | effective task config (secrets in plaintext); identical for every run of a scan, so a connector may cache its parsed form by the raw bytes |

```json
{"type":"run","id":"r7","ctx":{"scanId":"5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f","analysisId":"5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234","seq":1234,"round":1,"attempt":2,"executionId":"b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e","deadlineMs":1761041136000,"tmpDir":"/tmp/scantor/x-b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e/tmp","filesDir":"/tmp/scantor/x-b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e/files"},"analysisConfig":{"domain":"example.org","rank":1234},"taskConfig":{"greeting":"Hello"}}
```

`result` (C → R): the result validated by the native model and serialised in JSON (output) mode. Values
that are not representable in JSON (NaN, ±Infinity, non-string map keys, binary data) make the connector
report `validation` instead.

```json
{"type":"result","id":"r7","result":{"text":"Hello, example.org","screenshot":{"id":"e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a","name":"shot.png","size":48213,"sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","contentType":"image/png"}}}
```

Or `error` (C → R):

```json
{"type":"error","id":"r7","error":{"type":"retry","message":"rate limited by target","delayMs":30000}}
{"type":"error","id":"r7","error":{"type":"validation","message":"analysis config is invalid","details":{"issues":[{"path":"/rank","message":"Input should be a valid integer"}]}}}
```

### 5.6 Files

`file` (C → R), sent by `ctx.files.put` during a `run`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | connector request id |
| `parent` | string | the in-flight `run` id |
| `name` | string | 1–255 characters, no `/`, `\` or NUL; unique within the execution |
| `path` | string | absolute path of a regular file inside `ctx.filesDir`: the connector writes in-memory data there, and copies a user-supplied file there (so later changes by user code cannot alter what is uploaded) |
| `contentType` | string \| null | MIME type; null = `application/octet-stream` |

```json
{"type":"file","id":"c3","parent":"r7","name":"shot.png","path":"/tmp/scantor/x-b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e/files/0-shot.png","contentType":"image/png"}
```

The runtime opens the path with `O_NOFOLLOW`, requires a regular file inside this execution's
`filesDir`, a unique name, the size within `maxFileBytes` and the count within `maxFilesPerAnalysis`,
hashes the content (SHA-256), generates the file id (uuid v4) and replies at once:

```json
{"type":"fileRef","id":"c3","fileRef":{"id":"e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a","name":"shot.png","size":48213,"sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","contentType":"image/png"}}
```

or `{"type":"error","id":"c3","error":{"type":"validation","message":"file shot.png is 2147483648 bytes; the limit is 1073741824","retryable":false}}`.
Uploading happens only after the run succeeded ([runtime](runtime.md) §8.8; local mode copies the files
to the output directory), so files of failed attempts are never stored, and upload time does not count
toward the analysis deadline. Every file registered during a successful execution is listed in the
result message, whether or not the result references it. The runtime deletes the execution directory
afterwards. A `file` request outside a `run` is answered with `error` type `validation` (`files are only
available in run`).

### 5.7 Logs and progress

`log` (C → R), fire-and-forget, from `ctx.log` or from the connector itself:

| Field | Type | Meaning |
|---|---|---|
| `parent` | string \| null | in-flight request id, or null outside requests |
| `level` | `debug` \| `info` \| `warning` \| `error` | |
| `message` | string ≤ 16 KiB | the connector truncates longer messages |
| `fields` | object (optional) | structured key/values (JSON-serialisable; ≤ 16 KiB serialised) |

```json
{"type":"log","parent":"r7","level":"info","message":"fetching","fields":{"url":"https://example.org"}}
```

`progress` (C → R) from `ctx.progress`; the latest value per request is reported in the runtime's state
poll (`busy[].progress`) and shown in the in-flight list:

```json
{"type":"progress","parent":"r7","fraction":0.5,"message":"page loaded"}
```

`fraction` is 0…1 or null (unknown); `message` ≤ 256 characters or null. `progress` outside a `run` is
ignored.

### 5.8 Template streams

A wrapped template call inside a custom `schedule` ([templates](templates.md) §3):

`template` (C → R):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | connector request id |
| `parent` | string | the in-flight `schedule` id |
| `template` | string | template name |
| `scanConfig` | object | the template's scan config (only the canonical fields; the runtime applies the canonical defaults and validates) |
| `credit` | integer 1…65536 | initial number of items the connector can accept (recommended 256) |

```json
{"type":"template","id":"c1","parent":"s1","template":"tranco","scanConfig":{"list":"latest","limit":1000},"credit":256}
```

`templateItem` (R → C): `{"type":"templateItem","id":"c1","config":{"domain":"google.com","rank":1}}`.

`templateCredit` (C → R): `{"type":"templateCredit","id":"c1","credit":128}`.

`templateCancel` (C → R): `{"type":"templateCancel","id":"c1"}` when user code stops iterating early
(Python generator closed, `break` out of a `for await`, Go `yield` returned false).

`templateDone` (R → C): `{"type":"templateDone","id":"c1","count":1000}` (`count` = items sent).

Or `error` (R → C) ends the stream: `{"type":"error","id":"c1","error":{"type":"platform","message":"GET
https://tranco-list.eu/download/262W9/1000: 503 Service Unavailable","retryable":true}}` (or type
`validation` for an invalid scan config, e.g. `limit: must be ≤ 1000000`). The connector raises it in
user code as `ScantorError` (with `type`, `message`, `retryable`) at the next iteration. Uncaught, the
schedule ends with an `error`: type `validation` stays `validation`; any other type is reported as
`taskError` with the same message (connectors never claim `platform`, §7.1).

Runtime rules: the `parent` must be the in-flight `schedule` (else `error` type `validation`); the n-th
`template` request of a schedule request (0-based, arrival order) uses resolution key `call:<n>`; open
streams are cancelled implicitly when the parent schedule ends or is cancelled. Flow control in §6.2.

### 5.9 Control

`cancel` (R → C): the runtime asks the connector to abort the in-flight request `id` **before** the
runtime ends it itself. The v1 runtime sends it only while the worker shuts down (drain, SIGTERM, stop;
[runtime](runtime.md) §14); connectors must handle it at any time.

| `reason` | Meaning |
|---|---|
| `drain` | the worker is draining (pause, scale-in, container stop) and the drain grace is running out |
| `stop` | the scan was cancelled or the worker must stop immediately |

```json
{"type":"cancel","id":"r7","reason":"drain"}
```

The connector cancels user code (async cancellation, `AbortSignal`, `context` cancellation, or the
`ctx.cancelled` flag for blocking code) and ends the request with
`{"type":"error","id":"r7","error":{"type":"cancelled","message":"cancelled: drain"}}`, or with its
normal reply if user code finished first. The runtime classifies the outcome itself (§7.2) and kills the
process group when `cancelGraceMs` expires (§10.4). Deadlines never produce a `cancel`: the runtime ends
a request at its deadline by killing the process group ([runtime](runtime.md) §8.5), and the connector's
own deadline timer (§10.4) is what cancels user code in that case.

`shutdown` (R → C): `{"type":"shutdown","id":"x1","graceMs":5000}`, sent only to an idle process. The
connector stops reading, flushes fd 4 and exits with code 0 within `graceMs`. End of file on fd 3 means
the same. Afterwards the runtime closes fd 3 and, when the grace expires, kills the process group.

## 6. Flow control

### 6.1 Schedule output (connector → runtime)

Natural pipe backpressure: the runtime reads fd 4 only as fast as it can publish. A blocked write in the
connector blocks user code's generator, which is the intended behaviour. Consequences for connector
implementations: the fd 4 writer must not have an unbounded queue in front of it (write synchronously,
or bound the queue), and reading fd 3 must happen independently of writing fd 4, so `cancel` and template
messages are received while a write blocks.

### 6.2 Template streams (runtime → connector)

The connector reads fd 3 continuously, so pipe backpressure cannot limit the runtime there; template
streams use credits instead:

- **Allowance** = `template.credit` + the sum of all `templateCredit.credit` of that stream. The runtime
  sends item *k* (1-based) only when *k* ≤ allowance; it never queues more items than that.
- The connector buffers at most allowance − consumed items and grants more credit as user code consumes
  them (reference policy: initial 256; after every 128 consumed items send `templateCredit` 128).
- On `templateCancel` the runtime stops producing and sends `templateDone` with the number of items sent;
  the connector ignores items for that id that arrive between its cancel and `templateDone`.
- A connector that grants no further credit stalls only its own stream. While the runtime is pulling
  items, a connector that sends no `analysis`, `templateCredit` or `done` for `settings.timeoutMs` makes the
  schedule fail with a retryable `timeout` ([runtime](runtime.md) §11.9).

## 7. Errors

### 7.1 Error object

The `error` field of an `error` message (`common.schema.json#/$defs/error`):

| Field | Type | Meaning |
|---|---|---|
| `type` | `taskError` \| `fatal` \| `retry` \| `timeout` \| `crash` \| `validation` \| `platform` \| `cancelled` | connector → runtime: `taskError`, `fatal`, `retry`, `validation`, or `cancelled` (only after `cancel` or when the connector's deadline timer fired); the runtime treats any other type as `taskError`. runtime → connector: `validation` or `platform` |
| `message` | string ≤ 4 KiB | human-readable |
| `retryable` | boolean (optional) | set on runtime → connector errors (exposed to user code); ignored on connector → runtime errors, whose retryability the runtime derives from the type |
| `delayMs` | integer (optional) | only for `retry`: requested delay |
| `stack` | string ≤ 16 KiB (optional) | stack trace of the user exception |
| `details` | object ≤ 4 KiB (optional) | e.g. `{"issues": [{"path": "/rank", "message": "…"}]}` for `validation` |

The runtime truncates oversized fields (keeping the end of stacks) instead of rejecting the message.

### 7.2 Mapping to `ScantorError`

The runtime builds the unified `ScantorError {type, message, retryable, phase, attempt, stack?, details?,
at}` ([data model](data-model.md) §4.6):

| Outcome | `type` | `retryable` | `phase` |
|---|---|---|---|
| connector `error` type `taskError`, or any type a connector may not claim | `taskError` | true | `run` / `schedule` |
| connector `fatal` | `fatal` | false | `run` / `schedule` |
| connector `retry` | `retry` | true; `delayMs` becomes the next delay (clamped to [1 s, `backoff.max`]) | `run` / `schedule` |
| connector `validation` | `validation` | false | `validate` (`schedule` in a schedule) |
| deadline reached (the runtime kills the process group; [runtime](runtime.md) §8.5) | `timeout` | true | `run` |
| connector `cancelled` without a preceding `cancel`: `timeout` when it arrives at most 1 s before the request's deadline or later (the connector's deadline timer fired before the runtime's kill, which still follows), otherwise `taskError` | `timeout` / `taskError` | true | `run` / `schedule` |
| connector `cancelled` after a `cancel` (either reason) | `cancelled`: not retried and **not an attempt**; never published: a run's delivery is given back to the queue uncounted (`drain`) or dropped with the queue (`stop`), a schedule resumes from its last checkpoint under the next scheduler; in local mode the analysis ends `failed` with this error | false | `run` / `schedule` |
| result larger than `maxResultBytes` | `validation` (`store large data with ctx.files`) | false | `validate` |
| analysis config larger than `maxAnalysisConfigBytes` (schedule) | `validation` | false | `schedule` |
| process exited or was killed during a request | `crash` with `details: {exitCode, signal, oomKilled}` | true | `run` / `schedule` |
| protocol violation | `crash` with `details: {protocolError}` | true | `run` / `schedule` |
| handshake `error` or timeout | worker-level error (`phase: bootstrap`, reported via `POST /api/runtime/errors`); describe error in describe mode | – | `bootstrap` |

### 7.3 Protocol violations

Any of the following makes the runtime terminate the process (§10.4), classify the in-flight request as
`crash` with `details.protocolError`, and recycle the process: invalid JSON or a line over
`maxLineBytes` (the line is discarded up to the next newline first), a message that fails its schema, an
unknown `type`, a reply with an unknown or already finished id, a second reply to one request, a
`done.count` mismatch, more than one request reply type for the same id (`result` after `error`), and
connector-initiated messages whose `parent` is not the in-flight request.

## 8. Output capture and logs

- stdout and stderr are read line by line (lines over 16 KiB are split) and attributed to the request in
  flight in that process; output between requests goes to the worker log only.
- Per execution the runtime keeps a ring buffer of the last 32 KiB: stdout and stderr lines verbatim and
  `log` messages rendered on the stderr stream as `[<level>] <message>` followed by ` key=value` for each
  field. It becomes the analysis `logTail` (32 KiB for the final attempt, truncated to 4 KiB for earlier
  attempts, [data model](data-model.md) §8; capture details in [runtime](runtime.md) §13).
- All captured lines are also written to the runtime's JSON log on stderr ([runtime](runtime.md) §13.2)
  with `scanId`, `analysisId`, `workerId`, `executionId` and `stream` (bounded by the node's log
  rotation), so `getWorkerLogs` can tail them. stdout carries only NDJSON events in the local, describe
  and check modes ([runtime](runtime.md) §15.3, §16).
- In local mode every line is emitted live as a `log` event ([runtime](runtime.md) §15.3).
- User prints never corrupt the protocol: the protocol uses only fds 3 and 4.

## 9. Size limits

| Item | Limit | On violation |
|---|---|---|
| protocol line | `maxLineBytes` = 8 MiB (fixed in v1) | protocol violation |
| result | `maxResultBytes` = `SCANTOR_MAX_RESULT_BYTES` | `validation` |
| analysis config (`analysis`, `templateItem`) | `maxAnalysisConfigBytes` = `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` | `validation`, scheduling fails |
| file size / files per execution | `maxFileBytes` = `SCANTOR_MAX_FILE_BYTES` / `maxFilesPerAnalysis` = `SCANTOR_MAX_FILES_PER_ANALYSIS` | `error` reply to `file` (`validation`) |
| `description` | 1 MiB; each schema 256 KiB | describe error |
| `log.message` / `log.fields` | 16 KiB / 16 KiB | truncated |
| `progress.message` | 256 characters | truncated |
| error `message` / `stack` / `details` | 4 KiB / 16 KiB / 4 KiB | truncated by the runtime |
| ids | 64 characters | protocol violation |
| template credit per message | 65 536 | protocol violation |
| warnings in `description` | 100 entries of ≤ 1000 characters | truncated |

## 10. Process lifecycle

### 10.1 States

```
          spawn
            │
            ▼            hello                welcome          ready
        starting ───────────────► negotiating ─────► loading ──────────► idle ◄─────────────┐
            │ 30 s no hello          │ no common          │ error id hello                   │ reply
            │                        │ version            │ / 120 s timeout     request      │
            ▼                        ▼                    ▼                  ┌─────────► busy
         failed ◄────────────────────┴────────────────────┘                  │             │
                                                                              │             │ cancel
   idle ──shutdown──► exiting ──exit 0──► gone                                │             ▼
   any  ──exit/kill──────────────────────► gone ──► respawn (if the slot is still wanted)  cancelling
```

### 10.2 Spawn

Process management is implemented by the runtime ([runtime](runtime.md) §3.3, §3.4, §7); the
connector-visible contract is:

- argv from `SCANTOR_CONNECTOR_CMD` (or `SCANTOR_DEBUG_CMD` in debug mode), split as a command template
  (whitespace-separated, double-quoted spans, `{entry}` substituted; [tasks](tasks.md) §4.2); working
  directory `/task`.
- File descriptors: 0 = `/dev/null`, 1 and 2 = capture pipes, 3 = read end of the runtime → connector
  pipe, 4 = write end of the connector → runtime pipe; everything else closed.
- Environment: the container environment minus the runtime-only variables (`SCANTOR_WORKER_TOKEN`,
  `SCANTOR_URL`, `SCANTOR_CA_CERT`, `SCANTOR_ALLOW_INSECURE_TRANSPORT`), plus `TMPDIR` (a per-process
  directory under `/tmp/scantor`) and these protocol variables:

| Variable | Value | Meaning |
|---|---|---|
| `SCANTOR_PROTOCOL_IN_FD` | `3` | fd the connector reads requests from (connectors use the value, defaulting to 3) |
| `SCANTOR_PROTOCOL_OUT_FD` | `4` | fd the connector writes to (default 4) |
| `SCANTOR_PROTOCOL_VERSIONS` | e.g. `1` or `3,4` | protocol versions the runtime supports (informational; negotiation happens in `hello`/`welcome`) |
| `SCANTOR_PROCESS_INDEX` | `0`, `1`, … | 0-based slot index, stable across respawns of the slot (per-process ports, X displays) |

- The connector leads its own process group (`Setpgid`), dies with the runtime (`Pdeathsig: SIGKILL`),
  and has `oom_score_adj` 1000, so the cgroup OOM killer prefers it over the runtime.

### 10.3 Ready, requests and recycling

- Timeouts: `hello` within 30 s of spawn; `ready` within 120 s of `welcome` (imports can be slow);
  `description` within 60 s of `describe`. In debug mode (`scantor dev debug`) the hello and ready
  timeouts are disabled because the debugger holds the process until it attaches. The runtime sends no
  request before `ready`.
- A process serves one request at a time. After each `run` the runtime increments the process's analysis
  counter; at `maxAnalysesPerProcess` it sends `shutdown` and spawns a replacement for the slot.
- A process is also replaced after any `timeout`, `crash` or protocol violation, and after a `cancel`.
- Spawn failures (cannot start, exit before `ready`, handshake timeout or violation) and the respawn
  backoff are handled as in [runtime](runtime.md) §7.5; the last 4 KiB of stderr accompany the error.

### 10.4 Deadlines, cancellation and termination

- **Deadline**: connectors arm a timer at `ctx.deadlineMs` that cancels user code (Python: cancels the
  run task and sets `ctx.cancelled`; TypeScript/JavaScript: aborts `ctx.signal`; Go: the `ctx` deadline).
  The runtime ends the request at the deadline by killing the process group ([runtime](runtime.md) §8.5),
  so user code should budget with `ctx.deadline`/`ctx.remaining()` and finish before it.
- **Cancel**: after `cancel` the connector has `cancelGraceMs` (5 s) to end the request; then the runtime
  kills the process group.
- **Termination** is always `SIGKILL` to the whole process group (`kill(-pgid, SIGKILL)`) followed by
  reaping; there is no `SIGTERM` step, because user code already had `ctx`-based cancellation.
- **Shutdown** of an idle process: `shutdown`, close fd 3, wait `graceMs` (5 s) for exit 0, then kill the
  process group.
- A process whose request was cancelled or timed out is never reused.

## 11. Signals and process groups

- Connectors keep the default `SIGTERM` and `SIGINT` dispositions; they must not ignore or trap them to
  keep running.
- User code may start child processes (browsers, tools). They inherit the process group and are killed
  with it. Processes that leave the group (`setsid`, double fork) are not tracked; they die with the
  container. The container runs with `Init: true`, so orphans are reaped.
- On container stop or a `drain` action the runtime lets in-flight requests finish within the drain grace,
  may send `cancel{drain}`, then kills the remaining process groups and shuts down idle processes
  ([runtime](runtime.md) §14.1).
- Exit codes of a connector: 0 after `shutdown` or EOF on fd 3; 1 after a handshake failure it reported;
  2 when started without protocol fds; anything else (or a signal) is a crash.

## 12. Conformance harness

`internal/conformance` is a Go test package that plays the runtime's side of the protocol against a real
connector. It runs inside each base image in CI and must pass for every connector and every language a
base image serves.

### 12.1 Setup

The execution mechanics are those of [testing](testing.md) §5: the hidden command (omitted from
`--help` and from the generated CLI reference, like `scantor docs cli`; [tasks](tasks.md) §9.1) `scantor
conformance --language <language>` builds each fixture task (a real task folder with `scantor.yaml`, `Dockerfile` and
entry under `internal/conformance/testdata/<language>/<fixture>/`) with `scantor task build` (no push)
against the language's base image, starts it in a container with `--network none` and the worker
hardening profile, injects the binary, and runs `scantor conformance exec --case <case> --fixture <fixture>
--entry <entry> --language <language>` inside (the host passes the fixture's normalised entry, because the
runtime never reads `/task/scantor.yaml`). The `exec` side plays the runtime:

- it reads `SCANTOR_CONNECTOR_CMD` from the image environment, substitutes `{entry}` and spawns the
  process exactly as §10.2 describes;
- it validates **every line** the connector writes against `message.schema.json#/$defs/connectorToRuntime`
  (schemas embedded in the binary, `santhosh-tekuri/jsonschema`);
- it uses `schemas/templates/*.fixtures.json` (embedded) for the template cases.

Case groups named in [testing](testing.md) §5 map to the ids below: `hello` → H1–H5, `describe` → D1–D5,
`echo` → R1–R2, `invalid-config` → R3, `throws` → R4–R5, `files` → R10–R11, `logs` → R7–R9,
`schedule-stream` → S1–S5 and T1–T3, `template-proxy` → D5 and T4, `crash` → C4, `shutdown` → C3; the
remaining ids (R6, R12–R14, C1–C2, C5, P1–P4) belong to the same run.

### 12.2 Fixture tasks

Every connector provides these fixtures with identical behaviour (language-idiomatic code):

| Fixture | Definition |
|---|---|
| `echo` | TaskConfig `{greeting: string = "Hello", apiToken: secret, optional}`; AnalysisConfig `{name: string = "world", mode: string = "ok", sleepMs: int = 0, bytes: int = 0}`; Result `{text: string, ctx: {scanId, analysisId, seq, attempt, hasDeadline: bool, tmpDirWritable: bool}, secretLength: int, files: FileRef[]}`; no schedule; synchronous `run`. Prints `importing echo` to stdout and stderr at import. Modes: `ok` → text `"<greeting>, <name>!"`; `fatal` → `Fatal("fatal requested")`; `retry` → `Retry("retry requested")`; `retryAfter` → `Retry("retry requested", 1.5 s)`; `throw` → generic exception `boom`; `invalidResult` → returns `text` as the integer 42; `sleep` → sleeps `sleepMs` in cancellable steps; `sleepUncooperative` → one blocking sleep ignoring cancellation; `exit` → exits the process with code 3; `oversized` → `text` of `bytes` characters; `stdout` → prints `{"type":"result","id":"r0","result":{}}` to stdout and `noise` to stderr, then ok; `log` → `ctx.log("info", "hello", n=1)`, then ok; `progress` → `ctx.progress(0.5, "half")`, then ok; `file` → puts bytes `abc` as `a.bin` with content type `application/octet-stream`, text `hello` as `b.txt` without content type, and a file written to `tmpDir/c.json` by path, returning the three refs in `files`; `fileError` → puts bytes `x` as `bad.bin` and does not catch the error (the harness answers that `file` with an error). |
| `echo-async` | as `echo` with an asynchronous `run` (Python `async def`, TypeScript/JavaScript `async`); not applicable to Go |
| `minimal` | only `result: {ok: boolean}` and `run` returning `{ok: true}`; all other types default to Empty |
| `schedule` | ScanConfig `{count: int = 3, failAt: int \| null = null, fatalAt: int \| null = null}`; AnalysisConfig `{n: int}`; synchronous generator yielding `n = 0 … count−1`, raising a generic exception before item `failAt` and `Fatal` before item `fatalAt`; `run` returns `{n}` |
| `schedule-async` | as `schedule` with an async generator (Python, TypeScript, JavaScript) |
| `template-unwrapped` | schedule = the `range` proxy passed unwrapped with its types; `run` returns `{value}` |
| `template-wrapped` | ScanConfig `{start: int = 0, end: int = 10, stopAfter: int \| null = null}`; schedule iterates `range.schedule(ctx, {start, end, step: 1})`, yields `{n: value × 2}`, stops after `stopAfter` items |
| `template-models` | ScanConfig `{template: string, config: object (open map)}`; AnalysisConfig `{template: string, config: object}`; schedule parses `config` with the native ScanConfig model of `template` (letting a model validation error propagate) and iterates that template's proxy with it, yielding `{template, config: item}`; `run` parses `config` with the native AnalysisConfig model and returns `{config: <model serialised>}` |
| `template-<name>` | one per template in `schemas/templates/` (7): schedule = the template proxy unwrapped with its types |
| `import-error` | raises `RuntimeError("boom at import")` (or the language equivalent) at import time; not applicable to Go (a panic during package initialisation ends the process before `hello`, which the runtime reports as a spawn failure with the stderr tail) |
| `bad-definition` | Python: module without `task`; TypeScript/JavaScript: default export is a plain object; not applicable to Go |

Go has no `echo-async`, `import-error` or `bad-definition` fixture, so H3, H4 and R13 do not apply to
it. The Go `echo` is written `scantor.Serve[TaskConfig, scantor.Empty, AnalysisConfig, Result](nil,
run)` (no schedule, custom analysis config), and differs where the definition above assumes dynamic
types: mode `throw` panics with `boom` (only panics carry a stack in Go); mode `invalidResult` returns a
result that violates a tag constraint (for example `Text` tagged `jsonschema:"minLength=1"` and returned
empty). Connectors reject an invalid file name themselves before any `file` message is sent
(P1 requires every `file` line to validate), so `fileError` uses a valid name and lets the harness
answer with the error.

### 12.3 Cases

Unless stated otherwise, each case uses a fresh process after a successful handshake with protocol 1 and
`welcome.limits` = the defaults of §9.

| Id | Fixture | Steps | Expected |
|---|---|---|---|
| H1 | echo | spawn | `hello` within 30 s with `id: "hello"`, `protocol.min ≤ 1 ≤ protocol.max`, `connector.language` = suite language, `pid` = child pid; after `welcome`, `ready` within 120 s; the import-time prints appear only on stdout/stderr |
| H2 | echo | answer `hello` with `error` id `hello` | the process exits with a non-zero code within 5 s and writes nothing more to fd 4 |
| H3 | import-error | handshake | `error` id `hello`, `type` `taskError`, message contains `boom at import`, non-empty `stack`; exit code 1 |
| H4 | bad-definition | handshake | `error` id `hello`, `type` `validation`, message names the problem; exit code 1 |
| H5 | echo | start without fds 3/4 | exit code 2, explanatory message on stderr |
| D1 | echo | `describe` | `description`: taskConfig root closed, `greeting` has default `Hello` and is not required, `apiToken` has `writeOnly: true`; analysisConfig root closed with the four fields; result is an object schema whose `files` items carry `"x-scantor": "file"`; `schedule` = `{kind: template, template: single}` |
| D2 | minimal | `describe` | taskConfig, scanConfig and analysisConfig are `{type: object, properties: {}, additionalProperties: false}` (annotations ignored); `schedule` single |
| D3 | schedule | `describe` | `schedule` = `{kind: custom}` |
| D4 | template-unwrapped | `describe` | `schedule` = `{kind: template, template: range}` |
| D5 | template-&lt;name&gt; | `describe` | `schedule` names the template; exported scanConfig and analysisConfig are compatible with the canonical schemas: same property names, same `required` sets, same type sets (nullable unions normalised), same `default` values, same `enum` values |
| R1 | echo | `run` with taskConfig `{}` and `{"greeting":"Hi"}`, analysisConfig `{}` | results `Hello, world!` and `Hi, world!` |
| R2 | echo | `run` | `result.ctx` equals the request's ctx fields; `hasDeadline` true; `tmpDirWritable` true |
| R3 | echo | analysisConfig `{"name": 5}` and `{"nmae": "x"}` | `error` type `validation` with non-empty `details.issues` |
| R4 | echo | modes `fatal`, `retry`, `retryAfter`, `throw` | types `fatal`, `retry` (no `delayMs`), `retry` with `delayMs: 1500`, `taskError` with a stack mentioning the entry file |
| R5 | echo | mode `invalidResult` | `error` type `validation` |
| R6 | echo | mode `oversized`, `bytes` = 2 097 152 | a single valid `result` line longer than 2 MiB |
| R7 | echo | mode `stdout` | `result` ok; fd 4 carries no foreign line; the noise is on the stdout/stderr pipes |
| R8 | echo | mode `log` | a `log` with `parent` = run id, level `info`, message `hello`, fields `{n: 1}`, before the `result` |
| R9 | echo | mode `progress` | a `progress` with `parent` = run id, fraction 0.5, message `half` |
| R10 | echo | mode `file`; answer each `file` with a `fileRef` | three `file` messages with `parent` = run id, distinct names, paths inside `ctx.filesDir` whose contents are `abc`, `hello` and the JSON file (the path-based file is a copy, not the original), content types `application/octet-stream`, null, null; `result.files` equals the three replied refs in order |
| R11 | echo | mode `fileError`; answer the `file` (`bad.bin`) with `error` type `validation` | the run ends with `error` type `validation` and the harness's message |
| R12 | echo | taskConfig `{"apiToken": "s3cret"}` | `secretLength` 6 |
| R13 | echo-async | R1–R12 except `exit` | same expectations |
| R14 | echo | 50 sequential runs on one process | all succeed; each run gets its own empty tmpDir |
| C1 | echo / echo-async | mode `sleep` 60 000 ms; `cancel{drain}` after 200 ms | `error` type `cancelled` within `cancelGraceMs` |
| C5 | echo / echo-async | mode `sleep` 60 000 ms with `ctx.deadlineMs` = now + 300 ms | user code observes cancellation at the deadline: the run ends with `error` type `cancelled` shortly after the deadline (the real runtime would have killed it; the harness only checks that the connector's deadline timer fired) |
| C2 | echo | mode `sleepUncooperative`; `cancel`; kill the process group after the grace | every process of the group is gone |
| C3 | echo | idle `shutdown{graceMs: 5000}` | exit code 0 within 5 s |
| C4 | echo | mode `exit` | the process exits with code 3 while the run is in flight; no reply |
| S1 | schedule / schedule-async | scanConfig `{"count": 3}` | `analysis` `{n:0}`, `{n:1}`, `{n:2}` in order, then `done` count 3 |
| S2 | schedule | `{"count": 0}` | `done` count 0 |
| S3 | schedule | `{"count": 5, "failAt": 2}` | two items, then `error` type `taskError` |
| S4 | schedule | `{"count": 5, "fatalAt": 0}` | `error` type `fatal`, no items |
| S5 | schedule | `{"count": 100000}`; the harness stops reading fd 4 for 1 s twice | all items in order, `done` count 100000; `cancel` sent during a stall is still received and answered |
| T1 | template-wrapped | `{"end": 1000}`; the harness sends items only within the allowance | `template` with `parent` = schedule id, `template: range`, scanConfig equal to `{start: 0, end: 1000, step: 1}` after canonical defaults, `credit` ≥ 1; the connector grants credit so that all 1000 items are received; 1000 `analysis` items with `n = 2 × value`; harness `templateDone` 1000; `done` count 1000; the harness never observes an allowance violation |
| T2 | template-wrapped | `{"end": 1000, "stopAfter": 5}` | five `analysis` items, a `templateCancel`; after the harness's `templateDone`, `done` count 5 |
| T3 | template-wrapped | answer `template` with `error` `{type: platform, message: "download failed", retryable: true}`; separately with `{type: validation, message: "bad config", retryable: false}` | the schedule ends with `error` type `taskError` containing `download failed`; respectively type `validation` with `bad config` |
| T4 | template-models | for every template fixture: each `scanConfig.valid` input → `schedule {template, config: input}`; each `scanConfig.invalid` input; each `analysisConfig.valid`/`invalid` input → `run {template, config: input}` | valid scan configs produce a `template` request whose scanConfig, after canonical defaults, equals the fixture's `effective`; invalid ones end with `error` type `validation` (for `semantic` invalids the harness answers the `template` request with `error` type `validation`); valid analysis configs echo back equal to the input; invalid ones end with `error` type `validation` |
| P1 | all | every case | every fd 4 line is valid UTF-8, ends with `\n`, ≤ `maxLineBytes`, and validates against `connectorToRuntime` |
| P2 | echo | add an unknown field `"xFuture": 1` to `welcome` and `run` | behaviour unchanged |
| P3 | echo | send `{"type":"frobnicate","id":"z1"}` | `error` id `z1` type `validation`; the next `run` succeeds |
| P4 | echo, schedule | every reply | carries exactly the request's id |

Runtime-side behaviour (classification, recycling, termination, size enforcement, credit accounting) is
tested separately in `internal/runtime` with a scripted fake connector ([testing](testing.md)).

## 13. Decisions made in this document

Flagged for lead review:

1. **Separate `ready` message** after `welcome`: the protocol is negotiated before user code is imported,
   so import failures and incompatibilities are reported distinctly.
2. **Pipe backpressure for schedule output**, credits only for runtime → connector template streams.
3. **The runtime chooses the version** `min(N, connector.max)` within [N−1, N]; every protocol change
   bumps the version.
4. **Stateless requests**: `taskConfig` travels with every `run` (connectors may cache by bytes) instead of
   a per-process configure message; this keeps multiplexing additive.
5. **`progress` message and `ctx.progress`**, feeding `busy[].progress` of the state poll.
6. **Files are registered, not uploaded, during `run`**: `ctx.files.put` places the content in
   `ctx.filesDir`, the runtime hashes it and returns a FileRef with a runtime-generated id at once, and
   uploads happen after a successful run (aligned with [runtime](runtime.md) §8.4, §8.8).
7. **Protocol environment variables** `SCANTOR_PROTOCOL_IN_FD`, `SCANTOR_PROTOCOL_OUT_FD`,
   `SCANTOR_PROTOCOL_VERSIONS` and `SCANTOR_PROCESS_INDEX` are set for connector processes; runtime-only
   variables are removed from their environment.
8. **Fixed v1 constants**: 8 MiB line limit, 5 s cancel and shutdown grace, 30 s hello, 120 s ready, 60 s
   describe; termination is `SIGKILL` to the process group without a `SIGTERM` step.
9. **Handshake error types**: `taskError` for exceptions at import, `validation` for invalid definitions.
10. **Connector deadline timers** cancel user code at `ctx.deadlineMs`; the v1 runtime sends `cancel` only
    during worker shutdown (reasons `drain`, `stop`), and a connector-reported `cancelled` after `cancel`
    becomes ScantorError type `cancelled`, which is neither retried nor counted as an attempt (lead
    ruling); connectors may only report `taskError`, `fatal`, `retry`, `validation` and `cancelled`
    (re-raised runtime errors other than `validation` become `taskError`).

## 14. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Per-process multiplexing | requests carry ids and connector calls carry `parent`; a future `hello.maxConcurrency` (absent = 1) lets the runtime send several `run` requests to one process; `ctx` is per call |
| `ctx.memo` | a new connector request `memo {key, value?}` answered from `scheduling.resolved` (keyed map, ≤ 64 KiB values) |
| `ctx.expectTotal` | a fire-and-forget `expectTotal {parent, total}` message mapped to `stats.expectedTotal` |
| Streaming large results | a `resultChunk` sequence or files-only results; today results above `maxResultBytes` must use `ctx.files` |
| STS / multipart uploads | `file` stays the same; only the runtime's storage step changes |
| Uploads for user code | a `upload {parent, id}` request returning a local path of a referenced upload |
| Heartbeats from long runs | `progress` already reaches the runtime; a liveness timeout per request can build on it |
| New languages | implement the connector side of this document and pass §12; no runtime change |
