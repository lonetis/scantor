# Architecture

This document is the top-level contract for scantor: what the platform is, the exact meaning of every
term, which component owns which responsibility, how the pieces are deployed and isolated, and how data
and control flow through the system for every user-visible operation. Every other internal document
refines one area of this one: [data model](data-model.md), [REST API](api.md), [tasks](tasks.md),
[connector protocol](protocol.md), [templates](templates.md), [runtime](runtime.md), [queue](queue.md),
[auth](auth.md), [MCP](mcp.md), [security](security.md), [nodes](nodes.md), [deployment](deployment.md),
[editor](editor.md), [UI](ui.md), [testing](testing.md) and [development](development.md). When two
documents disagree, the backbone ([architecture](architecture.md), [data model](data-model.md),
[api](api.md)) wins and the other document must be fixed.

## 1. Vision and principles

scantor runs user-defined scanning **tasks** at large scale on many machines, including machines behind
firewalls that can only make outbound connections. A task is a folder of code in any supported language,
built into its own Docker image. Users author tasks in a browser editor, locally with the CLI, or through
an LLM agent over MCP; they test them, publish immutable **revisions**, start **scans** that fan out into
millions of **analyses**, and inspect, query and export the typed **results** through the web UI, the
CLI, the REST API or MCP.

Principles (in priority order when they conflict):

1. **Robust and secure where it is cheap and central; simple everywhere else.** Central rules (one label
   function, one Dockerfile policy, one query allowlist, typed principals, guarded upserts) instead of
   scattered checks.
2. **Reuse existing software** (RabbitMQ, MongoDB, RustFS, CNCF registry, Traefik, code-server,
   better-auth) instead of re-implementing it.
3. **Implement each concern once.** The Go binary is the only implementation of everything that touches
   a task folder, a worker container or a node; templates are implemented once in Go; error handling
   lives once in the runtime.
4. **Level-triggered, idempotent control.** API handlers record intent; a reconciler converges
   infrastructure to that intent; every consumer of a message tolerates duplicates.
5. **Configuration exclusively through environment variables**, documented only in `.env.example`.
6. **Extensibility without speculation.** Data models, wire formats and interfaces leave room for the
   items in each document's "Future extensions" section without implementing them.

## 2. Glossary

Use these terms exactly, in code, API, UI and docs. The "Not" column lists words that must not be used for
the concept; a docs/UI string test enforces a curated subset of them ([testing](testing.md)).

### 2.1 Platform and deployment

| Term | Definition | Not |
|---|---|---|
| **master** | The central deployment reachable by users and nodes: orchestrator, MongoDB, RabbitMQ, RustFS, registry, mongo-express, optional Traefik, and the built-in node. | control plane, head node |
| **orchestrator** | The Nuxt 4 application on the master (image `scantor-orchestrator`). It serves the web UI, the REST API (`/api/*`), the MCP endpoint (`/mcp`) and the editor origin, and runs the ingestor, reconciler, jobs runner and the other internal components of §4.1. | backend, brain |
| **node** | A machine that contributes compute by running a node daemon. Identified by a node record and authenticated by a node token. | agent, runner, worker machine |
| **built-in node** | The node that runs on the master itself, created automatically, with the `internal` endpoint profile. Its node token is derived from `SCANTOR_SECRET`. | local node |
| **remote node** | Any node other than the built-in node. Uses the `public` endpoint profile and connects outbound only. | external node |
| **node daemon** | The process `scantor node` on a node. It long-polls its desired worker set, reconciles local Docker containers to match, and reports status. | agent |
| **node token** | The secret a node daemon authenticates with: `snt_` + 32 random bytes (base64url), stored only as SHA-256. Shown once; rotatable and revocable by admins. | node key |
| **node pool** | A string label on a node (default `shared`) that scans select with `settings.nodeSelector.pool`. | cluster, group |
| **endpoint profile** | Which set of URLs a node and its workers use to reach the master: `internal` (compose service names, built-in node) or `public` (public URLs, remote nodes). See §8. | |
| **assignment** | One entry of a node's desired worker set as returned by `GET /api/node/assignments`. | job, lease |
| **placement** | The deterministic function that maps desired workers to nodes (hard filters, then stable spread). | scheduling (reserved for `schedule`) |
| **managed labels** | The Docker labels scantor sets at container creation on every container it creates; they override image labels with the same key ([security](security.md)). | |

### 2.2 Tasks and authoring

| Term | Definition | Not |
|---|---|---|
| **task** | A user-owned folder with a strict structure: manifest `scantor.yaml`, a `Dockerfile` (`FROM ${SCANTOR_BASE}`), and an entry file that defines the config/result types and the `schedule`/`run` functions with the connector API. Extra files are allowed. Identified by a server id and a `name` slug unique per owner. | job, plugin, module |
| **manifest** | The file `scantor.yaml` at the task root (`scantor: 1`, `name`, `language`, optional `description`, `entry`, `defaults`). Schema: `schemas/task-manifest.schema.json`. | config file |
| **language** | One row of `schemas/languages.json` (`python`, `typescript`, `javascript`, `go`): base image name, default entry, file extensions. The only language table in the platform. | runtime (reserved) |
| **base image** | `scantor-base-python`, `scantor-base-js` or `scantor-base-go`: language toolchain + connector + ENV contract. Contains **no** runtime. Every task Dockerfile starts `FROM ${SCANTOR_BASE}`. | runtime image |
| **connector** | The per-language library (`connectors/python`, `connectors/js` = npm `@scantor/connector` for TypeScript and JavaScript, `connectors/go`) that user code imports to define a task with strict types. It runs as connector processes and speaks the connector protocol. | SDK, binding |
| **connector protocol** | Newline-delimited JSON over fd 3 (runtime → connector) and fd 4 (connector → runtime), schema'd in `schemas/protocol/`, version negotiated in the `hello` → `welcome` → `ready` handshake ([protocol](protocol.md) §4). | |
| **scaffold** | A per-language starter (`scaffolds/<language>/`) that, combined with a template choice, generates a task folder that publishes unchanged. | boilerplate |
| **template** | A reusable schedule implementation with predefined ScanConfig and AnalysisConfig types (`single`, `list`, `range`, `repeat`, `tranco`, `crux`, `cidr`), implemented once in Go (`internal/templates/<name>`), canonical schema in `schemas/templates/<name>.json` ([templates](templates.md)). Connectors expose typed proxies. | scan template, preset |
| **workspace** | A user's area on the master (volume `scantor-workspaces`, subpath `<userId>`) holding one working-copy folder per task (`<taskName>/`). The only input to revisions and test runs. | repo, sandbox |
| **workspace helper** | A throwaway container (scantor image) that runs one `scantor workspace …` operation on one user's workspace subpath. The orchestrator process never reads or writes workspace content itself. | |
| **editor** | A per-user `scantor-editor` container (code-server) that edits that user's workspace in the browser, served on its own origin by a dedicated orchestrator listener (container port 3001). | IDE container |
| **task revision** (**revision**) | An immutable, numbered (`echo@3`) snapshot of a task's workspace that passed static validation, was built into an image (referenced by digest), and was described (JSON Schemas, defaults, schedule kind). Scans pin a revision. | version, build, release |
| **draft image** | An unpublished image built from the current workspace for test runs (`tasks/<taskId>:draft-<packSha256>`), never pushed, garbage-collected after a retention period. | |
| **test run** | A platform-side execution of the current workspace in one container on the master with the runtime in local mode (schedule limited + run), returning results, errors, logs and files without publishing. | dry run |
| **pack** | The deterministic tar of a task folder produced by `scantor task pack` (sorted entries, zeroed mtimes and owners, `.dockerignore` semantics, hard excludes `.git/` and `.scantor/`), stored and transferred gzip-compressed (`snapshots/<taskId>/<packSha256>.tar.gz`; its size is `packBytes`). The **pack hash** (`packSha256`) is the SHA-256 of the **uncompressed** tar stream, so a different gzip implementation in another binary version never changes it ([tasks](tasks.md) §9.2). | |
| **task pipeline** | `scantor task pack \| check-static \| build`: the single implementation of static validation, Dockerfile policy, image build, describe, check and push, used by the orchestrator, `scantor validate`, `scantor push` and `scantor dev run`. | |

### 2.3 Configuration and execution

| Term | Definition | Not |
|---|---|---|
| **task config** | The task's behaviour parameters. Defaults come from the task definition, values are supplied per scan, and they stay constant for all analyses of one scan. Passed to every `schedule` and `run` call. | settings |
| **scan config** | Parameters for creating analyses (for example Tranco list and limit). Passed to `schedule`. | |
| **analysis config** | The input of one analysis (for example one domain). Produced by `schedule`, passed to `run`. | job input, target |
| **effective config** | A task config or scan config after JSON-Schema validation with defaults filled (ajv `useDefaults`). The scan stores only effective configs. | |
| **scan settings** | The platform-level knobs of a scan: `workers`, `processes`, `timeoutMs`, `maxAttempts`, `backoff`, `resources` (per process), `maxAnalysesPerProcess`, `nodeSelector`, `privileged`. Defaults come from the manifest `defaults`. | scan config (that is the task-defined one) |
| **scan** | One execution of a task revision with a task config, a scan config and scan settings. | campaign, run (reserved) |
| **schedule** (operation) | `schedule(ctx, scanConfig, taskConfig) → stream of AnalysisConfig`, executed in the scheduler worker. | cron, recurring (reserved for future time-based scans) |
| **run** (operation) | `run(ctx, analysisConfig, taskConfig) → Result`, executed in runner workers. | execute, job |
| **analysis** | One unit of work produced by `schedule`, identified by `<scanId>-<seq>`. It ends in a typed result or an error. | unit, job, item |
| **seq** | The 0-based position of an analysis in the scan's schedule stream; deterministic for a deterministic schedule. | index |
| **result** | The typed output of one successful analysis (Result schema, output mode). | output |
| **file** | A binary output attached to an analysis, stored in RustFS (S3) and referenced from results by a **FileRef** `{id, name, size, sha256, contentType}` (JSON Schema annotation `"x-scantor": "file"`). | artifact, blob |
| **attempt** | One execution of `run` for an analysis within a round (1-based). Retries create new attempts. | try |
| **execution** | One delivery of an analysis message to a runner, identified by a fresh uuid `executionId`. Duplicate executions of the same attempt are possible and deduplicated. | |
| **round** | The retry-failed generation of a scan (starts at 1; each retry-failed increments it). Analyses carry the round they were last (re)scheduled in. | |
| **worker** | One Docker container running a revision's image for one scan, with role `scheduler` (runs `schedule`, exactly one per scan while scheduling) or `runner` (runs `run`). Its entrypoint is the runtime. Named `scantor-w-<workerId>`. | replica, pod, agent |
| **workers** (setting) | Number of runner workers of a scan. | concurrency, replicas |
| **processes** (setting) | Number of connector processes per worker; resizable live. | concurrency, threads |
| **process** | One connector OS process inside a worker; handles one analysis at a time. | slot (internal runtime term only) |
| **runtime** | The language-agnostic Go process `scantor runtime` inside every worker (and in test runs, `dev run`, describe and check). It is injected by the consumer (`CopyToContainer` of the consumer's own static binary), never baked into images. All retry, timeout, upload, publish and error classification logic lives here. | agent, language runtime |
| **local mode** | The runtime mode without queue or platform (schedule limited, then run in-process), used by `scantor dev run` and test runs. | |
| **worker token** | `swt_<workerId>.<mac>`: the credential of one worker, HMAC-derived, never stored, valid only while the worker is in an active state ([data model](data-model.md) §6.6). | scan token |
| **scheduler checkpoint** | `{confirmed, tailHash, epoch}`: the contiguous prefix of published-and-confirmed analyses plus the SHA-256 of the canonical JSON of item `confirmed−1`. | progress |
| **epoch** | A per-scan counter incremented for every new scheduler worker; fences duplicate schedulers. | generation |
| **backpressure** | The scheduler treating publish nacks from a full scan queue (`x-overflow=reject-publish`) as "wait and republish". | throttling |
| **circuit breaker** | The ingestor auto-pausing a scan whose recent attempt failure ratio is too high (reason `failureRate`). | |
| **condition** | A bounded, typed status entry on a scan that explains why it is not progressing (for example `workersPending`, `crashLoop`, `brokerAlarm`). | |

### 2.4 Platform internals

| Term | Definition |
|---|---|
| **ingestor** | Orchestrator component that consumes `scantor.results.ingest` and `scantor.dead.ingest`, writes analysis docs with guarded upserts, maintains live counters, runs the circuit breaker and triggers completion. |
| **reconciler** | Orchestrator component that converges infrastructure to recorded intent: scan topology in RabbitMQ, placement and node assignments, node liveness, scheduler supervision, recounts, completion, stall detection, conditions, garbage collection. Level-triggered every 10 s and on MongoDB change streams. |
| **job** | A resumable, leased unit of background work in the `jobs` collection (revision build, test run, scan delete, retry-failed, export, task delete, user purge), executed by the jobs runner. |
| **lock** | A lease document in the `locks` collection that makes a singleton loop safe if a second orchestrator ever runs. |
| **recount** | The authoritative aggregation of analysis statuses for one scan; live counters are only hints. |
| **completion** | The single idempotent conditional update that moves a scan from `running` to `completed` or `failed`. |
| **tombstone** | The minimal scan document kept after a delete (state `deleted`) until `purgeAfter`, so late results are recognised and dropped. |
| **principal** | The typed identity of a request: `user` (session, API key, MCP), `node`, `worker`, `tools`, `setup`, plus the registry `orchestrator` credential ([auth](auth.md)). |
| **scope** (`x-scantor-scope`) | The principal kind an API operation accepts: `owner`, `admin`, `public`, `node`, `worker`, `setup`, `tools` ([api](api.md)). |

## 3. System overview

```
   users (browser, CLI, MCP agents)                     remote nodes (outbound only)
        │ https                                             │ https / amqps / s3 / registry
        ▼                                                   ▼
 ┌──────────────────────────── master ───────────────────────────────────────────┐
 │  traefik (optional, :443 HTTP + TCP SNI)                                        │
 │      │                                                                          │
 │  orchestrator ── UI · REST /api · /mcp · editor origin · registry token server   │
 │      │  ingestor · reconciler · jobs runner · task-pipeline driver ·            │
 │      │  workspace helper runner · editor manager · metrics                      │
 │      ├── MongoDB (rs0)   RabbitMQ (vhost scantor)   RustFS (bucket)   registry  │
 │      │                                                                          │
 │      └── host Docker daemon ── builds · helpers · editors · test runs           │
 │                                                                                  │
 │  built-in node daemon (scantor node) ── host Docker daemon ── master workers    │
 └──────────────────────────────────────────────────────────────────────────────────┘
        remote node: scantor node ── local Docker daemon ── remote workers
        worker = task image + injected runtime + connector processes
```

## 4. Components

### 4.1 Orchestrator internal components

The orchestrator is one Node.js 26 process (Nitro `node-server` preset). Which background components run
is selected by `SCANTOR_COMPONENTS` (comma-separated subset of `api`, `ingestor`, `reconciler`), so the
same image can later be split into several compose services. Everything below runs inside it.

| Component | Runs in | Responsibility | Main collections / systems |
|---|---|---|---|
| **REST API** | `api` | All `/api/*` routes (Nitro file routes with `defineRouteMeta`), zod validation, error envelope, OpenAPI at `/api/docs/openapi.json` ([api](api.md)). Handlers record intent; they never perform long infrastructure work inline. | all |
| **MCP server** | `api` | `/mcp` (Streamable HTTP, stateless). Tools generated from the OpenAPI document (curated by `x-mcp`), executed by loopback calls to the REST API with a single-use internal capability ([mcp](mcp.md)). | – |
| **auth** | `api` | better-auth (`/api/auth/*`, Mongo adapter, admin, passkey, api-key, jwt, mcp, cimd plugins) plus one global middleware that resolves the typed principal for every request and enforces route prefixes, the operation registry built from the runtime OpenAPI document (deny by default), scopes, bans, CSRF origin checks and body caps ([auth](auth.md) §5). | better-auth collections |
| **ingestor** | `ingestor` | Consumes `scantor.results.ingest` (results and attempt events) and `scantor.dead.ingest` (dead-lettered analyses and poison results). Guarded upserts, duplicate handling, live counters, rate window, circuit breaker, completion trigger ([queue](queue.md)). | `analyses`, `scans`, `events` |
| **reconciler** | `reconciler` | Level-triggered loops (10 s tick + change streams, under `locks`): scan topology ensure/remove, `creating → running`, placement and node assignment revisions, node offline detection and lost workers, scheduler supervision and epochs, periodic recount and completion, stall detection and gap fill, scan conditions, boot sweeps (orphan RabbitMQ users and queues, orphan helper/test-run/build/editor containers), GC (draft images after `SCANTOR_DRAFT_IMAGE_RETENTION`, tombstones, registry garbage collection every `SCANTOR_REGISTRY_GC_INTERVAL` under the `registryGc` lock, [deployment](deployment.md) §14.1), editor reaper (idle timeout and editor-key expiry). | `scans`, `workers`, `nodes`, `editors`, `locks` |
| **jobs runner** | `api` (kinds `revisionBuild`, `testRun`) and `reconciler` (kinds `scanDelete`, `scanRetryFailed`, `export`, `taskDelete`, `userPurge`) | Claims queued jobs with a lease, executes them with a resumable cursor, retries with backoff, enforces per-kind concurrency (`SCANTOR_BUILD_CONCURRENCY`, `SCANTOR_TEST_RUN_CONCURRENCY`). | `jobs` |
| **task-pipeline driver** | `api` (the publish request, `revisionBuild` / `testRun` jobs) | Stores the revision snapshot from a workspace helper in S3 synchronously at publish (§11.1 step 6); streams the stored snapshot (`revisionBuild`) or a live helper snapshot (`testRun`) into `scantor task build` (spawned as a subprocess of the orchestrator, talking to the host Docker daemon), stores NDJSON build events as the build log, records structured errors and the describe output. Never uses dockerode for builds. | `revisions`, `testRuns`, S3 `snapshots/`, `build-logs/` |
| **workspace helper runner** | `api` | Starts throwaway helper containers (`scantor workspace <op>`, ops in §4.2) as uid 1000:1000 with the user's workspace subpath only, `--network none` (git ops: `scantor-egress`), read-only rootfs, `--cap-drop ALL`, pids/memory/time limits (`SCANTOR_HELPER_PIDS_LIMIT`, `SCANTOR_HELPER_MEMORY_LIMIT`, `SCANTOR_HELPER_TIMEOUT`), at most `SCANTOR_HELPER_CONCURRENCY` at once and `SCANTOR_HELPER_CONCURRENCY_PER_USER` per user, a per-user read/write lock, managed labels; moves data over stdin/stdout only. Exceptions: `init`/`purge` (§7) and `list`/`read --archive`, which read a revision snapshot from stdin and mount no volume ([editor](editor.md) §9). | volumes `scantor-workspaces`, `scantor-editor-home` |
| **editor manager** | `api` | Starts, idles out and stops per-user editor containers; serves the editor origin on a **dedicated HTTP listener on container port 3001** that accepts only the `SCANTOR_EDITOR_URL` host (421 otherwise) and relays HTTP and WebSocket bytes to the user's code-server unix socket; mints a new per-user `editor` API key (`sk_scantor_editor_…`, lifetime `SCANTOR_EDITOR_API_KEY_TTL`) at every editor start and revokes it at every stop (the reaper stops an editor 5 minutes before `editors.apiKeyExpiresAt`); one-time-code cookie handoff ([editor](editor.md) §6–§8). | `editors`, better-auth `apikey` |
| **registry token server** | `api` | `/api/registry/token` (GET+Basic and POST form flows), ES256 JWTs from an HKDF-derived key; writes the public JWKS file and the registry HTTP secret the registry reads; grants nodes `pull` only on repositories of their current assignments and the orchestrator credential `pull`/`push`/`delete` on `tasks/*` plus catalog ([nodes](nodes.md) §10, [api](api.md) §6). | `nodes`, `workers` |
| **metrics** | `api` | `/api/metrics` in Prometheus text format (admin principal, typically an admin API key): scans by state, queue ready/unacked/delayed per scan, ingest rate and lag, workers by state, node heartbeat age, RabbitMQ alarms, jobs by kind/state, HTTP requests ([deployment](deployment.md)). | in-memory + RabbitMQ management API |

Orchestrator boot order (the process exits non-zero on any failure before step 7):

1. Configuration and startup guard ([security](security.md) §6.11 CFG-2, whose algorithm is authoritative):
   parse every variable (invalid security-relevant values abort). The deployment is **public** when the host
   of `SCANTOR_PUBLIC_URL` or `SCANTOR_EDITOR_URL` is not loopback (`localhost`, `*.localhost`,
   `127.0.0.0/8`, `::1`), `COMPOSE_PROFILES` contains `traefik`, or `SCANTOR_BIND_ADDRESS` /
   `SCANTOR_ADMIN_BIND_ADDRESS` is not a loopback address. In public mode, refuse to start when **any**
   environment value ends in `-insecure-dev`, a core secret (`SCANTOR_SECRET`, `SCANTOR_MONGO_PASSWORD`,
   `SCANTOR_RABBITMQ_PASSWORD`, `SCANTOR_S3_SECRET_KEY`, `SCANTOR_MONGO_EXPRESS_PASSWORD`,
   `SCANTOR_MONGO_EXPRESS_SECRET`, and `SCANTOR_MONGO_ANALYTICS_PASSWORD` while the analytics user exists)
   is shorter than 16 characters, or `SCANTOR_ADMIN_PASSWORD` is set and shorter than 16 characters, unless
   `SCANTOR_ALLOW_INSECURE_DEFAULTS=true`. Always refuse when `SCANTOR_EDITOR_URL` has the same origin as
   `SCANTOR_PUBLIC_URL`. Only variable names are logged.
2. Connect MongoDB (replica set `rs0`, wait until primary), run migrations under the `migrations` lock,
   ensure all indexes ([data model](data-model.md)), ensure the read-only `scantor_query` user and, while
   `SCANTOR_EXPOSE_MONGO=true` or `SCANTOR_MONGO_EXPRESS_READONLY=true`, the read-only analytics user
   ([deployment](deployment.md) §4.3).
3. Initialise better-auth. Delete `jwks` keys that can no longer be decrypted with the current secret
   (after a `SCANTOR_SECRET` change), so the jwt plugin creates a new key. If no user exists, create the
   first admin from `SCANTOR_ADMIN_EMAIL` / `SCANTOR_ADMIN_PASSWORD`, otherwise generate the in-memory
   setup token (`sst_…`) and log `[setup] no users exist; open <SCANTOR_PUBLIC_URL>/setup?token=<token> to
   create the first admin` ([auth](auth.md) §7).
4. Ensure the S3 bucket `SCANTOR_S3_BUCKET`, its CORS and lifecycle rules.
5. Ensure the RabbitMQ vhost `scantor`, exchanges, global queues and their bindings ([queue](queue.md)
   §3.5; scantor defines no RabbitMQ policies).
6. Registry and Docker objects:
   - write `jwks.json` and `http-secret` (HKDF label `registry-http`, hex) atomically into the
     `scantor-registry-auth` volume (the registry's wrapper entrypoint waits for both files);
   - upsert the built-in node record (name `builtin`) and set its `tokenHash` to the SHA-256 of the
     HKDF-derived built-in node token (§9);
   - warn when a public endpoint is plaintext on a public address, which remote nodes refuse
     ([nodes](nodes.md) §11);
   - ensure the Docker network `scantor-egress` (bridge, `com.docker.network.bridge.enable_icc=false`,
     managed labels) and the volumes `scantor-workspaces` and `scantor-editor-home`, which compose does not
     create because no compose service uses them ([deployment](deployment.md) §5);
   - when `SCANTOR_IMAGE_PREFIX` is not empty, start a background pull of the editor image.
7. Start the components selected by `SCANTOR_COMPONENTS` (the reconciler begins with its boot sweeps) and
   serve container port 3000 (dashboard, `/api`, `/mcp`) and, where the `api` component runs, container
   port 3001 (editor origin).

Nitro listens on port 3000 from process start, while steps 1–6 run. Until boot completes, `/api/*`
answers 503 `unavailable` except `/api/health`, `/api/docs` and `/api/docs/openapi.json`: boot builds the
operation registry ([auth](auth.md) §5.4) from that document as its last step, through Nitro's
in-process `localFetch`.
Steps 4–6 retry their dependency for up to 60 s before failing, so a dependency that is still starting
does not end the process. Boot steps are registered by Nitro plugins (`server/plugins/00.boot.ts` for
the foundation; domain plugins `20`–`89` add their own, for example the registry files, the built-in
node and the transport warning of step 6 in `60.nodes.ts`, and the editor reaper's first sweep in
`70.editor.ts`) and run in order by `server/plugins/99.start.ts`.

Orchestrator shutdown (SIGTERM, SIGINT; compose `stop_grace_period: 30s`):

1. At the signal the components stop, in reverse start order: loops end, jobs runners requeue their
   running jobs (an interrupted build goes back to `queued`, [data model](data-model.md) §6.4), the
   ingestor stops consuming, the editor listener closes. The shutdown signal aborts first, so node offline
   detection ends at once, and API waits ([api](api.md) §1.9) and node assignments long-polls answer at
   once with the current state. A signal during boot runs no further boot step and starts no component.
2. Meanwhile Nitro's graceful shutdown stops accepting connections and drains the open requests, which
   are served normally (the API stays available until the process exits).
3. On Nitro `close` the AMQP and MongoDB clients close and the process exits 0.

Nodes and runtimes keep working while the orchestrator is away ([nodes](nodes.md) §7.4, [runtime](runtime.md)).
After the restart, offline detection first waits for its grace, so no node goes offline because its
backed-off daemon has not reported yet.

### 4.2 The `scantor` binary

One static Go binary (`CGO_ENABLED=0`, module `github.com/lonetis/scantor`, `cmd/scantor`). It is shipped in
the image `ghcr.io/lonetis/scantor` (plus `git`), bundled into the orchestrator image, released as native
binaries (darwin/linux × amd64/arm64), and injected into every container that needs the runtime.

| Role | Command | Who runs it | Where it runs |
|---|---|---|---|
| CLI | `scantor <command>` (`init`, `validate`, `dev run`, `dev debug`, `push`, `tasks …`, `revisions …`, `scans …`, `analyses …`, `export`, `exports …`, `files get`, `uploads …`, `jobs …`, `nodes …`, `templates list \| estimate`, `whoami`, `instance`, `version`) | users, CI, agents | host (native binary or docker shim `scantor.sh`), editor container |
| node daemon | `scantor node` | operators | built-in node service on the master; `docker run … ghcr.io/lonetis/scantor node` on remote nodes |
| runtime | `scantor runtime` (hidden; modes `worker`, `local`, `describe`, `check`) | node daemon (workers), task pipeline (describe/check), CLI `dev run` and test runs (local) | inside task containers at `/scantor/scantor` |
| task pipeline | `scantor task pack \| check-static \| build` (hidden; NDJSON events, structured errors `{phase, file?, line?, message}`) | orchestrator (subprocess), CLI `validate`/`push`/`dev run` | orchestrator container; user host |
| workspace helpers | `scantor workspace` (hidden) `init \| purge \| list \| read \| write-files \| delete-files \| scaffold \| extract \| git-clone \| git-pull \| commit \| discard \| snapshot` (`list` and `read` also with `--archive`: a tar.gz on stdin, no volume, used for revision snapshots). `extract` and `git-*` stage into `<userId>/.scantor-staging/<id>`; `commit` replaces a task folder atomically from staging ([editor](editor.md) §9) | workspace helper runner | throwaway helper containers (scantor image) |
| template tools | `scantor templates list \| estimate` | orchestrator (scan-size estimate), CLI | orchestrator container; user host |
| hidden developer commands | `scantor conformance` (plus `scantor conformance exec` inside the fixture container, [protocol](protocol.md) §12) and `scantor docs cli` (regenerates `docs/guide/cli.md`, also refreshes the guides' snippet includes); not shown in `--help` | `just test-conformance`, `just docs` | containers started by `just`; `conformance exec` inside the conformance fixture containers |

The binary contains no per-language switch: everything language-specific comes from
`schemas/languages.json` and the base image ENV contract (`SCANTOR_LANGUAGE`, `SCANTOR_CONNECTOR_CMD`,
`SCANTOR_CHECK_CMD`, `SCANTOR_DEBUG_CMD`, `SCANTOR_DEBUG_PORT`, `WORKDIR /task`).

Runtime injection: every consumer creates the task container with entrypoint `/scantor/scantor runtime …`,
copies its own binary to `/scantor/scantor` with `CopyToContainer`, then starts it. A consumer that is not
a linux binary of the Docker daemon's architecture (a native CLI on macOS, a cross-architecture daemon)
extracts the linux binary for the daemon's architecture once from the scantor image (below) and caches it
in the user cache directory ([tasks](tasks.md) §9.6). The connector protocol version is negotiated in
`hello`; the runtime supports protocol N and N−1.

Image references used by the binary (base images for builds, the scantor image for runtime extraction):

- Compiled-in defaults come from `internal/version`, set with `-ldflags -X` at build time: `ImagePrefix`
  and `Version`. Release builds use `ghcr.io/lonetis/` and the release version; development builds use an
  empty prefix and `dev`, so they reference `scantor-base-<base>:dev` and `scantor:dev`.
- When `SCANTOR_IMAGE_TAG` is non-empty in the environment, the pair `SCANTOR_IMAGE_PREFIX` /
  `SCANTOR_IMAGE_TAG` replaces the compiled-in pair. The orchestrator passes its own values to every
  `scantor task …` subprocess, so revisions and test runs build on exactly the base images of the
  deployment (also for images built from `main`, whose version string has no image tag). A native CLI
  normally has neither variable set and uses its own version. The docker shim `scantor.sh` always passes
  the pair of the image it runs (default `ghcr.io/lonetis/` and the release the shim was downloaded
  with), so the containerized CLI references the base images of its own version; it runs as the invoking
  user with the Docker socket's group, `HOME=/tmp` and the current directory mounted at the same path.
  `host.docker.internal` names the host for the CLI's loopback rewrite: `--add-host
  host.docker.internal:host-gateway` on Docker Desktop, and on a Linux Docker Engine `--network host` with
  `--add-host host.docker.internal:127.0.0.1`, because Docker publishes a port bound to `127.0.0.1` (the dev
  stack's `SCANTOR_BIND_ADDRESS`) only on the host's loopback, never on the gateway address.
- The reference is `<prefix><image>:<tag>` (for example `ghcr.io/lonetis/scantor-base-python:1.4.0`); the
  task pipeline pins base images by digest at build time.

### 4.3 Images

All images are defined once in `docker-bake.hcl` ([development](development.md) §10), built by GitHub
Actions and pushed to GHCR: pushes to `main` are tagged `latest` and `sha-<short>`, release tags `vX.Y.Z`
are tagged `X.Y.Z`, `X.Y` and `sha-<short>`. Dev builds use the same names without the registry prefix and
the tag `dev` (`SCANTOR_IMAGE_PREFIX` empty, `SCANTOR_IMAGE_TAG=dev`). The dev stack
(`docker-compose.dev.yml`) builds every image from source through `docker-bake.hcl`; the orchestrator's
`dev` target contains the `scantor` binary and runs Nuxt in dev mode with the source bind-mounted for hot
reload. A Go change is picked up by `just up` (a cached rebuild); host-built binaries are never mounted
([development](development.md), [deployment](deployment.md)).

| Image | Built from | Contents |
|---|---|---|
| `ghcr.io/lonetis/scantor` | root `Dockerfile` | `alpine:3.24` with the static `scantor` binary at `/usr/local/bin/scantor` (entrypoint) + `git` and CA certificates; CLI, node daemon, workspace helpers, runtime source for injection. Default user root (the node daemon needs the Docker socket); helper containers override it (§7) |
| `ghcr.io/lonetis/scantor-orchestrator` | `orchestrator/Dockerfile` | Node 26 (alpine), built Nuxt output, the `scantor` binary at `/usr/local/bin/scantor` (git operations run in workspace helpers, not here) |
| `ghcr.io/lonetis/scantor-editor` | `editor/Dockerfile` (stages `toolchain`, `editor`) | code-server 4.141.0, Go 1.27, Node 26, Python 3.14, uv, basedpyright, gopls, delve, connectors at the base-image paths, `scantor` CLI; the `toolchain` stage is reused by `.devcontainer/` |
| `ghcr.io/lonetis/scantor-base-python` | `connectors/python/Dockerfile` | Python 3.14 slim, connector + pinned deps (`PIP_CONSTRAINT`), `PYTHONHASHSEED=0`, ENV contract |
| `ghcr.io/lonetis/scantor-base-js` | `connectors/js/Dockerfile` | Node 26 slim (`node:26.12.1-trixie-slim`) plus the system CA certificates, `@scantor/connector` at `/node_modules/@scantor/connector` (compiled JavaScript, re-exports `z`), typescript and @types/node at `/node_modules`, ENV contract |
| `ghcr.io/lonetis/scantor-base-go` | `connectors/go/Dockerfile` | Go 1.27 (`golang:1.27.3-trixie`), delve, connector at `/opt/scantor/connectors/go`, `scantor-go-check`, pre-seeded `GOMODCACHE`, ENV contract |
| tests runner (`scantor-test-runner:dev`, never pushed) | `tests/docker/Dockerfile` | Playwright 1.64.1 + dockerized DinD runner ([testing](testing.md)) |
| test fixtures server (`scantor-test-fixtures:dev`, never pushed) | `tests/docker/fixtures/Dockerfile` | fixture data sources (Tranco, CrUX) and git repositories for the test stack |

Task images live in the master registry as `tasks/<taskId>:<revisionId>` and are always referenced by
digest (`tasks/<taskId>@sha256:…`). Build arg `SCANTOR_BASE` is the base image pinned by digest at build
time and recorded on the revision.

### 4.4 Infrastructure services (master)

| Service | Image | Role |
|---|---|---|
| mongo | `mongo:9.0` | Single-node replica set `rs0` with keyFile (transactions for better-auth, change streams). Started with `--noscripting`, without a slow-operation log (`--slowOpSampleRate 0`) and with a bounded WiredTiger cache. App database `SCANTOR_MONGO_DB`. |
| rabbitmq | `rabbitmq:4.4-management` | vhost `scantor` (default queue type quorum), per-scan quorum queues, native delayed delivery for retries, memory and disk limits from env, `max_message_size` 4 MiB, the management plugin only (no unauthenticated Prometheus endpoint on `scantor-sandbox`). |
| rustfs | `rustfs/rustfs:1.0.3` | S3 API (bucket `SCANTOR_S3_BUCKET`, private) for snapshots, build logs, files, exports, uploads; console for admins. |
| registry | `registry:3.1.2` | CNCF distribution with native token auth (realm `${SCANTOR_PUBLIC_URL}/api/registry/token`, service `scantor-registry`, issuer `scantor`, JWKS from the shared volume), `REGISTRY_HTTP_SECRET` from the derived `http-secret` file, storage delete enabled (task deletion removes manifests; blobs are reclaimed by registry GC). |
| mongo-express | `mongo-express:1.0.2-20-alpine3.19` | Read-only DB browser, connected as the read-only analytics user (root only with `SCANTOR_MONGO_EXPRESS_READONLY=false`), bound to `SCANTOR_ADMIN_BIND_ADDRESS`, behind Traefik forwardAuth when Traefik is on ([deployment](deployment.md) §4.7). |
| traefik | `traefik:v3.7` | Optional (compose profile `traefik`): TLS termination, HTTP routers and TCP HostSNI routers (AMQPS, optional Mongo) on :443, forwardAuth for admin GUIs ([deployment](deployment.md)). |
| node | scantor image, command `scantor node` | The built-in node daemon (Docker socket, `SCANTOR_NODE_BUILTIN=true`). |
| orchestrator | `scantor-orchestrator` | Docker socket (builds, helpers, editors, test runs, registry GC exec), all infra credentials; container ports 3000 (dashboard) and 3001 (editor origin). |

The orchestrator connects with `SCANTOR_MONGO_URL` (host part, no credentials) as `SCANTOR_MONGO_USER` /
`SCANTOR_MONGO_PASSWORD` (database `SCANTOR_MONGO_DB`), the RabbitMQ admin user
`SCANTOR_RABBITMQ_USER` / `SCANTOR_RABBITMQ_PASSWORD` (AMQP on `SCANTOR_AMQP_INTERNAL_URL`, management API on
`SCANTOR_RABBITMQ_MANAGEMENT_URL`) and the RustFS root keys `SCANTOR_S3_ACCESS_KEY` / `SCANTOR_S3_SECRET_KEY`
(endpoint `SCANTOR_S3_INTERNAL_URL`). It calls the registry HTTP API itself at `http://registry:5000` (the
fixed service name on network `scantor`; never `localhost:${SCANTOR_REGISTRY_PORT}`, which inside the
orchestrator container is the container itself, and never `SCANTOR_REGISTRY_PUBLIC_HOST`) with tokens of its
`orchestrator` credential ([auth](auth.md) §10.4), for the manifest deletes of the `taskDelete` job and for
catalog access. Pushes go through the host Docker daemon to `localhost:${SCANTOR_REGISTRY_PORT}`
(§11.1). Service-side variables of the infrastructure images are defined in
[deployment](deployment.md).

### 4.5 Named volumes with fixed names

| Volume | Created by | Mounted into | Purpose |
|---|---|---|---|
| `scantor-workspaces` | orchestrator boot | editors and workspace helpers (volume subpath `<userId>` only); whole only into `init`/`purge` helpers; never into the orchestrator | user workspaces (`<userId>/<taskName>/`, staging `<userId>/.scantor-staging/`) |
| `scantor-editor-home` | orchestrator boot | editors (subpath `<userId>` at `/home/coder`); whole only into `init`/`purge` helpers | per-user editor home (settings, shell history, caches) |
| `scantor-editor-sockets` | compose | orchestrator (whole), each editor (subpath `<userId>`) | code-server unix sockets |
| `scantor-registry-auth` | compose | orchestrator (rw), registry (ro) | `jwks.json` and `http-secret` (both derived, rewritten at every boot) |
| data volumes | compose | mongo, rabbitmq, rustfs, registry | persistent state ([deployment](deployment.md) §5) |

Docker requires a volume subpath to exist before it can be mounted; the `init` helper creates the
`<userId>` directories (1000:1000, mode 0700) before a user's first helper or editor start.

## 5. Repository layout

Flat layout; Go module at the repo root.

```
.
├── go.mod, go.sum              Go module github.com/lonetis/scantor (binary + internal packages)
├── embed.go                    package scantor: //go:embed of schemas/, scaffolds/, docs/guide/
├── Dockerfile                  image ghcr.io/lonetis/scantor (static binary + git)
├── docker-bake.hcl             the single image build definition (used by just, the test runner and CI)
├── cmd/scantor/                main package: cobra root command
├── internal/
│   ├── cli/                    CLI commands (cobra), output formats (-o json), exit codes
│   ├── node/                   node daemon: hello, assignments long-poll, container reconcile, status, egress helper
│   ├── runtime/                worker/local/describe/check runtime; shared types at the root, sub-packages
│   │                           bootstrap, amqpx, pool, runner, scheduler, worker, local, describe, check, pipeline,
│   │                           scerr, logtail, upload, canonical, dind ([runtime](runtime.md) §1.3)
│   ├── templates/              registry.go, core/ (interface, definitions), fetch/ (HTTP policy), one package per
│   │                           template (single, list, range, repeat, tranco, crux, cidr), templatestest/ (fakes)
│   ├── taskpipe/               pack, check-static (manifest + Dockerfile policy in taskpipe/dockerfile via the
│   │                           BuildKit parser), build, describe, check, push, local mode for dev run
│   ├── workspace/              workspace helper operations (init, extract, write-files, scaffold, git-*, commit, snapshot, ...)
│   ├── protocol/               connector protocol message types and codec
│   ├── conformance/            connector conformance harness and testdata/<language>/<fixture>/ task folders
│   │                           (fixtures run in the language's base image)
│   ├── api/                    typed client and wire types for /api/* (user, /api/node, /api/runtime); transport policy
│   ├── manifest/               scantor.yaml parsing and validation
│   ├── languages/              schemas/languages.json loader
│   ├── schema/                 JSON Schema validation with defaults for the CLI (dev run configs)
│   ├── container/              moby client helpers: runtime injection, managed labels, hardening profile
│   ├── keys/                   HKDF derivation shared with the orchestrator (built-in node token; shared test vectors)
│   ├── redact/                 log redaction shared by CLI, node daemon and runtime (headers, token shapes)
│   ├── envconf/                shared parsers for the env value syntax of §10; one LoadConfig per component
│   ├── deps/                   tools.go (build tag `tools`): pins modules before their first import
│   └── version/                Version, Commit, ImagePrefix (set with -ldflags -X), ImageRef
├── connectors/
│   ├── python/                 Python connector (pydantic v2) + Dockerfile → scantor-base-python
│   ├── js/                     @scantor/connector (zod v4) for TS and JS + Dockerfile → scantor-base-js
│   └── go/                     Go connector (separate small module) + Dockerfile → scantor-base-go
│                               (each Dockerfile has its own Dockerfile.dockerignore, [development](development.md) §10)
├── scaffolds/{python,typescript,javascript,go}/   task starters (go.mod/go.sum stored as *.tmpl)
├── tasks/                      example tasks (echo, sleep, power, throws, files, origins, …); together they cover
│                               every language of schemas/languages.json and every template ([testing](testing.md))
├── schemas/
│   ├── task-manifest.schema.json
│   ├── describe.schema.json    describe output (revisions.description)
│   ├── languages.json          the language table
│   ├── managed-labels.json     managed label key set shared by Go internal/container and TS server/utils/labels.ts
│   ├── protocol/*.json         connector protocol message schemas
│   ├── messages/*.json         AMQP message bodies (analysis, result, attempt)
│   └── templates/<name>.json, <name>.fixtures.json
├── orchestrator/               Nuxt 4 + Nuxt UI 4 app
│   ├── app/                    UI (pages, components, composables)
│   ├── server/api/             REST routes, one file per method
│   ├── server/routes/          /mcp, /.well-known/*
│   ├── server/middleware/      request id and client IP, security headers, body caps, principal resolution
│   ├── server/plugins/         00.boot (foundation boot steps, §4.1), 10.components, 20–89 domain plugins (their
│   │                           boot steps and component tasks; 20.editor-listener on port 3001, 30.tasks,
│   │                           40.scans, 50.results, 60.nodes, 70.editor), 99.start (runs the boot, starts
│   │                           SCANTOR_COMPONENTS), csp.ts (CSP render hook, [ui](ui.md) §13)
│   ├── server/services/        domain logic per area: scans, tasks, revisions, test-runs, analyses, exports,
│   │                           ingestor, reconciler, placement, nodes, runtime, registry, jobs, pipeline, helpers,
│   │                           editor, tools, query, metrics, mcp, … ([development](development.md) §7)
│   ├── server/utils/           config, errors, zod helpers, pagination, principal, operations, authz (ownership
│   │                           helpers), keys, secrets, redact, startup-guard, mongo, s3, amqp, labels, boot, jobs,
│   │                           locks, …
│   ├── shared/                 types, zod request schemas and utilities shared by app and server
│   ├── test/                   vitest unit tests (paths mirror server/, [testing](testing.md) §1) and opt-in
│   │                           *.integration.test.ts
│   └── Dockerfile, Dockerfile.dockerignore
├── editor/                     Dockerfile (toolchain + editor stages), Dockerfile.dockerignore, extensions.txt,
│                               machine-settings.json, entrypoint.sh
├── traefik/dynamic/            Traefik file-provider directory, mounted at /etc/traefik/dynamic; empty by default
│                               (tests add a default certificate there, [deployment](deployment.md))
├── tests/                      dockerized Playwright suites and shared test data ([testing](testing.md) §2)
│   ├── api/, ui/, e2e/, mcp/, authz/, security/, chaos/   Playwright specs
│   ├── corpora/                shared data tables also read by Go and vitest unit tests (Dockerfile policy, tar-slip,
│   │                           paths, query injection, hostile labels, keys-vectors.json = shared HKDF vectors)
│   ├── fixtures/tasks/<name>/  test-only tasks
│   ├── docker/                 runner image, entrypoint, stack override, fixtures server
│   ├── scripts/                test-index, terminology, compose and .env.example lint (test-index.mjs,
│   │                           check-terms.mjs, lint-compose.mjs, lint-env.mjs)
│   └── FEATURES.md, TESTS.md
├── docs/                       internal docs (this file); linked from CLAUDE.md
│   └── guide/                  user guides (authoring per language, templates, manifest, errors & retries, CLI, MCP, remote nodes); linked from README
├── skills/                     thin agent skills
├── .claude-plugin/             marketplace.json (skills plugin); .mcp.json at the repo root
├── .devcontainer/              devcontainer.json (editor toolchain stage + docker-in-docker), post-create.sh
├── .github/workflows/          image builds (GHCR), release binaries, test suite
├── docker-compose.dev.yml      dev stack (hot reload)
├── docker-compose.prod.yml     prod stack (GHCR images)
├── docker-compose.tests.yml    dockerized test runner
├── justfile                    contributor recipes (every recipe runs its tools in containers)
├── scantor.sh                  docker shim for the CLI
├── .env.example                the only documentation of environment variables
├── README.md, CLAUDE.md
```

There is no `images/` directory: each Dockerfile lives with its component.

## 6. Networks and trust zones

### 6.1 Docker networks

```
                         Internet / LAN
                              │
              host ports bound to SCANTOR_BIND_ADDRESS / SCANTOR_ADMIN_BIND_ADDRESS
              (or Traefik :443 when the traefik profile is on)
                              │
┌──────────────────────────── network: scantor (internal compose network) ─────────────────────────┐
│ orchestrator   mongo   rabbitmq   rustfs   registry   mongo-express   traefik   node (built-in)  │
└───────┬──────────────────────┬────────┬──────────────────────────────────────────────────────────┘
        │ (also attached)      │        │
┌───────▼──────────────────────▼────────▼────── network: scantor-sandbox ─────────────────────────┐
│ orchestrator (alias orchestrator)  rabbitmq (alias rabbitmq)  rustfs (alias rustfs)              │
│ master workers scantor-w-*      editors scantor-editor-*                                         │
│ NOT attached: mongo, mongo-express, registry, traefik, node daemon                               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌──── network: scantor-egress (created at orchestrator boot; bridge, enable_icc=false, no services) ┐
│ git workspace helpers (scantor-h-*)      test-run containers (scantor-t-*)                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
  network none:  workspace helpers except git ops (scantor-h-*), describe/check containers (scantor-b-*)
  BuildKit RUN steps: the daemon's build network (egress deny list applies)
  code-server: no network listener at all (unix socket in scantor-editor-sockets)

Remote node host:
┌──── network: scantor-workers (created by the node daemon; bridge, enable_icc=false) ─────────────┐
│ remote workers scantor-w-*  → outbound only to SCANTOR_PUBLIC_URL, AMQP/S3 public URLs, internet │
│ workers of different scans and users on one node cannot reach each other                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Networks that scantor creates itself (`scantor-egress`, `scantor-workers`) carry the managed labels with
`scantor.kind=network`; nothing deletes them automatically.

Every node applies the egress deny list `SCANTOR_NODE_EGRESS_DENY` (cloud metadata ranges) with a one-shot
`NET_ADMIN` host-network helper on the `DOCKER-USER` chain. It is best effort: when it cannot be applied
the daemon logs a warning and reports `egressDenyApplied: false` ([nodes](nodes.md)).

### 6.2 Trust zones

| Zone | Members | Trusted with |
|---|---|---|
| **Z0 platform core** | orchestrator, mongo, rabbitmq (admin), rustfs (root keys), registry, built-in node daemon | everything; both orchestrator and node daemon hold the host Docker socket (root on the master) |
| **Z1 admin tools** | mongo-express, RabbitMQ management, RustFS console, Traefik dashboard | admin-only via forwardAuth `scantor_tools` cookie plus their own credentials; bound to `SCANTOR_ADMIN_BIND_ADDRESS` without Traefik |
| **Z2 user code, master** | master workers, editors, test-run containers, describe/check containers, BuildKit RUN steps, workspace helpers | only their own scan's credentials (per-scan AMQP user, presigned URLs, worker token) or the owner's editor API key; never infra root credentials |
| **Z3 remote node** | remote node daemon and its workers | a node sees everything about the scans placed on it (configs including secrets, worker tokens, per-scan AMQP credentials); only add nodes you trust like the master |
| **Z4 users** | browsers, CLI, MCP clients | their own resources; admins everything |

### 6.3 Reachability

`net` = reachable at network level; `cred` = additionally requires credentials the source has; `–` = not
reachable.

| From ↓ / to → | orchestrator HTTP | mongo | rabbitmq AMQP | rabbitmq mgmt | rustfs S3 | registry | host Docker | internet |
|---|---|---|---|---|---|---|---|---|
| browser / CLI / MCP | public URL, user principal | – (opt-in TCP route, read-only user) | – | admin tools only | presigned GET only (public URL) | – | – | – |
| orchestrator | – | cred (app user + `scantor_query`) | cred (admin) | cred (admin) | cred (root keys) | cred (orchestrator credential) | socket | yes |
| built-in node daemon | `SCANTOR_INTERNAL_URL`, node principal | – | – | – | – | via host daemon at `localhost:${SCANTOR_REGISTRY_PORT}`, node principal | socket | via daemon (GHCR pulls) |
| master worker | `SCANTOR_INTERNAL_URL`, worker principal (`/api/runtime/*` only) | – | cred (`scan-<scanId>`) | net only (untagged users get 401) | presigned PUT only | – | – | yes, minus deny list |
| editor | `SCANTOR_INTERNAL_URL`, owner's `editor` API key | – | net only | net only | net only | – | – | yes |
| test-run container | – | – | – | – | – | – | – | yes, minus deny list |
| git workspace helper | – | – | – | – | – | – | – | yes (https only) |
| other workspace helpers, describe/check | – | – | – | – | – | – | – | – |
| remote node daemon | `SCANTOR_PUBLIC_URL`, node principal | – | – | – | – | `SCANTOR_REGISTRY_PUBLIC_HOST`, node principal | its local socket | yes |
| remote worker | `SCANTOR_PUBLIC_URL`, worker principal | – | cred via `SCANTOR_AMQP_PUBLIC_URL` | – | presigned PUT via `SCANTOR_S3_PUBLIC_URL` | – | – | yes, minus deny list |

Host-published ports bind to `SCANTOR_BIND_ADDRESS` (dashboard `SCANTOR_PORT` → orchestrator container
port 3000, editor origin `SCANTOR_EDITOR_PORT` → orchestrator container port 3001, AMQP
`SCANTOR_AMQP_PORT`, S3 `SCANTOR_S3_PORT`, registry `SCANTOR_REGISTRY_PORT`) or to
`SCANTOR_ADMIN_BIND_ADDRESS` (mongo, mongo-express, RabbitMQ management, RustFS console).
`SCANTOR_BIND_ADDRESS` must include loopback, because the master's host Docker daemon pushes to and pulls
from `localhost:${SCANTOR_REGISTRY_PORT}`. With Traefik, public traffic enters only through :443
([deployment](deployment.md) §1); the Traefik editor router targets container port 3001. The dashboard
listener answers 421 for the editor host and the editor listener answers 421 for every other host.

Remote transport must be TLS unless every resolved address of the host is loopback, RFC 1918, CGNAT
(`100.64.0.0/10`, private overlays such as WireGuard/Tailscale) or IPv6 ULA (`fc00::/7`), or
`SCANTOR_ALLOW_INSECURE_TRANSPORT=true`; the check runs on the actual peer address. A custom CA is
supplied with `SCANTOR_CA_CERT` ([nodes](nodes.md) §11).

## 7. Container inventory

Every container scantor creates gets managed labels from one function (Go `internal/container`
`ManagedLabels()`, TS `server/utils/labels.ts` `managedLabels()`, both reading the key set from
`schemas/managed-labels.json`), which override image labels: `traefik.enable=false`,
`com.docker.compose.project=scantor-managed`, `com.docker.compose.service=`, `scantor.managed=true`,
`scantor.kind=<kind>` (the container kinds below, plus `network` for the networks scantor creates, §6.1) and
identity labels (`scantor.worker`, `scantor.scan`, `scantor.user`, `scantor.node`,
`scantor.spec-hash`, and `scantor.op` on helpers). Static validation rejects image `LABEL` keys matching
`^(traefik\.|com\.docker\.compose\.|scantor\.)` and keys containing `$`; a post-build check applies the same
pattern to inherited labels ([security](security.md) §6.1). Containers are identified only by labels
scantor set **and** their name prefix.

| Kind (`scantor.kind`) | Name | Created by | Image | User / privileges | Network |
|---|---|---|---|---|---|
| `worker` | `scantor-w-<workerId>` | node daemon | task image by digest + injected runtime | image user; worker hardening profile ([nodes](nodes.md) §6.3) | `scantor-sandbox` (built-in) / `scantor-workers` (remote) |
| `helper` | `scantor-h-<uuid>` | workspace helper runner | scantor image | 1000:1000, `CapDrop ALL`, read-only rootfs, subpath `<userId>` of `scantor-workspaces` only (`list`/`read --archive`: no volume). `init`/`purge`: 0:0 with `CapAdd` `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, the whole `scantor-workspaces` and `scantor-editor-home` volumes; they create or remove one validated `<userId>` directory and never read content | none; `scantor-egress` for `git-clone`/`git-pull` |
| `build` | `scantor-b-<uuid>` | task pipeline (describe/check); runtime-binary extraction ([tasks](tasks.md) §9.6: created, never started, removed after `CopyFromContainer`) | task or draft image + injected runtime; the scantor image for extraction | worker hardening profile, never privileged | none |
| `testRun` | `scantor-t-<testRunId>` | jobs runner (`testRun`) | draft image + injected runtime | worker hardening profile, never privileged | `scantor-egress` |
| `editor` | `scantor-editor-<userId>` | editor manager | scantor-editor | 1000:1000, `CapDrop ALL`, read-only rootfs, no Docker socket ([editor](editor.md) §4) | `scantor-sandbox` |
| `egressHelper` | `scantor-netpol-<nodeId>` | node daemon (one-shot) | the daemon's own scantor image | 0:0, `CapDrop ALL` + `CapAdd` `NET_ADMIN`, `NET_RAW`, read-only rootfs; tmpfs `/run`, bind `/run/xtables.lock` when present ([nodes](nodes.md) §9) | host |

Test-only containers: the test suite and `just test-go-integration` create containers named
`scantor-test-*` with the label `scantor.test=true` (dev tooling uses `scantor.dev=true`). They are swept by
the test runner's cleanup phase and by `just prune` ([testing](testing.md) §7.4,
[development](development.md) §4), never by the orchestrator or node daemons.

## 8. Endpoint profiles

The orchestrator computes every URL handed to a node or worker from the node's `endpointProfile`.
Presigned S3 URLs are signed for the profile's S3 endpoint (presigning is offline; the Host header must
reach RustFS unchanged).

| Purpose | `internal` (built-in node) | `public` (remote nodes) |
|---|---|---|
| Orchestrator API for daemon and runtime (`SCANTOR_URL` in worker env) | `SCANTOR_INTERNAL_URL` | `SCANTOR_PUBLIC_URL` |
| AMQP for workers (`bootstrap.amqp.url`) | `SCANTOR_AMQP_INTERNAL_URL` | `SCANTOR_AMQP_PUBLIC_URL` |
| S3 for presigned PUT | `SCANTOR_S3_INTERNAL_URL` | `SCANTOR_S3_PUBLIC_URL` |
| Registry host in image refs (daemon side) | `localhost:${SCANTOR_REGISTRY_PORT}` | `SCANTOR_REGISTRY_PUBLIC_HOST` |
| Registry token realm (fixed in registry config) | `${SCANTOR_PUBLIC_URL}/api/registry/token` | same |

Browsers always receive public URLs (`SCANTOR_PUBLIC_URL`, `SCANTOR_EDITOR_URL`, `SCANTOR_S3_PUBLIC_URL`).
The editor and the CLI inside it use `SCANTOR_INTERNAL_URL`.

## 9. Identity, credentials and key derivation

Summary; the full model is in [auth](auth.md) and [security](security.md).

| Principal | Presented as | Accepted on | Stored |
|---|---|---|---|
| user / session | cookie `scantor.session_token` (`__Secure-scantor.session_token` on https origins); host-only | `/api/*` except machine prefixes; mutations need a trusted `Origin` | better-auth `session` |
| user / API key | `x-api-key` or `Authorization: Bearer` with `sk_scantor_…` (configId `default`) or `sk_scantor_editor_…` (configId `editor`, never admin power) | same as session, and `/mcp`; rejected on `/api/auth/*` | better-auth `apikey` (hashed) |
| user / MCP | `/mcp` accepts OAuth access tokens (audience `<SCANTOR_PUBLIC_URL>/mcp`) and API keys. Each tool call reaches the REST API with header `x-scantor-internal-auth: sic_…`: single use, 60 s, accepted only from loopback peers and bound to one method + path | same as session; MCP level-filtered | memory |
| node | `Authorization: Bearer snt_…`; Basic `node:snt_…` on the registry token endpoint | `/api/node/*`, `/api/registry/token` | `nodes.tokenHash` (SHA-256) |
| worker | `Authorization: Bearer swt_<workerId>.<mac>` | `/api/runtime/*` | nothing (HMAC-derived) |
| registry orchestrator credential | Basic `orchestrator:<derived>` | `/api/registry/token` | nothing (HKDF-derived) |
| tools | cookie `scantor_tools` (HS256 JWT, `Domain=SCANTOR_DOMAIN`) | `/api/tools/forward-auth` | nothing |
| setup | header `X-Scantor-Setup-Token: sst_…` | `/api/setup/*` mutations | memory (regenerated per boot) |
| editor | cookie `scantor_editor=v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>` (host-only on the editor origin, 12 h, bound to `editors.startedAt`, [editor](editor.md) §8.4), obtained with a single-use one-time code `sec_` + base64url(32 random bytes), valid 60 s | editor listener only | nothing (HMAC-signed); one-time codes in memory |

MCP OAuth access tokens are never accepted on `/api/*`; requests to `/api/auth/*` that carry an API key are
rejected with 401, so a key can never become a better-auth session ([auth](auth.md) §5.2).

All internal keys derive from `SCANTOR_SECRET`:
`key(label) = HKDF-SHA256(ikm = UTF-8(SCANTOR_SECRET), salt = UTF-8("scantor-v1"), info = UTF-8(label), L = 32 bytes)`.
TS (orchestrator) and Go (`internal/keys`) implement exactly this function.

| Label | Used for |
|---|---|
| `better-auth` | better-auth `secret` (hex-encoded) |
| `registry-signing` | ES256 registry token signing key: P-256 private scalar `d = (k mod (n − 1)) + 1`, with `k` the 32-byte HKDF output read as a big-endian integer and `n` the order of P-256; JWKS `kid` = `scantor-` + first 16 hex chars of SHA-256 of the uncompressed public point |
| `registry-push` | password of the registry `orchestrator` credential (base64url); handed to `scantor task build --push` as `SCANTOR_REGISTRY_PUSH_PASSWORD` (§10) |
| `registry-http` | `REGISTRY_HTTP_SECRET` of the registry (hex), written to `scantor-registry-auth/http-secret` and exported by the registry's wrapper entrypoint |
| `worker-token` | `swt_<workerId>.base64url(HMAC-SHA256(key, workerId + "\n" + scanId + "\n" + role + "\n" + nodeId))` |
| `amqp` | per-scan RabbitMQ password `base64url(HMAC-SHA256(key, scanId))` |
| `credentials` | AES-256-GCM encryption of git credentials |
| `config-secrets` | AES-256-GCM encryption of `writeOnly` task/scan config values |
| `tools-cookie` | HS256 key of the `scantor_tools` JWT |
| `editor-cookie` | HMAC key of the `scantor_editor` cookie |
| `builtin-node` | built-in node token `snt_` + base64url(key) |
| `mongo-query` | password of the read-only MongoDB user `scantor_query` (base64url) |

TS (`server/utils/keys.ts`) and Go (`internal/keys`) are tested against the shared vectors in
`tests/corpora/keys-vectors.json` (raw HKDF outputs plus every derived credential format, [auth](auth.md)
§3).

Changing `SCANTOR_SECRET` invalidates sessions, MCP OAuth tokens (undecryptable `jwks` keys are deleted at
boot), worker tokens, the registry signing key and HTTP secret (restart the registry), the tools and editor
cookies, the built-in node token and every encrypted git credential and config secret (API keys and node
tokens are stored as hashes and survive); it is a disaster-recovery operation ([security](security.md) §10).

## 10. Configuration conventions

- Every variable is documented with its default only in `.env.example`; docs name variables but never
  document their defaults. Dev secrets end in `-insecure-dev`; `just init` replaces them with random values.
  CLI variables (credentials and mode selectors) have their own CLI section, which also lists by name the
  other variables the CLI reads (a dotenv key appears once, in its primary section), and test-only
  `SCANTOR_TEST_*` variables have a Tests section there (`SCANTOR_TEST_RUN_*` are settings of the test-run
  feature, i.e. platform configuration, not test-only variables).
  Internal contract variables that scantor sets for its own children (`SCANTOR_WORKER_TOKEN`, `SCANTOR_DIND`,
  `SCANTOR_REGISTRY_PUSH_PASSWORD`) are not configuration and are never set in `.env`. The
  `docker-bake.hcl` build arguments (`IMAGE_PREFIX`, `IMAGE_TAG`, `VERSION`, `COMMIT`) are not runtime
  configuration either and are documented only in [development](development.md).
- Booleans: `true` / `false`. Lists: comma-separated, whitespace trimmed, empty entries dropped.
- Durations: Go duration syntax (`500ms`, `30s`, `15m`, `24h`), parsed identically by TS and Go. Retention
  periods that map onto TTL indexes or S3 lifecycle rules are whole days in `*_DAYS` integer variables;
  every other time value is a duration (never an integer `*_MS` variable).
- Byte sizes: a non-negative integer with an optional binary suffix `KiB`, `MiB`, `GiB`, `TiB`.
- Invalid values for security-relevant variables abort startup; other invalid values log a warning and fall
  back to the default.
- The orchestrator reads variables only in `server/utils/config.ts`; each Go component has exactly one
  `LoadConfig` built on `internal/envconf`. No other code reads the environment.
- Which variables each Go role reads:

| Role | Variables |
|---|---|
| CLI | credentials `SCANTOR_URL`, `SCANTOR_TOKEN` (the only credential source: no login command, no credentials file); `SCANTOR_CA_CERT` (custom CA for `SCANTOR_URL`); mode selectors `SCANTOR_DEV_MODE` (`local`\|`remote`) and `SCANTOR_WORKSPACE` (set in the editor: inside this tree `scantor push` only publishes); for local builds and runs (`validate`, `dev run`, `dev debug`) the optional overrides `SCANTOR_TRANCO_URL`, `SCANTOR_CRUX_URL` (template data sources), `SCANTOR_IMAGE_PREFIX` + `SCANTOR_IMAGE_TAG` (image references, §4.2) and `SCANTOR_MAX_WORKERS_PER_SCAN`, `SCANTOR_MAX_PROCESSES_PER_WORKER` (manifest rule M8, [tasks](tasks.md) §3.2). The CLI section of `.env.example` lists them all |
| task pipeline (`scantor task …`, `scantor templates …`) | the CLI overrides above plus the pipeline limits of [tasks](tasks.md) §9.10, `SCANTOR_PUBLIC_URL` and `SCANTOR_REGISTRY_PUBLIC_HOST` (registry hosts rejected by Dockerfile rule D5, [tasks](tasks.md) §8.2; a native CLI leaves them unset and the server re-checks on publish) and, for `--push` only, `SCANTOR_REGISTRY_PUSH_PASSWORD`: the derived password of the registry `orchestrator` credential (HKDF label `registry-push`, §9). The subprocess never receives `SCANTOR_SECRET` (least privilege). `SCANTOR_REGISTRY_PUSH_PASSWORD` is an internal contract set only by the orchestrator, like `SCANTOR_WORKER_TOKEN`, and is not configuration. The orchestrator passes its own values to every subprocess; a native CLI leaves them unset and the binary uses compiled-in defaults equal to the `.env.example` defaults |
| node daemon | `SCANTOR_URL`, `SCANTOR_NODE_TOKEN` or (built-in node) `SCANTOR_NODE_BUILTIN=true` + `SCANTOR_SECRET`, the daemon variables of [nodes](nodes.md) §2 (`SCANTOR_NODE_MAX_WORKERS`, `_DIND`, `_EGRESS_DENY`, `_PIDS_LIMIT`, `_SHM_SIZE`, `_NOFILE`, `_WORKER_LOG_MAX_SIZE`, `_WORKER_LOG_MAX_FILES`, `_IMAGE_RETENTION`, `_PULL_TIMEOUT`; `SCANTOR_NODE_OFFLINE_AFTER`, `_STATUS_INTERVAL`, `_ASSIGNMENTS_WAIT` and `_MIN_FREE_DISK` are orchestrator variables delivered in the hello `config`), `SCANTOR_CA_CERT`, `SCANTOR_ALLOW_INSECURE_TRANSPORT`, `SCANTOR_LOG_LEVEL`, `SCANTOR_LOG_FORMAT` ([nodes](nodes.md) §2); everything else comes from the hello response and the assignments |
| runtime | only what the node daemon puts into the worker environment (`SCANTOR_URL`, `SCANTOR_WORKER_TOKEN`, optional `SCANTOR_CA_CERT` and `SCANTOR_ALLOW_INSECURE_TRANSPORT`, and `SCANTOR_DIND=1` on DinD workers) plus the base-image ENV contract; everything else comes from `/api/runtime/bootstrap` (worker mode) or the local spec (local mode) |

## 11. Flows

Route names refer to [api](api.md); collections and states refer to [data model](data-model.md); queue
objects refer to [queue](queue.md).

### 11.1 Authoring → workspace → test run → revision publish

```
 scaffold ─┐
 git import ┼──► workspace/<userId>/<taskName>/ ──► test run (draft image, local mode) ──► publish ──► revision ready
 upload/push┘          ▲ editor / MCP file tools / CLI push
```

1. **Create from scaffold** (UI wizard, MCP `create_task`, `POST /api/tasks {name, language, template}`):
   the API inserts the `tasks` doc (`source.kind=scaffold`) and runs helpers `init` (once per user) and
   `scantor workspace scaffold --task <n> --language <l> --template <t> [--description <d>]`, which renders
   the embedded scaffold into `<userId>/<name>/` and returns the workspace summary. The response includes
   the cached workspace pack hash.
2. **Import from git** (`POST /api/tasks/import-git {url, ref, path, credentialId?, select?}`): https only,
   no userinfo, private/loopback hosts rejected (and the validated address pinned) unless
   `SCANTOR_GIT_ALLOW_PRIVATE=true`. Helper `git-clone` on `scantor-egress` fetches shallow into
   `<userId>/.scantor-staging/<id>` (no submodules, hooks or redirects; the token passed only via
   `GIT_CONFIG_*` env) and lists every `scantor.yaml` under `path`. One valid manifest → imported; several →
   returned as candidates until `select` is given. Each selected folder is moved in with `commit --from
   <path> --expect absent`; the task records `source.git {url, ref, path, credentialId?, commit,
   packSha256, pulledAt}` and `workspace.lastSyncSha256 = packSha256`. **Pull**
   (`POST /api/tasks/{task}/git/pull`, helper `git-pull`) is fast-forward only: 409 `gitDiverged` when the
   workspace hash differs from `source.git.packSha256` (local changes since the last import/pull) or the
   remote history is not a fast-forward, unless `force`. Otherwise `commit` replaces the folder and
   `source.git.{commit, packSha256, pulledAt}` and `workspace.lastSyncSha256` are updated. Pull never
   publishes ([tasks](tasks.md) §14, [editor](editor.md) §9.7).
3. **Upload / push** (`POST /api/tasks/upload`, CLI `scantor push`): the tar.gz streams (cap
   `SCANTOR_TASK_MAX_PACK_BYTES`) into helper `extract`, which extracts into a staging directory and enforces
   the archive rules (no absolute paths, `..`, NUL, backslashes; regular files and directories only; at
   most `SCANTOR_TASK_MAX_FILES` files, `SCANTOR_TASK_MAX_BYTES` uncompressed and
   `SCANTOR_WORKSPACE_MAX_BYTES` per user) and reports the manifest. The task is found or created by
   manifest `name`. Conflict rule ([tasks](tasks.md) §13): there is **no conflict** when the task folder does
   not exist, or when the current workspace hash equals the uploaded hash, `latestRevision.packSha256` (any
   state) or `tasks.workspace.lastSyncSha256`; otherwise the call fails with 409 `workspaceDirty` unless
   `force=true`. Helper `commit --expect <current hash>` then replaces the folder atomically (a concurrent
   edit between check and commit still fails), `workspace.lastSyncSha256` becomes the uploaded hash, and a
   revision is published unless `publish=false`. Inside the editor, `scantor push` detects
   `SCANTOR_WORKSPACE` and only publishes.
4. **Edit**: in the editor (code-server behind the editor listener on `SCANTOR_EDITOR_URL`, workspace
   mounted read-write), through MCP/REST file routes (`writeTaskFiles`, `deleteTaskFile`; helpers
   `write-files`/`delete-files`), or locally followed by push. Editor and file-route writes never change
   `lastSyncSha256`. The UI shows "unpublished changes" when the workspace pack hash differs from
   `latestRevision.packSha256` (the last published content, whatever its build outcome).
5. **Test run** (`POST /api/tasks/{task}/test-runs`, MCP `test_task`, CLI `scantor dev run --remote`,
   automatic in the editor via `SCANTOR_DEV_MODE=remote`; outside the editor the CLI first syncs the
   folder with `uploadTask?publish=false`): creates a `testRuns` doc and a `testRun` job. The job streams the
   helper `snapshot` into `scantor task build - --tag tasks/<taskId>:draft-<packSha256> --skip-check
   --reuse-existing --expect-name <task> [--allow-privileged]` without push (`--allow-privileged` is
   passed iff the owner has `canRunPrivileged`, as for revision builds; the test-run container itself is
   never privileged): static checks and describe always run, the image
   build is skipped when the content-addressed draft image already exists (`draftImage.cached`), and the
   type check is skipped. The job validates the inputs with ajv against the described schemas (failures:
   BuildErrors with phase `config`), then runs one container `scantor-t-<testRunId>` on `scantor-egress`
   with `scantor runtime local --spec /scantor/in/spec.json` ([runtime](runtime.md) §15): the manifest's
   per-process resources, `processes=1` and a total timeout (`SCANTOR_TEST_RUN_TIMEOUT`). Results, structured
   errors (a scheduling failure is a BuildError with phase `schedule`), logs and files are stored
   (`testRunAnalyses`, S3 `test-runs/<id>/…`, files fetched with `CopyFromContainer` from `/scantor/out`)
   and streamed over SSE (`GET /api/test-runs/{id}/stream`). `wait` on the POST/GET returns when the test
   run settles. Draft images are never pushed and are removed after `SCANTOR_DRAFT_IMAGE_RETENTION`.
6. **Publish** (`POST /api/tasks/{task}/revisions`, MCP `publish_revision`, and `uploadTask` unless
   `publish=false`): the request takes the snapshot **synchronously** ([tasks](tasks.md) §10). Helper
   `snapshot` streams the pack into S3 under a temporary key `tmp/snapshots/<uuid>.tar.gz` while the
   orchestrator hashes the uncompressed stream and checks it against the helper's `summary.packSha256`.
   When a `queued`, `building` or `ready` revision of the task has that hash, the temporary object is
   deleted and that revision is returned (de-duplication). Otherwise the object is copied to
   `snapshots/<taskId>/<packSha256>.tar.gz` (skipped when that key already exists) and the temporary
   object is deleted; leftovers of a crash expire through the `tmp/` lifecycle rule
   ([data model](data-model.md) §9). Only then is the next revision number allocated atomically
   (`tasks.revisionSeq`) and the revision inserted `queued` with `source.{kind, packSha256, packBytes,
   fileCount}`, `snapshotKey` and its `revisionBuild` job. The job (concurrency
   `SCANTOR_BUILD_CONCURRENCY`, FIFO, shared with test-run builds) streams the **stored S3 snapshot**,
   never the live workspace, into `scantor task build - --tag
   localhost:${SCANTOR_REGISTRY_PORT}/tasks/<taskId>:<revisionId> --push --push-gate 3 --expect-name
   <task> [--allow-privileged] --events ndjson` ([tasks](tasks.md) §9), so edits after the publish never
   reach the revision and a job restarted from scratch after a lease expiry rebuilds exactly the recorded
   content:
   - `pack`/`static`: manifest schema, `manifest.name == task.name`, required files, Dockerfile
     policy (BuildKit parser), forbidden labels; privileged manifests require `user.canRunPrivileged`
     (`--allow-privileged`).
   - `build`: BuildKit via the Engine API on the host daemon, build arg `SCANTOR_BASE` pinned by digest,
     timeout `SCANTOR_BUILD_TIMEOUT`, size check `SCANTOR_MAX_IMAGE_BYTES`, post-build label check; no
     registry credentials are passed into builds.
   - `describe`: container `scantor-b-*` (worker hardening, `--network none`, `SCANTOR_DESCRIBE_TIMEOUT`)
     running `scantor runtime describe` → JSON Schemas of the four types (configs in input mode, Result in
     output mode), defaults, schedule (`{kind: "template", template}` or `{kind: "custom"}`), protocol
     version, secret/upload/file paths.
   - `check`: `scantor runtime check` (`SCANTOR_CHECK_CMD`: basedpyright, tsc, go vet).
   - `push`: after the gate handshake with registry GC on fd 3 (`cursor.phase` `push`/`waitRegistry`,
     [tasks](tasks.md) §9.7, [deployment](deployment.md) §14.1),
     `localhost:${SCANTOR_REGISTRY_PORT}/tasks/<taskId>:<revisionId>` with the orchestrator registry
     credential (`SCANTOR_REGISTRY_PUSH_PASSWORD`, §10); the digest and platform (os/arch) are recorded.
   NDJSON events become the build log (`build-logs/<revisionId>.ndjson`); errors become
   `revision.errors[] = {phase, file?, line?, column?, message}`. The revision ends `ready` or `failed`.
   Build cache is pruned to `SCANTOR_BUILD_CACHE_MAX_BYTES`.

### 11.2 Scan execution

```
POST /api/scans ─► scans{creating} ─► reconciler: exchanges✓ queue scantor.scan.<id> user scan-<id> perms ─► running
   ─► placement: workers{pending→assigned} ─► nodes.assignmentsRev++ ─► node long-poll returns
   ─► node: pull base + task image by digest, create scantor-w-<id>, inject runtime, start
   ─► runtime: GET /api/runtime/bootstrap ─► AMQP (scan user) ─► connector processes (hello)
   scheduler: resolve ─► schedule stream ─► publish (confirms, nack = backpressure) ─► checkpoint ─► done
   runners:  consume (1 channel/process, prefetch 1) ─► run ─► upload files ─► publish result ─► ack
             └─ retryable error ─► attempt event + delayed republish (x-opt-delivery-time) ─► ack
   ingestor: scantor.results.ingest ─► guarded upserts analyses ─► hint counters ─► recount ─► completion
```

1. **Start** (`POST /api/scans {revision: "echo@latest", taskConfig, scanConfig, settings}`): resolve the
   revision reference (must be owned by the caller and `ready`); reject privileged revisions for users
   without `canRunPrivileged` (403); reject while a RabbitMQ alarm is active (503 `brokerAlarm`); validate
   task and scan config with ajv (`useDefaults`) against the revision schemas and store the effective
   configs (`writeOnly` values encrypted and masked); merge settings over the manifest defaults and
   validate limits; verify referenced uploads (`"x-scantor": "upload"` fields); for template schedules run
   `scantor templates estimate <name> --config - [--upload <id>=<lines>]…`, whose semantic template
   validation failures (exit 2) become 422 `configInvalid`, and require `confirm=true` above
   `SCANTOR_SCAN_CONFIRM_THRESHOLD`; reject above `SCANTOR_MAX_ANALYSES_PER_SCAN` ([api](api.md) §5.1).
   Insert the scan with `state=creating`, `round=1`, `scheduling.state=pending`, `scheduling.epoch=0`.
2. **Topology** (reconciler, level-triggered): ensure exchanges `scantor.analyses`, `scantor.results`,
   `scantor.dead`; declare quorum queue `scantor.scan.<scanId>` (`x-delivery-limit`
   `SCANTOR_DELIVERY_LIMIT`, DLX `scantor.dead`, at-least-once dead-lettering, `x-overflow=reject-publish`,
   `x-max-length` `SCANTOR_SCAN_QUEUE_MAX_READY`, `x-consumer-timeout = timeoutMs + SCANTOR_UPLOAD_TIMEOUT
   + 5m`), bind it with routing key `<scanId>`; create RabbitMQ user `scan-<scanId>` with the HMAC
   password, vhost permissions, topic permissions on both exchanges, and user limits; then set
   `state=running`, `startedAt`.
3. **Placement** (reconciler): desired workers = 1 scheduler while `scheduling.state ∈ {pending, running}`
   plus `settings.workers` runners. Hard filters: node online and not cordoned, architecture equals
   `revision.platform.arch`, pool/labels match `settings.nodeSelector`, DinD mode for privileged
   revisions, node worker capacity, reserved CPU/memory (per process × processes), free disk ≥
   `SCANTOR_NODE_MIN_FREE_DISK`, per-user `maxWorkers`. Score: least allocated ratio, ties by node id;
   the scheduler prefers the built-in node; healthy workers never move. Unplaceable workers stay
   `pending` with a reason (scan condition `workersPending`). A placed worker becomes `assigned` and the
   node's `assignmentsRev` increments. New images respect `SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS`.
4. **Node** (`GET /api/node/assignments?rev=<n>&wait=25` returns early on a newer rev): pull the base image
   (public registry) then the task image by digest (registry token flow with the node token), one pull at a
   time; create `scantor-w-<workerId>` idempotently (name conflict = adopt) with entrypoint
   `/scantor/scantor runtime worker`, `CopyToContainer` of the daemon's binary, CapDrop ALL + allowlist,
   `no-new-privileges`, `PidsLimit`, `Init`, log rotation, no tmpfs on `/tmp` (the runtime's work root
   `/tmp/scantor` lives on the container's disk-backed writable layer), memory = processes × memoryMiB +
   256 MiB, CPU = processes × cpus, env `SCANTOR_URL` (profile) and `SCANTOR_WORKER_TOKEN` (plus
   `SCANTOR_DIND=1` for privileged/sysbox DinD workers); start; report
   every 10 s through `POST /api/node/status` (a complete snapshot: worker states, applied limits, crash
   exit codes, OOM, 4 KiB log tails). Crashed containers restart in place with backoff; an exit with a
   non-zero code or an OOM kill raises the scan condition `crashLoop`, while exit 0 (the runtime stopping
   after drain, stop or 401) never does ([nodes](nodes.md) §6.5).
5. **Runtime bootstrap**: `GET /api/runtime/bootstrap` returns scan id, role, epoch, effective configs
   with secrets (runners get only the task config), settings, the revision's normalised `entry`, AMQP URL,
   per-scan credentials and the queue's consumer timeout for the node's profile, limits (including
   `maxProcessesPerWorker` and `minFreeTmpBytes`), intervals, and for the scheduler the restart count
   (`scheduler.restarts`; the `schedule` ctx `attempt` starts at `restarts + 1`), the checkpoint, resolved templates, upload
   URLs and data-source URLs. With `SCANTOR_DIND=1` the runtime first starts
   `dockerd` (the task image must contain it; otherwise the worker fails with a clear error) and waits up to
   60 s for `/var/run/docker.sock` ([runtime](runtime.md)). The runtime spawns connector processes from
   `SCANTOR_CONNECTOR_CMD` with `{entry}` substituted (worker token removed from their env,
   `oom_score_adj=1000`, own process group), completes the `hello` → `welcome` → `ready` handshake with each
   ([protocol](protocol.md) §4), checks free space under `/tmp/scantor` (reported as `tmpFreeBytes`), then
   starts consuming. It polls `POST /api/runtime/state` every 5 s ± 20 % (reports `busy[]`,
   receives `action` and `processes`, corrects its clock offset from `serverTime`). If the orchestrator is
   unreachable it keeps its last known state and keeps working; only an explicit `stop`, a 401, or the
   deletion of its RabbitMQ user stops it.
6. **Scheduler**: for template schedules, first resolve non-deterministic inputs (`latest` → concrete
   list id/month) and record them with `POST /api/runtime/scheduler/resolved` (resume always uses the
   stored resolution). On resume from checkpoint `{confirmed: N, tailHash}`, regenerate and discard items
   0..N−2 and verify the hash of item N−1 (mismatch → scheduling fails with "schedule() is not
   deterministic"). Stream items (natively for unwrapped templates, otherwise from the connector), enforce
   `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` and `SCANTOR_MAX_ANALYSES_PER_SCAN`, publish
   `{v:1, analysisId, scanId, seq, round, attempt:1, config, scheduledAt}` with confirms and `mandatory`;
   a nack means the queue is full: wait 2 s ± jitter and republish only nacked seqs. Checkpoint the
   contiguous confirmed prefix every ≤ 5 s or 1000 items (`POST /api/runtime/scheduler/checkpoint`), then
   report `POST /api/runtime/scheduler/done`. Stale epochs get 409 and the scheduler exits.
7. **Runners**: one AMQP channel + consumer with prefetch 1 per process, plus one shared confirm-mode
   publisher channel. For a `redelivered` message the runtime first asks
   `POST /api/runtime/analyses/status` and acks immediately if the analysis is already final for that
   round. Otherwise it runs the analysis with the per-analysis timeout (process group killed on timeout).
   - success: upload the files registered during the run (one `POST /api/runtime/uploads/presign` for
     all of them, then a PUT per file, §11.5), publish the result (confirm, `mandatory`,
     `user_id=scan-<scanId>`), then ack. Failed attempts upload nothing.
   - retryable error with attempts left: publish an `attempt` event, republish the analysis with
     `attempt+1` and `x-opt-delivery-time` = clock-corrected now + backoff (≥ server now + 1 s), then ack.
   - non-retryable error or attempts exhausted: publish a failed result, then ack.
   - container death: the broker redelivers (delivery count +1); after `SCANTOR_DELIVERY_LIMIT` the message
     dead-letters to `scantor.dead` → `scantor.dead.ingest` → recorded as failed (`crash`).
   The runtime never uses `basic.reject`; it nacks with requeue only to give work back (drain, unhealthy).
   Processes are recycled after `maxAnalysesPerProcess` analyses and after any timeout or crash.
8. **Ingestor**: scan identity comes only from the AMQP `user_id`; `_id = <scanId>-<seq>`; documents are
   built field by field. One unordered `bulkWrite` (w: majority) per batch of guarded upserts with
   `round`; E11000 on an upsert means "duplicate, already better" → ack. Results of unknown, `deleting` or
   `deleted` scans are acked and dropped. Live counters (`$inc` hints), a 5-minute completion rate window
   and the circuit breaker (`SCANTOR_BREAKER_MIN_ATTEMPTS`, `SCANTOR_BREAKER_RATIO`,
   `SCANTOR_BREAKER_WINDOW`) are updated per flush.
9. **Recount and completion**: triggered when the hint shows terminal ≥ confirmed, on scheduler `done`,
   at the end of retry-failed, on resume, and every 60 s per running scan (paused scans: recount only, while
   their hints changed since the last recount). The recount aggregation writes
   exact `stats`; completion is one conditional `findOneAndUpdate` requiring `state=running`,
   `scheduling.state ∈ {done, failed}`, the current `round`, and terminal ≥ confirmed. It sets
   `completed`, or `failed` when `scheduling.error` is set. The reconciler then removes workers, the
   RabbitMQ user and the queue. Terminal scans are recounted once more two minutes after entering their
   terminal state, to absorb late duplicates still in the ingest queue.
10. **Stall detection** (reconciler, [queue](queue.md) §9): a running scan with scheduling finished,
    ready + unacked + delayed = 0 (management API), no busy process, and a recount below confirmed, all
    continuously for `SCANTOR_SCAN_STALL_AFTER`, gets its missing seqs inserted as `lost` (no config), its
    remaining `pending`/`retrying` documents converted to `lost` (they keep their config), a `stalled`
    condition, and completes. A late result still replaces `lost`, and retry-failed re-runs every `lost`
    document that kept its config (§11.3).

### 11.3 Lifecycle operations

All lifecycle routes only change intent in MongoDB (plus a job where noted); the reconciler converges.

| Operation | Allowed from | Immediate effect (API) | Convergence |
|---|---|---|---|
| **pause** (`pauseScan`) | `running` | `state=paused`, `stateReason={code:"user"}`, `pausedAt` | All workers → `draining`; daemons stop them with `SCANTOR_WORKER_DRAIN_GRACE` (+5 s); runtimes cancel consumers, finish in-flight work within the grace, nack the rest (uncounted). Queue (ready + delayed) and RabbitMQ user stay. Late results are ingested; completion cannot happen while paused. |
| auto-pause | `running` | ingestor sets `state=paused`, `stateReason={code:"failureRate"}`, condition `breakerTripped` | as pause |
| **resume** (`resumeScan`) | `paused` | `state=running` | Placement creates new workers; a new scheduler (if scheduling is unfinished) gets `epoch+1` and resumes from the checkpoint; completion check runs. |
| **scale** (`scaleScan {workers?, processes?}`) | `creating`, `running`, `paused` | `settings.workers` / `settings.processes` | workers: runners added, or the least-busy runners (from in-memory `busy[]`) drained. processes up: assignment raises limits (`ContainerUpdate`) → node reports applied → state poll returns the new `processes`. processes down: state poll returns the lower value at once → runtime drains slots → reports → assignment lowers limits. |
| **cancel** (`cancelScan`) | `creating`, `running`, `paused` | `state=cancelled`, `completedAt` | Reconciler in this order: delete RabbitMQ user `scan-<id>` (force-closes every worker connection), delete the queue (drops ready, delayed, unacked), remove workers, set `pending`/`retrying` analyses to `cancelled`, recount (never-run seqs count as cancelled implicitly). Results already in the ingest queue are still recorded. |
| **retry-failed** (`retryFailedAnalyses`) | `running`, `completed`, `failed`, `cancelled`, with `scheduling.state ∈ {done, failed}` and no active retry job | `round=R+1`, `scheduling.state=retrying`, `state=running` (if terminal), `completedAt=null`, job `scanRetryFailed` | Topology re-ensured. The job (cursor by seq): for a previously cancelled scan, first materialise never-run seqs as `cancelled` docs; then set every `failed` or `lost` doc with a stored config to `{status: pending, round: R+1, attempt: 0}` (`cancelled` docs and gap-filled `lost` docs without a config are never retried; restart the scan instead); then publish those configs with `round: R+1, attempt: 1` using the scheduler's nack-and-wait loop; finally `scheduling.state` returns to `failed` if `scheduling.error` is set, else `done`, and completion is checked. |
| **restart** (`restartScan`) | any except `deleting`, `deleted` | creates a **new** scan (clone): same revision, same effective configs (including secrets), same settings with optional `workers`/`processes`/`name` overrides, `clonedFrom` | Normal start flow; templates resolve again. The original is untouched. 409 `revisionUnavailable` if the revision was deleted. |
| **delete** (`deleteScan`) | `completed`, `failed`, `cancelled` | `state=deleting`, job `scanDelete` | Job: ensure the RabbitMQ user, then the queue, absent; delete workers docs, analyses in 10 000-doc batches by seq (after 10 s of batches the job gives its slot to due deletions and continues after them; two run at once), S3 prefix `files/<scanId>/`, the scan's exports and events; after a settle delay of 2 × `SCANTOR_INGEST_FLUSH_INTERVAL` + 10 s (the job defers itself for it and holds no slot meanwhile), a final `analyses.deleteMany({scanId})` sweep removes any result the ingestor wrote in the instant before its scan-state cache saw `deleting` ([queue](queue.md) §6.3); then `state=deleted`, `purgeAfter = now + SCANTOR_TOMBSTONE_DAYS`. The ingestor drops results for the scan from then on; MongoDB TTL purges the tombstone. |

### 11.4 Node join and offline handling

1. Admin creates the node (`POST /api/nodes {name, pool?, labels?, maxWorkers?}`); the response shows the
   token once with a `docker run` command and a compose snippet. The node is `pending`.
2. Operator runs `docker run -d --name scantor-node --restart unless-stopped -v
   /var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL=<public url> -e SCANTOR_NODE_TOKEN=snt_…
   ghcr.io/lonetis/scantor:<version> node`.
3. The daemon refuses plaintext to non-private hosts (unless `SCANTOR_ALLOW_INSECURE_TRANSPORT=true`),
   computes an `instanceId` (Docker engine ID + boot nonce), and calls `POST /api/node/hello`. The
   orchestrator checks the token, the version compatibility window and the instance lease (a live lease of
   a different Docker engine → 409 `nodeInstanceConflict`; a restarted daemon on the same engine takes
   over at once), stores reported info (arch, CPUs, memory, disk, effective DinD mode, capacity), sets
   `online`, and returns the node id, profile, intervals and `minFreeDiskBytes`.
4. The daemon applies the egress deny list, ensures `scantor-workers` (bridge, `enable_icc=false`),
   rebuilds its state from containers labelled `scantor.managed=true` + `scantor.node=<nodeId>` named
   `scantor-w-<workerId>` (adopt assigned, remove unassigned after the first assignments response), then
   loops: assignments long-poll, reconcile, status every 10 s (a complete snapshot of its workers), image
   GC after `SCANTOR_NODE_IMAGE_RETENTION` (immediately when free disk drops below `minFreeDiskBytes`).
5. **Offline**: no status for `SCANTOR_NODE_OFFLINE_AFTER` → node `offline`, its non-terminal workers
   `lost` (their tokens stop validating immediately), events and conditions raised, replacements placed
   elsewhere (new worker ids; a new scheduler gets `epoch+1`). Messages held by lost workers return to the
   queue when their AMQP connections die; duplicate executions are deduplicated by the ingestor. Silence
   counts only while the orchestrator could receive statuses: after its start, a lock failover, a paused
   process or a MongoDB outage the detection waits for a grace first ([nodes](nodes.md) §7.4).
6. **Return**: the next hello/status sets `online`; the desired set no longer contains the lost workers,
   so the daemon drains and removes their containers.
7. **Rotate / revoke** (`POST|DELETE /api/nodes/{id}/token`): rotation replaces the hash (the old daemon
   gets 401 and the node eventually goes offline until it is restarted with the new token); revocation
   sets `revoked`, marks its workers `lost` immediately and denies registry pulls. Deleting a node revokes
   it and removes the record. The built-in node (record name `builtin`) cannot be deleted, rotated or
   revoked; its token is derived from `SCANTOR_SECRET` by the daemon itself (`SCANTOR_NODE_BUILTIN=true`),
   and the orchestrator stores the matching `tokenHash` at every boot.

### 11.5 Files upload and download

1. Inside `run`, the connector calls `ctx.files.put(name, data|path, contentType?)`: it writes the data
   (or copies the given file) into the execution's `ctx.filesDir` and sends a `file` message
   ([protocol](protocol.md) §5.6). The runtime opens the path with `O_NOFOLLOW` (a regular file inside
   `filesDir`), checks the name (1–255 characters, no NUL, `/` or `\`, unique within the execution),
   `SCANTOR_MAX_FILE_BYTES` and `SCANTOR_MAX_FILES_PER_ANALYSIS`,
   computes size and SHA-256, **generates the `fileId` (uuid v4)** and answers at once with the final
   FileRef `{id, name, size, sha256, contentType}`, which user code may embed in the result
   ([runtime](runtime.md) §8.4).
2. Only after a **successful** outcome, the runtime calls `POST /api/runtime/uploads/presign {seq, round,
   attempt, executionId, files: [{fileId, name, size, sha256, contentType}]}` once for all registered files.
   The orchestrator takes the scan id from the worker token, validates the runtime-generated `fileId`s
   (uuid v4, unique within the call), checks the limits and the per-user storage quota
   (`SCANTOR_USER_STORAGE_QUOTA_BYTES`), generates the keys
   `files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>` itself, and presigns PUTs (expiry
   `SCANTOR_UPLOAD_TIMEOUT`) for the node's S3 endpoint with `Content-Type` and `Content-Length` signed.
3. The runtime PUTs the bytes directly to RustFS (at most 4 in parallel, retried within the delivery's
   holding budget, [runtime](runtime.md) §8.10). Upload time does not count toward the analysis timeout;
   files of failed attempts are never uploaded. The result message lists every file registered during the
   execution (FileRefs without keys); the ingestor recomputes the keys with the same function as the
   presign route and stores them on the analysis. Files of losing duplicate executions remain under their
   own `executionId` prefix until the scan is deleted.
4. Download: `GET /api/analyses/{analysisId}/files/{fileId}` checks ownership through the scan and returns
   a presigned GET for `SCANTOR_S3_PUBLIC_URL` (10 minutes, created per request) with
   `Content-Disposition: attachment; filename*=UTF-8''…` and `Content-Type: application/octet-stream`,
   except png/jpeg/gif/webp which are served inline with the forced image type. `?redirect=true` answers
   302. Browsers download straight from RustFS; bucket CORS allows only the dashboard origin.
5. Test-run files: local mode writes them to `/scantor/out/files/<seq>/<fileId>/<safeName>`; the `testRun`
   job fetches `/scantor/out` with `CopyFromContainer` and uploads them to
   `test-runs/<testRunId>/files/<seq>/<fileId>/<safeName>`.

## 12. Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | One static Go binary implements CLI, node daemon, runtime, task pipeline and workspace helpers. | One implementation of every task-folder and container operation; local validate equals server publish. |
| D2 | The runtime is injected by the consumer, never baked into base images. | Runtime fixes reach old revisions; only the small connector protocol needs compatibility (N, N−1). |
| D3 | Templates are implemented once in Go; connectors ship typed proxies. | No triplicated HTTP/parsing logic; a new language needs only a connector and a base image. |
| D4 | `schemas/languages.json` + base image ENV contract hold all language knowledge. | No language switch in runtime, CLI or orchestrator. |
| D5 | Per-scan quorum queue + per-scan RabbitMQ user with HMAC password. | Per-scan permissions, backpressure via `x-max-length`, deleting the user is a reliable kill switch, nothing to store. |
| D6 | Retries via native delayed delivery (`x-opt-delivery-time`), ack-after-publish, runtime never rejects. | No delay-tier topology; delivery-limit stays a backstop for container death only. |
| D7 | One channel + consumer with prefetch 1 per process slot. | A consumer timeout or cancel affects one analysis; live resize opens/closes channels. |
| D8 | Analyses keyed `<scanId>-<seq>`, guarded upserts with `round`, recount is authoritative, completion is one conditional update. | Exactly-once effect under at-least-once delivery, crash-safe completion, retry-failed without races. |
| D9 | Intent-only API handlers, a level-triggered reconciler, resumable leased jobs, lease locks. | Crash safety across Mongo, RabbitMQ and Docker side effects; safe if a second replica ever runs. |
| D10 | Nodes connect outbound only via HTTP long-poll; status every 10 s; offline after a timeout. | Works behind firewalls; no WebSocket state; simple reconciliation. |
| D11 | Registry native token auth with the orchestrator as token server; pulls by digest; no `/v2` proxy. | Blobs never pass through Node; per-assignment pull grants. |
| D12 | Worker tokens, AMQP passwords and the built-in node token are HMAC/HKDF-derived from `SCANTOR_SECRET`. | Nothing secret to store, rotate or leak from the database. |
| D13 | The orchestrator process never touches workspace content; throwaway helper containers do. | Tar/zip slip, symlink and git CVEs cannot reach the process holding the Docker socket and root credentials. |
| D14 | Editor on a separate origin served by a dedicated orchestrator listener (container port 3001), code-server on a unix socket only, owner-only, rotating `editor` API key that never carries admin power. | Workspace JS cannot ride the dashboard session; nothing listens on a network; nothing but the editor is reachable on the editor origin. |
| D15 | better-auth with the Mongo adapter (string uuid ids), `disableSignUp`, setup token for the first admin. | Proven auth stack; no open registration; no setup takeover. |
| D16 | MCP tools generated from OpenAPI and curated to ≤ ~30 with `x-mcp`; OAuth scopes `scantor:read`, `scantor:write`, `scantor:admin`. | One source of truth; good tool selection; least privilege for agents. |
| D17 | MongoDB single-node replica set with `--noscripting`; user queries via a read-only user with a recursive allowlist. | Transactions and change streams; no server-side JS; no cross-tenant query escapes. |
| D18 | Test runs are a platform feature (draft images, local mode). | Browser editor and MCP agents can test without publishing or local Docker. |
| D19 | The connector is the authoritative validator; ajv runs only at scan and test-run start (with defaults), and the UI validates forms in the browser for feedback only (`@cfworker/json-schema`, [ui](ui.md) §6.1). | No double validation per analysis; the scan records exactly what ran. |
| D20 | Restart clones into a new scan; delete is tombstoned. | No id reuse, no mixing of old and new in-flight messages, no resurrection by late results. |
| D21 | All platform JSON is camelCase; ids are uuid v4 strings except analysis ids. | One convention across TS, Go, Python and Mongo. |
| D22 | Environment-only configuration, documented only in `.env.example`; insecure dev secrets refused in public deployments. | Project rule; secure by default. |

## 13. Decisions made in this document

These refine decisions.md. The lead's round-1 rulings accepted items 1–4 and 7–12 explicitly; the other
items stand as written. Items 13–16 record round-1 rulings that this document encodes.

1. **HKDF parameters** are fixed as in §9 (salt `scantor-v1`), with additional labels `registry-push`,
   `registry-http`, `config-secrets`, `editor-cookie` and `mongo-query`.
2. **Built-in node token**: the built-in node daemon receives `SCANTOR_SECRET` and
   `SCANTOR_NODE_BUILTIN=true` and derives its own token; it already holds the host Docker socket, so this
   adds no exposure.
3. **Test-run containers** join `scantor-egress` (no platform services, inter-container traffic disabled)
   instead of `scantor-sandbox`; they need no platform access in local mode.
4. **Jobs runner split**: build and test-run jobs run in the `api` component (they stream logs to API
   requests); delete, retry-failed, export, task-delete and user-purge jobs run in the `reconciler`
   component.
5. **Container names and kinds** as in §7; describe/check containers use the prefix `scantor-b-`.
6. **Env value syntax** for durations, byte sizes, booleans and lists as in §10.
7. **Node/daemon version window**: the orchestrator accepts node daemons (and therefore runtimes) of its own
   and the previous minor version; others get 426 `incompatibleVersion` ([api](api.md)).
8. **Image references of the binary** (§4.2): compiled-in `internal/version` defaults, overridden as a pair by
   `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG` whenever `SCANTOR_IMAGE_TAG` is non-empty. This merges two
   subsystem proposals: build-time constants ([development](development.md)) alone would make orchestrator
   images built from `main` reference base-image tags that do not exist (their version is a `git describe`
   string), and env-only resolution ([tasks](tasks.md)) would make an unconfigured native CLI depend on
   shell state.
9. **CLI environment** (§10): beyond `SCANTOR_URL`/`SCANTOR_TOKEN` (decisions §9), the CLI honours the mode
   selectors `SCANTOR_DEV_MODE`/`SCANTOR_WORKSPACE`, `SCANTOR_CA_CERT` and optional local-build overrides
   (all listed in the CLI section of `.env.example`); credentials still come only from
   `SCANTOR_URL`/`SCANTOR_TOKEN`.
10. **Editor listener on container port 3001** (adopted from [editor](editor.md) §11.1): deviates from
    decisions §5 ("the orchestrator's port published a second time, Nitro dispatches by Host") because h3
    resolves WebSocket upgrades by path only and its proxy buffers bodies; a separate listener gives a
    byte-level relay and makes "only the editor on the editor origin" structural.
11. **Plaintext transport allowance** includes CGNAT `100.64.0.0/10` and IPv6 ULA besides loopback and
    RFC 1918 (adopted from [nodes](nodes.md) §11), so private overlays such as WireGuard or Tailscale work
    without `SCANTOR_ALLOW_INSECURE_TRANSPORT`.
12. **Shared HKDF test vectors** live with the other shared corpora in `tests/corpora/keys-vectors.json`
    ([testing](testing.md) §2) rather than in `internal/keys/testdata/`.
13. **Worker scratch on disk**: worker containers get no tmpfs on `/tmp`; the runtime's work root
    `/tmp/scantor` lives on the container's disk-backed writable layer (files can be as large as
    `SCANTOR_MAX_FILE_BYTES`), and `tmpFreeBytes` reports that filesystem.
14. **DinD start-up**: the node daemon sets `SCANTOR_DIND=1` on privileged and sysbox workers; the runtime
    then starts `dockerd` from the task image and waits up to 60 s for `/var/run/docker.sock` before
    bootstrapping its connector processes.
15. **Push credential**: `scantor task build --push` receives only the derived `orchestrator` registry
    password, as `SCANTOR_REGISTRY_PUSH_PASSWORD` (name defined here), never `SCANTOR_SECRET`.
16. **Retry-failed scope**: retry-failed resets `failed` and `lost` analyses that still have a stored config;
    `cancelled` analyses are never retried (restart the scan instead).
17. **Snapshot at publish** (§11.1 step 6, matching [tasks](tasks.md) §10): the publish request stores the
    snapshot in S3 before the revision is inserted, and the `revisionBuild` job builds only that stored
    snapshot. The revision's recorded pack hash, its de-duplication and every rebuild after a lease expiry
    therefore refer to the same immutable content, however long the build queue is.

## 14. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Multi-replica orchestrator | `locks` leases, leased jobs, change-stream caches and `SCANTOR_COMPONENTS` already make loops singleton-safe; the MCP internal capabilities, editor one-time codes and SSE in-process streams need a shared store, and the editor listener and helper runner must stay on the host that holds the Docker socket and the editor sockets. |
| Separate ingestor/reconciler services | Same image with `SCANTOR_COMPONENTS=ingestor,reconciler` as a second compose service. |
| STS-scoped S3 credentials and multipart uploads > 5 GiB | `bootstrap.uploads.mode` is an enum (`presigned` today); keys are already per scan prefix. |
| `ctx.memo`, `ctx.expectTotal` | `scheduling.resolved` is a keyed map; `stats.expectedTotal` exists; new connector protocol messages are versioned. |
| Multi-arch task builds (buildx), registry S3 backend | Revisions record `platform`; placement already filters on architecture; images are referenced by digest. |
| Per-process multiplexing | Protocol messages carry request ids; `ctx` is passed per call. |
| Cron / recurring scans | A future `schedules` collection creating scans via the same start flow; the word "schedule" stays reserved for the operation, "cron/recurring" for this feature. |
| Separate builder nodes | Builds already run through the stateless `scantor task build`; a builder node could run it behind the same job kind. |
| Scan priorities | Placement is a pure function; RabbitMQ quorum queues support priorities. |
| Prometheus/Grafana containers | `/api/metrics` is already Prometheus text; add an opt-in compose profile. |
| Per-user node-pool allowances | `nodes.pool` and `settings.nodeSelector` exist; add an allowed-pools list to users and a placement filter. |
| Additional languages | Add a connector + base image, a `languages.json` row, a scaffold, toolchain in the editor stage ([development](development.md)). |
| Workspace and editor-home quotas | Helpers already measure workspace sizes and enforce `SCANTOR_WORKSPACE_MAX_BYTES`; per-user volumes or XFS project quotas on the `<userId>` directories would add hard limits. |
| Revision retention | Task images are tagged per revision and referenced by digest; a retention job could delete manifests of revisions no scan references, and registry GC already reclaims blobs. |
