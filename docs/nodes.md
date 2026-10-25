# Nodes

This document specifies everything about compute nodes. On the node side it covers the node daemon
(`scantor node`, part of the `scantor` binary, package `internal/node`): its configuration, how the built-in
node differs from remote nodes, the join flow, registration with the instance lease, the assignments
long-poll, the reconcile loop, the exact Docker container spec of a worker, status reporting, offline
handling, image and disk hygiene, the egress deny helper, and the registry and transport security of a
node. On the orchestrator side it covers placement, the function that maps desired workers to nodes. The
wire formats of `/api/node/*` and `/api/registry/token` are defined in [api](api.md) §6–§7; node and worker
documents and their state machines are in [data model](data-model.md) §4.7, §4.8, §6.6 and §6.7; the
system context is in [architecture](architecture.md). The worker process itself (the runtime) is in
[runtime](runtime.md), and the deployment of the master's built-in node is in [deployment](deployment.md).

## 1. Overview

```
                    orchestrator (master)
   ┌───────────────────────────────────────────────────────────────┐
   │ reconciler: placement ──► workers{assigned, nodeId}           │
   │             nodes.assignmentsRev++                            │
   │ /api/node/hello · /api/node/assignments · /api/node/status    │
   │ /api/registry/token (pull grants for assigned repositories)   │
   └──────────────▲───────────────────────────────▲────────────────┘
                  │ HTTPS, outbound only          │ HTTPS (token realm, called by dockerd)
   ┌──────────────┴──────────── node ─────────────┴──────────────────┐
   │ scantor node (container, Docker socket)                         │
   │   hello ─► loop { long-poll assignments ─► reconcile ─► status }│
   │        │                                                         │
   │        ▼ Engine API (/var/run/docker.sock)                      │
   │   dockerd ── pull image@digest (X-Registry-Auth: node token)    │
   │          ── create scantor-w-<workerId> ── CopyToContainer      │
   │             /scantor/scantor ── start                            │
   │   workers: task image + injected runtime + connector processes  │
   └──────────────────────────────────────────────────────────────────┘
```

- The node daemon is **stateless**. Its only inputs are its environment, the Docker engine and the
  orchestrator's desired set. It rebuilds its state from container labels whenever it starts.
- The daemon only ever makes outbound HTTP(S) requests to `SCANTOR_URL`. It listens on no port.
- The daemon manages only containers it created itself. It identifies them by the managed labels it set
  (`scantor.managed=true`, `scantor.kind=worker`, `scantor.node=<nodeId>`) plus the name prefix
  `scantor-w-`. It never touches any other container on the host. It does not touch the helper, editor,
  build and test-run containers that the orchestrator creates on the master either.
- A node is trusted like the master. It sees everything about the scans placed on it: configs including
  secrets, worker tokens and per-scan AMQP credentials ([architecture](architecture.md) §6.2, zone Z3).

## 2. Configuration

The daemon reads only environment variables, documented with their defaults in `.env.example`.

| Variable | Used for |
|---|---|
| `SCANTOR_URL` | Orchestrator base URL. Built-in node: `SCANTOR_INTERNAL_URL`. Remote node: `SCANTOR_PUBLIC_URL`. |
| `SCANTOR_NODE_TOKEN` | The node token (`snt_…`). Required unless `SCANTOR_NODE_BUILTIN=true`. |
| `SCANTOR_NODE_BUILTIN` | `true` only for the master's built-in node. The daemon derives its token from `SCANTOR_SECRET` (§3). |
| `SCANTOR_SECRET` | Built-in node only: input of the token derivation. Never set it on remote nodes. |
| `SCANTOR_NODE_MAX_WORKERS` | Maximum concurrent workers on this node, reported as `info.maxWorkers`. `0` means "number of CPUs". |
| `SCANTOR_NODE_DIND` | `disabled`, `sysbox` or `privileged` (§6.9). |
| `SCANTOR_NODE_EGRESS_DENY` | Comma-separated CIDRs that workers must not reach (§9), or `none` to disable the helper. An empty value means the default list, as for every variable: compose passes a variable missing from `.env` on as an empty one, which must never switch the metadata blocking off. |
| `SCANTOR_NODE_PIDS_LIMIT` | `PidsLimit` of every worker container. |
| `SCANTOR_NODE_SHM_SIZE` | `ShmSize` (`/dev/shm`) of every worker container. |
| `SCANTOR_NODE_NOFILE` | `nofile` soft and hard ulimit of every worker container. |
| `SCANTOR_NODE_WORKER_LOG_MAX_SIZE`, `SCANTOR_NODE_WORKER_LOG_MAX_FILES` | Rotation of the `local` log driver of worker containers. |
| `SCANTOR_NODE_IMAGE_RETENTION` | How long an unreferenced task or base image is kept before the image GC removes it (§8). |
| `SCANTOR_NODE_PULL_TIMEOUT` | Upper bound of a single image pull. |
| `SCANTOR_CA_CERT` | PEM bundle of additional trusted CAs. The daemon trusts it and passes it on to workers (§11). |
| `SCANTOR_ALLOW_INSECURE_TRANSPORT` | `true` allows plaintext to public hosts (§11). The daemon passes it on to workers. |
| `SCANTOR_LOG_LEVEL`, `SCANTOR_LOG_FORMAT` | Daemon logging (`debug`/`info`/`warn`/`error`; `json`/`text`). |

Everything else comes from the orchestrator, in the hello response `config` and in each assignment:
intervals, drain grace, registry host, minimum free disk, images, resources and the worker environment.
Node pool and labels are **admin-owned** attributes of the node record (`createNode`/`updateNode`). The
daemon does not report them and cannot change them.

The daemon must run as a container with the Docker socket mounted. It uses its own container image as the
image of the egress helper (§9), and its own rootfs to measure free disk (§7.2). The `scantor` image runs as
root by default, which is required for the Docker socket. Docker Engine 25 or newer (API ≥ 1.44) is
required. Docker 29 is the tested version.

## 3. Built-in node vs remote nodes

| | Built-in node | Remote node |
|---|---|---|
| Runs | the compose service `node` on the master ([deployment](deployment.md)) | `docker run … scantor node` on any Docker host |
| Record | upserted by the orchestrator at every boot: `builtIn: true`, name `builtin`, `endpointProfile: internal`, pool `shared` (admin-editable) | created by an admin (`createNode`), `endpointProfile: public` |
| Token | `snt_` + base64url(HKDF(`SCANTOR_SECRET`, `builtin-node`)), derived by both the daemon and the orchestrator. The orchestrator stores its SHA-256 as `tokenHash` at every boot, so a changed secret takes effect at the next boot. It cannot be rotated, revoked or deleted (409 `builtInNode`). | 32 random bytes, `snt_` prefix, shown once, stored as SHA-256; rotate and revoke per [architecture](architecture.md) §11.4 |
| `SCANTOR_URL` | `SCANTOR_INTERNAL_URL` (the orchestrator on compose network `scantor`) | `SCANTOR_PUBLIC_URL` |
| Worker network | `scantor-sandbox` (created by compose; the daemon only checks that it exists) | `scantor-workers` (created by the daemon, inter-container traffic disabled) |
| Registry host in image refs | `localhost:${SCANTOR_REGISTRY_PORT}` (the host daemon's loopback) | `SCANTOR_REGISTRY_PUBLIC_HOST` |
| Worker URLs (`SCANTOR_URL`, AMQP, S3) | internal profile | public profile ([architecture](architecture.md) §8) |
| DinD | `SCANTOR_BUILTIN_NODE_DIND`. Keep it `disabled`: enabling DinD here makes every user with `canRunPrivileged` root on the master. | `SCANTOR_NODE_DIND` |
| Max workers | `SCANTOR_BUILTIN_NODE_MAX_WORKERS`, kept small: the master also runs MongoDB, RabbitMQ, RustFS and builds | `SCANTOR_NODE_MAX_WORKERS` (`0` = number of CPUs) |
| Placement preference | the scheduler worker prefers it (§12.4) | spread |

Setting both `SCANTOR_NODE_BUILTIN=true` and `SCANTOR_NODE_TOKEN` is a configuration error: the daemon exits
with code 2.

## 4. Join flow (remote nodes)

```
admin (UI "Add node")          orchestrator                         node host (operator)
  │ POST /api/nodes {name, pool?, labels?, maxWorkers?}
  │──────────────────────────────►│ insert node {state: pending, tokenHash}
  │◄──────────────────────────────│ 201 {node, token: "snt_…", join: NodeJoin}
  │ copy dockerRun or compose ─────────────────────────────────────────►│ docker run … scantor node
  │                               │◄────────── POST /api/node/hello ─────│
  │                               │ node online, instance lease          │
  │                               │──────────── 200 {node, config} ─────►│ egress deny, network, adopt
  │                               │◄──── GET /api/node/assignments ──────│ loop
```

`NodeJoin` is part of the `createNode` and `rotateNodeToken` responses, with the token inlined.
`getNodeJoin` returns it with the token replaced by `${SCANTOR_NODE_TOKEN}`. The image is
`<SCANTOR_IMAGE_PREFIX>scantor:<image tag>`. The image tag is the orchestrator's version when that is a
release version (`X.Y.Z`), and `SCANTOR_IMAGE_TAG` otherwise (builds from `main` and dev builds have no
version tag). `cliImage` uses the same rule ([api](api.md) §4.1, §4.17).

`dockerRun` (exact string; the backslash continuations are for readability only, the API returns one line):

```sh
docker run -d --name scantor-node --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SCANTOR_URL=https://scantor.example.com \
  -e SCANTOR_NODE_TOKEN=snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9 \
  ghcr.io/lonetis/scantor:1.4.0 node
```

`compose` (written to `compose.yml` in an empty directory, then `docker compose up -d`):

```yaml
name: scantor-node

services:
  node:
    image: ghcr.io/lonetis/scantor:1.4.0
    command: ["node"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/usr/local/bin/scantor", "node", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    container_name: scantor-node
    stop_grace_period: 30s
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - SCANTOR_URL=https://scantor.example.com
      - SCANTOR_NODE_TOKEN=snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9
      # optional:
      # - SCANTOR_NODE_MAX_WORKERS=8
      # - SCANTOR_NODE_DIND=sysbox
      # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...
```

The UI shows both snippets next to a checklist:

1. Docker Engine ≥ 25 on the node host.
2. Outbound HTTPS from the node host to `SCANTOR_PUBLIC_URL`, `SCANTOR_REGISTRY_PUBLIC_HOST`,
   `SCANTOR_S3_PUBLIC_URL` and the AMQPS endpoint of `SCANTOR_AMQP_PUBLIC_URL`.
3. Optionally, outbound HTTPS to `ghcr.io` for base-image layers.
4. For a private CA, the host Docker daemon must trust the CA for the registry host (§10.3).
5. For `SCANTOR_NODE_DIND=sysbox`, Sysbox must be installed on the host.

## 5. Daemon lifecycle

### 5.1 Start-up

```
1. load env; validate (exit 2 on invalid values: unknown DinD mode, malformed CIDRs, both token sources)
2. check transport for SCANTOR_URL (§11); exit 2 when refused
3. connect to Docker (client.FromEnv, API version negotiation, User-Agent scantor-node/<version>)
4. info := docker /info; self := inspect own container (§2)
5. instanceId := info.ID + ":" + 8 random hex chars           // engine ID + boot nonce
6. found := list managed worker containers (§6.1)
7. hello loop (§5.2) with containers = found, until 200
8. start, concurrently:
     egress loop (§9)               — apply now, re-apply every 10 min
     network ensure (§6.8)          — scantor-workers (remote) / verify scantor-sandbox (built-in)
     adopt (§6.1)                   — track found containers of this node; no removals before the first assignments response
     assignments loop (§5.3)
     reconcile loop (§6)
     status loop (§7)
     docker events watcher          — label=scantor.managed=true, type=container; triggers reconcile
     image GC loop (§8)             — every 10 min
```

### 5.2 Hello and the instance lease

`POST /api/node/hello` ([api](api.md) §7.1) carries `instanceId`, `version`, `info` and the managed
containers found at start (`containers[]`, for adoption). On the orchestrator:

| Condition | Result |
|---|---|
| unknown or revoked token | 401 `unauthorized` |
| version outside the window (same or previous minor) | 426 `incompatibleVersion` |
| `node.instance` is null, or `instance.id == instanceId`, or `instance.lastSeenAt < now − SCANTOR_NODE_OFFLINE_AFTER` | lease granted |
| `instance.id` has the **same engine ID** (part before `:`) but a different nonce | lease taken over immediately: a restarted daemon on the same host. The previous instance gets 409 on its next request and stands by (below). |
| a live lease of a **different** engine | 409 `nodeInstanceConflict`, `details.retryAfterMs` = remaining lease time; event `node.instanceConflict` |

On success the orchestrator sets `instance = {id, version, startedAt, lastSeenAt}`, stores `info`, sets
`state: online` and `lastSeenAt`, emits `node.online`, and returns `{serverTime, node, config}`.

`config` fields: `statusIntervalMs` (`SCANTOR_NODE_STATUS_INTERVAL`), `assignmentsWaitSeconds`
(`SCANTOR_NODE_ASSIGNMENTS_WAIT`), `offlineAfterMs` (`SCANTOR_NODE_OFFLINE_AFTER`), `drainGraceMs`
(`SCANTOR_WORKER_DRAIN_GRACE`), `registry {host, username: "node"}` and `minFreeDiskBytes`
(`SCANTOR_NODE_MIN_FREE_DISK`). `minFreeDiskBytes` is a backbone change request, see §15.

Every later request carries `X-Scantor-Instance-Id`. When a request returns 409 `nodeInstanceConflict`,
the daemon immediately stops reconciling, cancels its long-poll and pulls, and **does not touch any
container**. With `retryAfterMs` = 0 (the lease is free) it goes back to the hello loop at once.

With `retryAfterMs` > 0 another instance holds a live lease: one of the same engine that took the lease
over (a second daemon with the same token on this host, or this instance was paused or frozen and then
resumed), or, after this instance was silent for the offline window, one of another engine. The daemon
then **stands by** instead of saying hello, because a hello from the same engine would take the lease
back at once, and two daemons on one engine would evict each other forever, each re-adopting and
reconciling the same containers.

```
log warn "another daemon instance holds this node's lease; standing by …"
delay := retryAfterMs + jitter
loop:
  sleep delay
  GET /api/node/assignments?wait=0        // only the lease holder may call it; changes nothing
  409 with retryAfterMs > 0  → delay := retryAfterMs + jitter   // the other instance is alive
  409 with retryAfterMs = 0, 200, 401, 426 → back to the hello loop
  network error, 5xx         → delay := backoff (1 s … 30 s)
```

So the instance that said hello last keeps the lease, and a superseded instance takes over only when the
other one has been silent for the offline window (`SCANTOR_NODE_OFFLINE_AFTER`). The jitter is a fifth of
`retryAfterMs`, at least 1 s, ±50 %.

The hello loop retries as follows:

| Response | Retry after |
|---|---|
| network error, 5xx | 1 s, then exponential backoff up to 30 s, ±20 % jitter |
| 409 | `retryAfterMs` + jitter |
| 401 | 60 s |
| 426 | 5 min, logged at error level with `details.minVersion` |

### 5.3 Assignments long-poll

```
rev := -inf; first := true
loop:
  resp := GET /api/node/assignments?rev=<rev>&wait=<first ? 0 : config.assignmentsWaitSeconds>
  on 409 → stand by or back to hello (§5.2); on 401 → unauthorized mode (§7.4); on error → backoff (keep the last desired set)
  desired.store(resp.workers, resp.logRequests); rev = resp.rev; first = false
  trigger reconcile
```

- The first call uses `wait=0`, so the daemon gets the complete desired set at once. Until that first
  response arrives, adopted containers are only tracked, never removed.
- A status response whose `rev` is greater than the daemon's applied rev cancels the pending long-poll
  and starts a new one immediately.
- The response always holds the **complete** desired set. Any managed worker container of this node that
  is not listed must be stopped and removed (§6.6).
- The daemon validates every assignment before acting on it (§6.10). An invalid assignment is reported
  as `error` with code `createFailed` and is never created.

## 6. Reconcile loop

Reconciliation is level-triggered. It runs on every new desired set, on Docker events for managed
containers, on timers (backoff expiry, pull completion), and at least every 5 s. Each worker has one
**worker actor** (a goroutine with its own state). Actors run concurrently, except that **image pulls are
serialized node-wide** (one pull at a time, FIFO in assignment order).

```
reconcile(desired D, actual A):
  for c in A where c.workerId ∉ D:               remove(c)                       // §6.6
  for d in D:
    c := A[d.workerId]
    if c == nil:                                  ensureImage(d) → create(d) → inject → start
    elif c.labels["scantor.spec-hash"] != d.specHash:
                                                  remove(c) → create(d) → inject → start
    elif c.state == running:                      ensureLimits(c, d)              // §6.7
    elif c.state in {exited, dead}:               handleExit(c, d)                // §6.5
    elif c.state == created:                      inject (idempotent) → start
```

Node-local actor states map to the reported states of [api](api.md) §7.3:

| Actor state | Reported `state` | Meaning |
|---|---|---|
| `waitingPull`, `pulling` | `pulling` | queued for the node-wide pull slot, or pulling |
| `creating`, `starting` | `starting` | container being created, runtime injected, started |
| `running` | `running` | container running (the runtime bootstraps on its own) |
| `backoff` | `backoff` | exited; restart scheduled at `nextRestartAt` |
| `stopping` | `stopping` | stop requested (grace) or removal in progress |
| `removed` | `removed` | container removed (reported until it leaves the desired set and three status reports have passed) |
| `failed` | `error` | `imagePullFailed`, `createFailed` or `platformMismatch`; retried with backoff except `platformMismatch` |

### 6.1 Adoption after a daemon restart

Before `hello` the daemon does not know its node id yet. It lists containers with the filters
`label=scantor.managed=true` and `label=scantor.kind=worker`, plus `name=scantor-w-`. It keeps only the
ones whose name is exactly `scantor-w-<scantor.worker label>` and reports them in `hello` `containers[]`.
The orchestrator ignores entries that are not assigned to the node. Once the hello response gives the
node id, the daemon tracks as actors only the containers whose `scantor.node` label equals it, in the
state Docker reports. After the first assignments response:

- in `D` with the same `specHash` → **adopted**. A running container keeps running, and its limits are
  re-applied idempotently (§6.7).
- in `D` with a different `specHash` → recreated.
- not in `D` → removed (§6.6).

A container that has the managed labels but the wrong name, or a worker name but a foreign `scantor.node`
label, is ignored and logged at warn level. The daemon never deletes what it cannot attribute to itself.

### 6.2 Creating a worker idempotently

```
create(d):
  name := "scantor-w-" + d.workerId
  POST /containers/create?name=<name>  (body §6.3)
    409 Conflict (name in use) → inspect by name:
        managed labels match (scantor.worker == d.workerId, scantor.node == nodeId)
            → adopt it (continue with inject/start as for an existing container)
        otherwise → failed{createFailed, "name conflict with a foreign container"}   // never remove it
  inject(id): PUT /containers/{id}/archive?path=/  (tar: dir scantor/ 0755, file scantor/scantor 0755, uid/gid 0)
  POST /containers/{id}/start   (304 "already started" is success)
```

Runtime injection ([architecture](architecture.md) §4.2): the tar holds the daemon's own executable
(`/proc/self/exe`, a static linux binary for the node's architecture), read once and cached in memory.
The tar is streamed to the engine through a pipe and never buffered as a whole, so concurrent creates
(a scale-up, or a restart that recreates many workers) do not each hold a copy of the binary.
`CopyToContainer` works on a created, not yet started container and needs no volume. On a restart of an
exited container the binary is still in its writable layer, so injection is skipped when
`/scantor/scantor` already exists (`HEAD /containers/{id}/archive?path=/scantor/scantor`).

### 6.3 The worker container spec

Engine API body of `POST /containers/create?name=scantor-w-<workerId>` for a non-DinD worker on a remote
node. The values are those of the [api](api.md) §7.2 example: `processes` 2, 1 CPU and 512 MiB per
process, so 2 CPUs and 2 × 512 MiB + 256 MiB = 1280 MiB.

```json
{
  "Image": "registry.example.com/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@sha256:4e5f6a7b…",
  "Entrypoint": ["/scantor/scantor", "runtime", "worker"],
  "Cmd": [],
  "Env": [
    "SCANTOR_URL=https://scantor.example.com",
    "SCANTOR_WORKER_TOKEN=swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o"
  ],
  "Labels": {
    "traefik.enable": "false",
    "com.docker.compose.project": "scantor-managed",
    "com.docker.compose.service": "",
    "scantor.managed": "true",
    "scantor.kind": "worker",
    "scantor.worker": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "scantor.scan": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "scantor.user": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
    "scantor.node": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
    "scantor.spec-hash": "sha256:5d41402abc4b2a76b9719d911017c592"
  },
  "StopSignal": "SIGTERM",
  "StopTimeout": 35,
  "HostConfig": {
    "Init": true,
    "RestartPolicy": { "Name": "no" },
    "NetworkMode": "scantor-workers",
    "CapDrop": ["ALL"],
    "CapAdd": ["NET_BIND_SERVICE", "NET_RAW"],
    "SecurityOpt": ["no-new-privileges:true"],
    "Privileged": false,
    "ReadonlyRootfs": false,
    "PidsLimit": 4096,
    "Memory": 1342177280,
    "MemorySwap": 1342177280,
    "NanoCpus": 2000000000,
    "ShmSize": 268435456,
    "Ulimits": [ { "Name": "nofile", "Soft": 65536, "Hard": 65536 } ],
    "LogConfig": { "Type": "local", "Config": { "max-size": "20m", "max-file": "3" } }
  },
  "NetworkingConfig": { "EndpointsConfig": { "scantor-workers": {} } }
}
```

Field by field:

| Field | Value | Notes |
|---|---|---|
| name | `scantor-w-<workerId>` | Unique per worker. A name conflict means adopt (§6.2). |
| `Labels` | managed labels from `internal/container.ManagedLabels(kind, ids)` | Run-time labels override image labels with the same key. That neutralises hostile `traefik.*` and `com.docker.compose.*` labels in user images ([security](security.md)). `scantor.spec-hash` is the assignment's `specHash`. |
| `Image` | assignment `image`: `<registryHost>/tasks/<taskId>@sha256:<digest>` | Always by digest. The registry host is `localhost:${SCANTOR_REGISTRY_PORT}` on the built-in node and `SCANTOR_REGISTRY_PUBLIC_HOST` elsewhere. Pull flow in §10. |
| `Entrypoint` / `Cmd` | `["/scantor/scantor", "runtime", "worker"]` / `[]` | When `Entrypoint` is set, Docker does not merge the image `CMD`. `[]` makes that explicit. `WORKDIR` (`/task`) and the image `ENV` (`SCANTOR_LANGUAGE`, `SCANTOR_CONNECTOR_CMD`, …) stay as built. `User` is not set, so the image user applies. |
| `Env` | the assignment `env` (`SCANTOR_URL`, `SCANTOR_WORKER_TOKEN`), plus `SCANTOR_CA_CERT` and `SCANTOR_ALLOW_INSECURE_TRANSPORT=true` when set on the daemon, plus `SCANTOR_DIND=1` for DinD workers (§6.9) | The runtime removes `SCANTOR_WORKER_TOKEN` from the environment of connector processes ([runtime](runtime.md)). No other variable is ever added. |
| `StopSignal` / `StopTimeout` | `SIGTERM` / `drainGraceMs/1000 + 5` | Also used for explicit stops (§6.6). |
| `Init` | `true` | `docker-init` is PID 1. It reaps zombies (Chromium, subprocesses) and forwards SIGTERM to the runtime. |
| `RestartPolicy` | `no` | The daemon owns restarts and backoff (§6.5). Docker never restarts workers on its own, also not after a host reboot. |
| `NetworkMode` + `EndpointsConfig` | `scantor-sandbox` (built-in) / `scantor-workers` (remote) | Exactly one network (§6.8). No published ports, no aliases. |
| `CapDrop` / `CapAdd` | `["ALL"]` / assignment `capAdd` ⊆ {`NET_BIND_SERVICE`, `NET_RAW`} | The orchestrator sends the capabilities listed in `SCANTOR_WORKER_CAP_ADD`, a subset of this allowlist (raw sockets for ICMP/SYN scans, low ports). Anything outside the allowlist is rejected by the daemon (§6.10). |
| `SecurityOpt` | `no-new-privileges:true` | The default seccomp and AppArmor profiles stay in force; they are never overridden. |
| `PidsLimit` | `SCANTOR_NODE_PIDS_LIMIT` | Fork-bomb guard per container. |
| `Memory` / `MemorySwap` | `resources.memoryBytes`, the same value for both (no swap) | `= processes × memoryMiB × 1 MiB + 256 MiB` ([api](api.md) §7.2). Pages of `/dev/shm` count against this limit. |
| `NanoCpus` | `resources.nanoCpus` | `= processes × cpus × 10⁹`. |
| `ShmSize` | `SCANTOR_NODE_SHM_SIZE` | For browsers (Chromium needs more than Docker's 64 MiB default). |
| scratch | no `Tmpfs` | `/tmp` is part of the container's disk-backed writable layer. The runtime's work root `/tmp/scantor` (per-process and per-execution directories) lives there, because files can be as large as `SCANTOR_MAX_FILE_BYTES`; the runtime reports `tmpFreeBytes` for that filesystem ([runtime](runtime.md) §7.1). A tmpfs would count against the memory limit and is never mounted at `/tmp`. |
| `Ulimits` | `nofile` = `SCANTOR_NODE_NOFILE` (soft = hard) | Deterministic file-descriptor limit for scanners. Without it, the value would depend on the engine and containerd version. |
| `LogConfig` | `local`, `max-size` = `SCANTOR_NODE_WORKER_LOG_MAX_SIZE`, `max-file` = `SCANTOR_NODE_WORKER_LOG_MAX_FILES` | Bounded disk usage. `docker logs` and the on-demand tail (§7.3) keep working. |
| `ReadonlyRootfs` | `false` | Task code may write into its image filesystem (caches, browser profiles). |
| `Privileged` | `false`, except DinD mode `privileged` (§6.9) | |
| Mounts | none, except the DinD volume (§6.9) | No host paths, no Docker socket, no named volumes. |

### 6.4 Starting

After `start` the actor is `starting` until Docker reports the container running, then `running`. The
orchestrator moves the worker document `starting → running` on the runtime's first
`GET /api/runtime/bootstrap` ([data model](data-model.md) §6.6), not on node reports.

### 6.5 Exits, crash loops and backoff

When a desired container exits (Docker event `die`, or a reconcile pass finds it `exited` or `dead`):

```
inspect → exitCode, oomKilled (State.OOMKilled), finishedAt
logTail := last 4096 bytes of GET /containers/{id}/logs?stdout=1&stderr=1&tail=200 (cut at a UTF-8 boundary)
lastExit := {exitCode, oomKilled, at: finishedAt, logTail}
if exitCode == 0 and !oomKilled:
    // The runtime exits 0 only after action drain/stop or a 401 (worker no longer valid).
    // This is transient: the orchestrator is removing the worker from the desired set.
    state := backoff; nextRestartAt := now + 10 s; crashes unchanged
else:
    crashes += 1
    delay := min(5 s × 2^(crashes−1), 5 min) × uniform(0.9, 1.1)
    state := backoff; nextRestartAt := now + delay
at nextRestartAt, if still desired with the same specHash: POST /containers/{id}/start; restarts += 1
crashes resets to 0 after the container has run 10 min without exiting
```

- The container is restarted in place, not recreated. Its writable layer, including the injected runtime,
  survives. The runtime removes leftovers under `/tmp/scantor` when it starts ([runtime](runtime.md) §4.1).
- `restarts` is the total number of restarts of this container on this node. It is reported together with
  `lastExit` and `nextRestartAt` in every status (§7.1).
- The orchestrator raises the scan condition `crashLoop` (with `{workerId, nodeId, exitCode, oomKilled,
  restarts, logTail}`) and the event `worker.crashed` when a worker reports `backoff` with a **new**
  `lastExit.at` and `exitCode ≠ 0` or `oomKilled`. Exit 0 never raises `crashLoop`.
- OOM kills of individual connector processes do not stop the container: the runtime sets
  `oom_score_adj=1000` on connectors, so the kernel kills those first, and the runtime restarts them.
  `OOMKilled` is only reported when the container itself exits.

### 6.6 Stopping and removing (graceful stop, drain)

A worker is removed from the desired set when it is drained (scale-in, pause, scheduling finished, scan
terminal, cancel) or lost ([data model](data-model.md) §6.6). The daemon then runs:

```
remove(c):
  state := stopping
  POST /containers/{id}/stop?t=<drainGraceMs/1000 + 5>      // SIGTERM → docker-init → runtime
  DELETE /containers/{id}?force=true&v=true                 // v=true also removes anonymous DinD volumes
  state := removed
```

On SIGTERM the runtime cancels its consumers, lets in-flight analyses finish within `drainGraceMs`, nacks
the rest with requeue (which is not counted against the delivery limit) and exits 0 ([runtime](runtime.md)).
The runtime usually already received `action: drain` or `stop` from its state poll; both paths are
idempotent. Docker sends SIGKILL after the stop timeout. Containers are always **removed**, never just
stopped, so their writable layers do not pile up.

Removals run concurrently (at most 4 at a time per node). They never wait for the pull slot.

### 6.7 Live resize (processes)

A change of only `processes` and `resources` keeps the `specHash` and is applied in place:

```
ensureLimits(c, d):
  if c.HostConfig.Memory != d.resources.memoryBytes or c.HostConfig.NanoCpus != d.resources.nanoCpus:
     POST /containers/{id}/update {"Memory": m, "MemorySwap": m, "NanoCpus": n}   // one call
     on success: applied := {processes: d.processes, nanoCpus: n, memoryBytes: m}
     on failure (for example EBUSY when lowering memory below current usage): keep the old applied,
       log, retry at the next reconcile
  report applied in the next status (immediately, debounced 1 s)
```

The sequencing is the orchestrator's job ([architecture](architecture.md) §11.3):

- Scale up: the assignment raises the limits. The daemon applies them and reports `applied.processes`.
  Only then does `POST /api/runtime/state` return the higher `processes`.
- Scale down: the state poll returns the lower value at once. The runtime drains slots and reports
  `processes.running`. Then the assignment lowers the limits.

After adoption the daemon always re-issues the update once, so `applied` is known again after a restart.

### 6.8 Networks

| Node | Network | Created by | Properties |
|---|---|---|---|
| built-in | `scantor-sandbox` | compose ([deployment](deployment.md)) | Shared with the orchestrator (alias `orchestrator`), `rabbitmq` and `rustfs`. Inter-container traffic is on, because workers must reach those services. If the network is missing, the daemon reports every assignment as `createFailed` and logs an error. |
| remote | `scantor-workers` | daemon, at start, if missing | bridge, `com.docker.network.bridge.enable_icc=false` (workers of different scans and users on one node cannot reach each other), managed labels (`scantor.kind=network`), no IPv6 |

`NetworkCreate` is idempotent, but an existing `scantor-workers` (found at start, or the cause of a 409)
is used only when it has every property of the table: the bridge driver, `enable_icc=false`, no IPv6 and
the managed labels of kind `network`. A network of that name made by hand or by another tool, or edited,
could let workers of different scans and users reach each other. The daemon then logs an error naming
the missing properties and reports every assignment as `createFailed` until an operator removes the
network; the next check (every 30 s) creates it again. The daemon never deletes networks.

### 6.9 DinD modes

Privileged (Docker-in-Docker) tasks need **both** the user flag `canRunPrivileged` (checked by the
orchestrator at publish and scan start) **and** a node whose `SCANTOR_NODE_DIND` is not `disabled`.
Placement only places such workers on matching nodes (§12). Describe and check containers are never
privileged.

| Mode | Container differences from §6.3 | Requirements | Trust impact |
|---|---|---|---|
| `disabled` | – (assignments with `dindMode ≠ null` are rejected) | – | – |
| `sysbox` | `"Runtime": "sysbox-runc"`; `CapDrop`, `CapAdd` and `no-new-privileges` are omitted (default capabilities inside the system container's user namespace); `Mounts: [{"Type": "volume", "Target": "/var/lib/docker"}]` (anonymous) | Sysbox installed; the daemon checks that `sysbox-runc` is in `/info` `Runtimes`. If it is missing, it reports `dindMode: "disabled"` and logs an error. | DinD without host root |
| `privileged` | `"Privileged": true`; no `CapDrop`/`CapAdd`/`no-new-privileges`; the same anonymous `/var/lib/docker` volume | – | **Root on the node host.** Only for dedicated nodes. |

- `no-new-privileges` is omitted in DinD modes because it is inherited by every inner container and
  breaks setuid binaries there.
- The anonymous volume is needed because overlay2 cannot nest on the container's overlay rootfs. It is
  removed with the container (`v=true`).
- DinD workers (`sysbox` and `privileged`) get `SCANTOR_DIND=1` in their environment. The runtime then
  starts the inner `dockerd`, which the task image must contain (a task Dockerfile installs Docker when it
  needs it), waits up to 60 s for `/var/run/docker.sock`, and only then proceeds. A missing `dockerd` or a
  socket timeout fails the worker with a clear error ([runtime](runtime.md), [tasks](tasks.md)).
- `info.dindMode` is the **effective** mode, so a misconfigured Sysbox node is never chosen.

### 6.10 Assignment validation (defense in depth)

The master is trusted. Still, a malformed assignment must never produce a dangerous container. The
daemon rejects an assignment (`error`, code `createFailed`, message names the field) when any of these
checks fails:

| Check | Rule |
|---|---|
| `workerId`, `scanId`, `userId` | uuid |
| `image` | `<config.registry.host>/tasks/<uuid>@sha256:<64 hex>` |
| `baseImage` | null, or ends with `@sha256:<64 hex>` |
| `specHash` | `sha256:` + hex |
| `privileged` / `dindMode` | `privileged == (dindMode != null)`; `dindMode` ∈ {null, own effective mode} and the own mode is not `disabled` |
| `capAdd` | ⊆ {`NET_BIND_SERVICE`, `NET_RAW`} (ignored in DinD modes) |
| `env` | keys ⊆ {`SCANTOR_URL`, `SCANTOR_WORKER_TOKEN`}; `SCANTOR_URL` non-empty; `SCANTOR_WORKER_TOKEN` starts with `swt_<workerId>.` |
| `resources` | `nanoCpus > 0`, `memoryBytes ≥ 256 MiB`, both ≤ the node's totals |
| `processes` | 1 … 1024 |

## 7. Status reports

### 7.1 `POST /api/node/status`

Sent every `config.statusIntervalMs` (±10 % jitter), and additionally right after local state changes
(debounced 1 s). The body is defined in [api](api.md) §7.3.

- `workers` is a **complete snapshot**. It holds every worker in the daemon's current desired set plus
  every managed worker container that still exists. Workers removed since the previous report appear
  as `removed` in the next three reports. A worker the orchestrator assigned to this node that appears in
  none of these is gone: after two consecutive reports without it, the orchestrator treats a `draining`
  worker as `stopped`.
- Per worker: `state`, `containerId`, `startedAt`, `restarts`, `applied {processes, nanoCpus,
  memoryBytes}`, `lastExit {exitCode, oomKilled, at, logTail}` (≤ 4 KiB), `nextRestartAt`, `pull {image,
  startedAt}` while pulling, and `error {code, message}` in state `error`.
- `info` holds the capacity:

| Field | Source |
|---|---|
| `version` | daemon version |
| `cpus` | `/info` `NCPU` |
| `memoryBytes` | `/info` `MemTotal` |
| `diskFreeBytes` | `statfs("/")` of the daemon's own container, `Bavail × Bsize`. A container rootfs is an overlay whose free space is that of the engine's storage filesystem (verified: `df /` in a container shows the host filesystem). That filesystem holds image layers and the writable layers of workers, including their `/tmp/scantor` work roots. |
| `dindMode` | effective mode (§6.9) |
| `maxWorkers` | `SCANTOR_NODE_MAX_WORKERS`, or `cpus` when 0 |
| `egressDenyApplied` | result of the last egress helper run (§9) |

  `arch`, `os`, `kernel`, `hostname` and `dockerVersion` are sent in `hello` (they never change while
  the daemon runs).
- `clockOffsetMs`: per response, `sample = serverTime + rtt/2 − localTimeAtResponse`. As in the runtime
  ([runtime](runtime.md) §5.2), the first sample sets the offset and later samples with `rtt ≤ 2000 ms`
  update it with an EWMA (α = 0.2); slower samples, such as an assignments long-poll the server held, are
  discarded, because `rtt/2` estimates the one-way delay only when the server answered at once. The
  reconciler raises the scan condition `clockSkew` for scans with workers on a node whose
  `|clockOffsetMs| > 2000`. Workers correct their own offset through state polls ([runtime](runtime.md)),
  so skew is only reported, never fatal.

The response `{serverTime, rev, nextStatusMs}` updates the clock offset. A `rev` greater than the applied
rev triggers an immediate assignments request. `nextStatusMs` (when > 0) is the interval until the next
report (±10 % jitter); otherwise `statusIntervalMs` from hello applies.

The daemon writes `/tmp/scantor-node.status` (`{"at": <epoch ms>, "nodeId": "…", "statusIntervalMs":
<interval in use>}`, atomic rename) after every successful status. `scantor node healthcheck` exits 0 when
that timestamp is younger than 3 × the recorded interval, and 1 otherwise, so it needs no configuration.
That is the container healthcheck in compose and in the join snippet.

### 7.2 What the orchestrator derives

| From | Effect |
|---|---|
| reported `pulling` / `starting` / `backoff` | worker state transitions ([data model](data-model.md) §6.6) |
| `applied.processes` | `workers.processes.applied` |
| new `lastExit.at` with exit ≠ 0 or OOM | event `worker.crashed`; condition `crashLoop` |
| `error.code = imagePullFailed` | condition `imagePullFailed` (cleared when a pull of the image succeeds on any node: a worker of the scan is reported with its first container, even when its runtime bootstrapped before that report) |
| `info.diskFreeBytes < SCANTOR_NODE_MIN_FREE_DISK` | node excluded from new placements (`diskLow`) |
| no status for `SCANTOR_NODE_OFFLINE_AFTER` | node `offline`, its active workers `lost` (§7.4) |

A node may only report workers assigned to it. Other entries are ignored and logged
([api](api.md) §7.3).

### 7.3 On-demand worker logs

Each assignments response may carry `logRequests: [{requestId, workerId, tailBytes}]`. For each new
`requestId` the daemon fetches `GET /containers/{id}/logs?stdout=1&stderr=1&tail=<lines>`, where lines is
`max(200, tailBytes/64)`. It cuts the result to the last `tailBytes` bytes on a UTF-8 boundary and posts
`POST /api/node/workers/{workerId}/logs` `{requestId, text, bytes, truncated, collectedAt}`. A request
for a worker without a container is answered with `text: ""`. Answered request ids are remembered for
10 min, so a request is never answered twice.

### 7.4 Offline, partitions and unauthorized mode

**Orchestrator unreachable** (network errors, 5xx): the daemon keeps the last desired set and keeps
reconciling locally. It restarts crashed workers, keeps limits and finishes started pulls. API calls back
off exponentially from 1 s to 30 s with jitter. It **never removes workers because the orchestrator is
unreachable**. Workers keep processing as long as AMQP works ([runtime](runtime.md)).

**Orchestrator side**: no status for `SCANTOR_NODE_OFFLINE_AFTER` → node `offline`, event `node.offline`,
every active worker of the node `lost` (reason `nodeOffline`). Their worker tokens stop validating at
once, and the reconciler places replacements elsewhere (new worker ids; a new scheduler gets
`epoch + 1`). Messages held by the lost workers return to the queue when their AMQP connections die, and
duplicate executions are deduplicated by the ingestor.

Silence counts only while the orchestrator could receive the statuses. The detection (every 10 s under
the `reconciler` lock) runs only once it has watched for a grace of `SCANTOR_NODE_OFFLINE_AFTER`, or
60 s when the window is shorter: the longest a live node may need to reach a restarted orchestrator, that
is the longest retry delay of its backed-off daemon (30 s + 20 % jitter, §5.2) plus the time until
Traefik routes to the orchestrator again (its next health check, [deployment](deployment.md) §4.1),
with a margin. The watch starts when the orchestrator acquires the lock (its start, a failover) and
starts again after the lock was lost, after a tick that came more than two intervals late (the process
did not run, for example `docker pause`), and after a detection pass that failed or was still running at
the next tick (MongoDB, which records the statuses, was unavailable). So an orchestrator restart or outage
gives every node a full window, and the time to reach the orchestrator again, before it can go offline. When the
orchestrator stops, its components stop at the signal, before Nitro drains the open requests: the
detection ends at once, and the assignments long-polls answer at once instead of holding the drain for
`SCANTOR_NODE_ASSIGNMENTS_WAIT` ([architecture](architecture.md) §4.1).

**Partition heals**: the next status of the same instance re-acquires the lease (same `instanceId`) and
sets `online`. The desired set no longer contains the lost workers, so the daemon drains and removes
them. If those runtimes reach the orchestrator before that, they get 401 and stop on their own.

**401 on any node route** (token rotated or revoked, node deleted): the daemon enters unauthorized mode.
It stops creating containers, keeps the existing ones running, and retries `hello` every 60 s. When it is
still unauthorized after `offlineAfterMs` (the last known value; 60 s if unknown), it stops and removes
all managed worker containers, because the orchestrator has already marked them lost. The operator
restarts the daemon with the new token. Before the first successful `hello` the daemon does not know its
node id and cannot attribute containers to itself (§1, §6.1): a 401 there only retries `hello` every 60 s
and never removes containers.

### 7.5 Daemon shutdown (SIGTERM)

The daemon cancels the long-poll and any running pull, waits up to 10 s for create, start and update
calls in progress, sends a final status (2 s timeout, best effort) and exits 0. **Workers keep running**
and are adopted by the next daemon instance (§6.1). As long as that happens within
`SCANTOR_NODE_OFFLINE_AFTER`, daemon upgrades and restarts are transparent.

Planned node maintenance:

| Goal | Procedure |
|---|---|
| upgrade or restart the daemon | `docker pull` the new image, recreate the daemon container. Workers continue and are adopted. Old workers keep their injected runtime until they are recreated; that is fine within the version window. |
| reboot the host | Optionally cordon the node first (`updateNode {cordoned: true}`). After the reboot, workers that are still desired are restarted (`RestartPolicy: no`, so the daemon does it). If the host is gone longer than the offline window, they are lost and replaced elsewhere, and the daemon removes the stale containers when it comes back. |
| decommission | Cordon the node and wait until no workers remain (scans finish or are scaled), or delete the node at once (`deleteNode`: workers lost and replaced). Then stop the daemon. It removes remaining workers itself after the unauthorized window. |

## 8. Image and disk hygiene

| Measure | Rule |
|---|---|
| pull by digest | Assignments always reference `@sha256:…`, so a tag change never moves a running scan. |
| one pull at a time | A node-wide pull slot, FIFO by assignment order, plus `SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS` cluster-wide on the orchestrator (§12.3). Each pull is bounded by `SCANTOR_NODE_PULL_TIMEOUT`. |
| base image first | When an assignment's `baseImage` is not null and not present, the daemon pulls it anonymously from its public registry first, so the task pull only transfers user layers from the master. Failure is ignored, because this is only an optimisation. |
| remove, don't stop | Unassigned containers are removed, including their anonymous volumes (§6.6). |
| log rotation | `local` driver per container (§6.3). |
| image GC | Every 10 min. Candidates are images whose repository is `<config.registry.host>/tasks/*` or whose repository name ends in `/scantor-base-python`, `/scantor-base-js` or `/scantor-base-go`. For each candidate the daemon keeps an in-memory `lastUsed` (set to the daemon start time for images found at start, and refreshed whenever a desired or existing container references the image). Candidates not referenced by any existing container and unused for `SCANTOR_NODE_IMAGE_RETENTION` are removed with `DELETE /images/{id}?noprune=false` (never `force`). |
| emergency GC | When `diskFreeBytes < config.minFreeDiskBytes`, the GC runs immediately with retention 0 for unreferenced candidates. At most once per 5 min. |
| what is never touched | Images not matching the patterns, volumes, networks, build cache, and on the master the draft images `tasks/<taskId>:draft-*` (the orchestrator's GC handles those, [tasks](tasks.md)). |

On the master, task images built by the task pipeline are tagged
`localhost:${SCANTOR_REGISTRY_PORT}/tasks/<taskId>:<revisionId>` and already exist locally, so the
built-in node never pulls them. The image GC may remove them later; they stay in the registry and are
pulled again when needed.

## 9. Egress deny helper

Workers must not reach cloud metadata endpoints or other operator-chosen ranges. On the master the same
rule also covers editors, test runs, workspace helpers and BuildKit `RUN` steps, because the rule is
host-wide. The daemon applies `SCANTOR_NODE_EGRESS_DENY` (cloud metadata ranges; the list shipped in
`.env.example` covers link-local IPv4, the AWS IPv6 metadata address and the Alibaba metadata address) with a one-shot helper container, at start and
every 10 min, because host firewall reloads can flush rules.

Helper container (managed labels, kind `egressHelper`):

```
docker run --rm --name scantor-netpol-<nodeId> \
  --network host --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
  --security-opt no-new-privileges --read-only --tmpfs /run:size=1m --user 0:0 \
  --mount type=bind,source=/run/xtables.lock,target=/run/xtables.lock \
  --label scantor.managed=true --label scantor.kind=egressHelper --label scantor.node=<nodeId> … \
  --entrypoint /usr/local/bin/scantor <own image id> node egress-apply --deny 169.254.0.0/16,fd00:ec2::254/128,100.100.100.200/32
```

`scantor node egress-apply` (hidden subcommand) does the following:

```
for family in (ipv4: iptables, ipv6: ip6tables) with at least one CIDR of that family:
  backend := first of (iptables-nft, iptables-legacy) whose `-w -n -L DOCKER-USER` succeeds
             // must match Docker's own backend; both binaries ship in the scantor image
  if none: result[family] = "DOCKER-USER chain not found"; continue
  rules := for cidr in family: "-A SCANTOR-EGRESS -d <cidr> -j REJECT --reject-with <reject>"
           // icmp-admin-prohibited / icmp6-adm-prohibited: fails fast instead of timing out
  if `<backend> -w -S SCANTOR-EGRESS` does not list exactly rules (in order):
    <backend>-restore -w --noflush  <<  "*filter", ":SCANTOR-EGRESS - [0:0]", rules…, "COMMIT"
  -C DOCKER-USER -j SCANTOR-EGRESS || -I DOCKER-USER 1 -j SCANTOR-EGRESS
print {"applied": bool, "families": {...}, "errors": [...]} on stdout
```

- The chain is replaced in **one transaction** and is never empty while `DOCKER-USER` jumps to it.
  With `--noflush`, the chain declaration creates `SCANTOR-EGRESS` or empties it within the same commit,
  the rules follow in that commit, and every other chain stays untouched; a rejected rule aborts the
  whole transaction and leaves the previous chain in place. A separate `-F` followed by one `-A` per
  CIDR would leave the metadata ranges reachable between the flush and the first append, on every
  periodic re-apply. A chain that already holds the desired rules is not written at all, and on the
  first run the chain is complete before the jump is inserted. All four restore binaries
  (`iptables-nft-restore`, `iptables-legacy-restore`, `ip6tables-nft-restore`,
  `ip6tables-legacy-restore`) ship in the scantor image.
- `DOCKER-USER` filters forwarded traffic of containers on bridge networks, which covers workers,
  editors, test runs and BuildKit. Host-network containers and the host itself are not affected.
- `egressDenyApplied` is `true` only when every configured CIDR is in place. Otherwise the daemon logs a
  warning with the errors, keeps running and retries at the next interval. This is best effort by design.
  Known cases where it fails: Docker's experimental nftables firewall backend (no `DOCKER-USER` chain),
  rootless Docker, and IPv6 disabled in Docker (IPv6 CIDRs are then reported as not applied).
- `/run/xtables.lock`: iptables-legacy opens this lock with `O_CREAT` and exits fatally when it cannot,
  so the read-only helper gets a small tmpfs at `/run`. The host's lock file is bind-mounted over it, so
  the helper's legacy calls serialize with dockerd's own (`iptables --wait`); concurrent legacy table
  replaces can otherwise lose rules. The bind is a `type=bind` mount, which never creates a missing
  source (`-v` would create a directory on the host). When the host has no lock file, ContainerCreate
  fails with "bind source path does not exist"; then no legacy iptables has run on the host since boot,
  and the daemon creates the helper again without the bind. iptables-nft takes no lock.
- The helper image is the daemon's own image (resolved by inspecting its own container), so no extra
  image is pulled. If self-inspection fails, the helper is skipped and `egressDenyApplied: false`.
- Operators of internet-only nodes may add RFC 1918 ranges. That also blocks a master on a private
  network, so they must be added only when the master is reached through a public address.
- On cloud VMs, also set the instance metadata hop limit to 1 (AWS IMDSv2). This is a second layer
  independent of Docker.

## 10. Registry access for nodes

### 10.1 Token flow

```
node daemon ─ POST /images/create?fromImage=<repo>@sha256:<d>   X-Registry-Auth: <authconfig> ─► host dockerd
dockerd ─ GET https://<registry host>/v2/ ────────────────────────────────────────────────────► registry
        ◄─ 401 WWW-Authenticate: Bearer realm="<SCANTOR_PUBLIC_URL>/api/registry/token",service="scantor-registry"
dockerd ─ GET realm?service=scantor-registry&scope=repository:tasks/<taskId>:pull  (Basic node:snt_…)
          or, with the containerd image store, POST realm (form: grant_type=password, username=node, password=snt_…)
                                                                                               ─► orchestrator
        ◄─ {token|access_token: ES256 JWT, expires_in: 300}   access = requested ∩ allowed
dockerd ─ GET /v2/tasks/<taskId>/manifests/sha256:<d>, blobs … (Bearer JWT) ──────────────────► registry
```

- `authconfig` = base64url of `{"username": "node", "password": "<node token>", "serveraddress":
  "<registry host>"}`, **with `=` padding**. Without padding the daemon silently pulls anonymously and
  gets `unauthorized` (verified). Use `authconfig.Encode` from `github.com/moby/moby/api/pkg/authconfig`;
  never hand-roll it with `RawURLEncoding`.
- The credential travels only per pull in `X-Registry-Auth`. The daemon never runs `docker login` and never
  writes it to the host's Docker configuration ([security](security.md) MC-8).
- Grants ([api](api.md) §6): a node token gets `pull` on `tasks/<taskId>` for every task of a worker
  currently assigned to that node (states `assigned` … `draining`), and nothing else. The daemon only
  pulls after it received the assignment, so the grant always exists in time. When the worker is lost,
  the node is revoked or the scan ends, the grant disappears with the next token request. Tokens live 300 s.
- The only other registry credential is the orchestrator's (`orchestrator:<HKDF "registry-push">`, `pull`,
  `push` and `delete` on `tasks/*` plus catalog). It is used for pushes and manifest deletes on the master
  and never leaves it; nodes never receive it.
- The realm is called by the **Docker daemon of the node host**, not by the node daemon container. It
  must therefore be resolvable and reachable from the host network namespace of every node, including the
  master. On the master this usually means a hairpin connection to its own public address. If the
  network does not support hairpinning, map the public domain to `127.0.0.1` in the master host's
  `/etc/hosts` ([deployment](deployment.md) troubleshooting).
- Pull errors: a wrong token gives HTTP 500 from the Engine API (`unexpected status … 401`), and a missing
  grant gives `insufficient_scope`. Both are reported as `error {code: imagePullFailed}` with the message
  and retried with backoff from 10 s to 5 min.
- After a pull the daemon inspects the image. When its `Os`/`Architecture` is not the node's, it reports
  `platformMismatch` and does not create the container. Placement filters on architecture, so this only
  happens on misconfiguration.

### 10.2 Built-in node

The built-in node uses the same flow with `localhost:${SCANTOR_REGISTRY_PORT}`, which the host Docker
daemon reaches over loopback (implicitly allowed without TLS), and its derived token. On the master,
images built there are present already, so pulls are rare.

### 10.3 TLS of the registry

The node host's Docker daemon verifies the registry certificate with the **host's** trust store and
`/etc/docker/certs.d/<host>/`. `SCANTOR_CA_CERT` cannot change that. With Traefik and ACME certificates
nothing needs to be done. With a private CA, install it on every node host as
`/etc/docker/certs.d/<SCANTOR_REGISTRY_PUBLIC_HOST>/ca.crt` and in the host trust store (for the token
realm). Plaintext registries (`insecure-registries`) are only supported on private networks
(§11).

## 11. Transport security and custom CA

| Rule | Applies to |
|---|---|
| Plaintext (`http://`, `amqp://`) is refused unless every resolved address of the host is loopback (`127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64.0.0/10`, used by WireGuard and Tailscale overlays) or IPv6 ULA (`fc00::/7`), or `SCANTOR_ALLOW_INSECURE_TRANSPORT=true`. The check runs in the dialer on the actual peer address, so DNS changes cannot bypass it. | node daemon → `SCANTOR_URL`; runtime → `SCANTOR_URL`, AMQP and S3 URLs ([runtime](runtime.md)) |
| TLS certificate verification is always on. There is no skip-verify switch; only `docker-compose.tests.yml` trusts a test CA, through `SCANTOR_CA_CERT`. | all |
| `SCANTOR_CA_CERT` (PEM, one or more certificates) is appended to the system roots, never replacing them. The daemon passes it unchanged into every worker's environment, so the runtime trusts the same CAs for HTTPS, AMQPS and S3. | daemon, runtime |
| The master gives remote nodes only the public profile URLs. When one of them is plaintext with a public host and `SCANTOR_ALLOW_INSECURE_TRANSPORT` is not `true` on the master, the orchestrator logs a warning at boot. The clients refuse the connection anyway. | orchestrator |

With Traefik and ACME (Let's Encrypt, or a private ACME server through `SCANTOR_ACME_CA_SERVER` plus
`SCANTOR_CA_CERT`), every remote endpoint is TLS on :443: `https://<domain>`, `https://registry.<domain>`,
`https://s3.<domain>` and `amqps://amqp.<domain>:443` ([deployment](deployment.md)). Traefik's built-in
self-signed fallback certificate changes on every restart, cannot be trusted with a CA, and is therefore
only for local and test use.

## 12. Placement (orchestrator)

Placement is part of the reconciler (`orchestrator/server/services/placement`). It is a pure,
deterministic function from a snapshot (running scans, active workers, nodes, users) to a list of writes.
It runs under the `reconciler` lock on the 10 s tick and on change-stream events of `scans` (state,
settings), `workers` (state) and `nodes` (state, info, cordon), debounced by 500 ms. Healthy workers never
move: `workers.nodeId` is set once.

### 12.1 Desired workers

```
for scan in scans where state == running:
    want.scheduler := scan.scheduling.state ∈ {pending, running} ? 1 : 0
    want.runners   := scan.settings.workers
for scan in scans where state ∈ {creating, paused, completed, failed, cancelled, deleting, deleted}:
    want := 0
reconcile counts per (scan, role), counting workers in states pending … backoff (not draining/stopped/lost):
    missing → insert workers {state: pending, role, epoch (scheduler: ++scan.scheduling.epoch), processes, spec}
    surplus → pick victims (§12.5) → pending victims: stopped; placed victims: draining (+ nodes.assignmentsRev++)
```

`processes.desired`: `scan.settings.processes` for runners; always 1 for scheduler workers, because a
scheduler runs at most one connector process ([runtime](runtime.md) §2). Placement sets `assigned` to
`desired` (§12.5). A scheduler therefore reserves 1 × `cpus` and 1 × `memoryMiB` + 256 MiB
(§12.2 uses each worker's own `processes`). `scaleScan`'s `processes` and §12.6 apply to runners only.

`spec` = `{repository, digest, resources (per process), privileged, dindMode: null (set at placement),
specHash (computed at placement)}`. `specHash` = `sha256:` + hex(SHA-256 of the canonical JSON
`{image, privileged, dindMode, capAdd}`).

### 12.2 Node view

For every node in the snapshot:

```
cap.slots  = min(node.info.maxWorkers, node.maxWorkers ?? ∞)
cap.cpu    = node.info.cpus
cap.mem    = node.info.memoryBytes
used.slots = count(active workers on node)                         // assigned … draining
used.cpu   = Σ max(w.processes.desired, w.processes.assigned) × w.spec.resources.cpus
used.mem   = Σ (max(desired, assigned) × w.spec.resources.memoryMiB × MiB + 256 MiB)
has(d)     = ∃ active worker on node with spec.digest == d in state ∈ {starting, running, backoff, draining}
```

### 12.3 Filters and pending reasons

Filters are applied **in order**. The reason recorded for an unplaceable worker is the filter that
removed the last remaining candidates. These reasons are the `workersPending` reasons of
[data model](data-model.md) §4.5.4.

| # | Filter | Reason when it empties the set |
|---|---|---|
| 0 | per user: `user.maxWorkers == 0` or active workers of the user (all scans, including those placed earlier in this pass) < `user.maxWorkers` | `userMaxWorkers` (checked before looking at nodes) |
| 1 | `node.state == online`, not `cordoned`, `tokenHash != null` | `noNodes` |
| 2 | `node.info.os == revision.platform.os` and `node.info.arch == revision.platform.arch` | `archMismatch` |
| 3 | `node.pool == settings.nodeSelector.pool` and `node.labels ⊇ settings.nodeSelector.labels` | `selectorMismatch` |
| 4 | privileged revision: `node.info.dindMode != disabled` (non-privileged revisions pass every node) | `dindUnavailable` |
| 5 | `node.info.diskFreeBytes ≥ SCANTOR_NODE_MIN_FREE_DISK` | `diskLow` |
| 6 | `used.slots + 1 ≤ cap.slots` and `used.cpu + w.cpu ≤ cap.cpu` and `used.mem + w.mem ≤ cap.mem` | `insufficientCapacity` |
| 7 | pull limit: `has(node, w.digest)` or `pullsInFlight(w.digest) < SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS` | `pullLimit` |

`pullsInFlight(d)` = workers in state `assigned` or `pulling` with `spec.digest == d` on nodes where
`has(node, d)` is false.

### 12.4 Scoring

```
score(node, w) = max( (used.cpu+w.cpu)/cap.cpu, (used.mem+w.mem)/cap.mem, (used.slots+1)/cap.slots )
choose:
  if w.role == scheduler and the built-in node is a candidate → built-in node
  else → argmin over candidates of (score, workersOfSameScanOn(node), node.id)        // stable spread
```

### 12.5 Pseudo-code

```
place(snapshot):
  writes := []
  pending := workers where state == pending
             order by (role == scheduler ? 0 : 1), scan.startedAt, worker.createdAt, worker._id
  for w in pending:
    u := user(w.userId)
    if u.maxWorkers > 0 and activeCount(u) >= u.maxWorkers:
        setPending(w, "userMaxWorkers"); continue
    cands := nodes; reason := null
    for (f, r) in FILTERS[1..7]:
        next := [n for n in cands if f(n, w)]
        if next == [] : reason := r; break
        cands := next
    if reason != null: setPending(w, reason); continue
    n := choose(cands, w)
    dind := w.spec.privileged ? n.info.dindMode : null
    writes += updateOne({_id: w._id, state: "pending"},
                        {$set: {state: "assigned", nodeId: n._id, assignedAt: now,
                                "spec.dindMode": dind, "spec.specHash": specHash(w, dind),
                                "processes.assigned": w.processes.desired, stateReason: null}})
    writes += updateOne({_id: n._id}, {$inc: {assignmentsRev: 1}})
    reserve(n, w); activeCount(u) += 1                      // later decisions in this pass see the usage
  resizeProcesses(snapshot, writes)                         // §12.6
  condition workersPending per scan := {count, reasons: {reason: n}} or cleared
  events: worker.placed for each placement; worker.pending only when a worker's reason changes
  return writes

victims(scan, role, k):                                     // scale-in, §12.1
  order: pending first, then by busyCount(w) ascending (in-memory busy[] from state polls),
         then score(node) descending, then createdAt descending
  take k
```

- Writes are conditional (`{state: "pending"}`). A concurrent change makes the update a no-op, and the
  next pass decides again.
- The `$inc` on `nodes.assignmentsRev` only wakes the long-poll early. Correctness does not depend on it:
  the assignments endpoint always computes the full set from `workers` (states `assigned` … `backoff`),
  and the daemon refetches at least every `assignmentsWaitSeconds`.

### 12.6 Live resize of processes

```
for each active runner w of a running scan with w.processes.desired != w.processes.assigned:
  if desired > assigned:            // scale up: needs node headroom for the delta
      fit := largest p in [assigned, desired] with used(node) − cost(max(desired, assigned)) + cost(p) ≤ cap(node)
             // §12.2 already reserves max(desired, assigned) in used(node)
      if fit > assigned: assigned := fit; node.assignmentsRev++
      if fit < desired: count w in workersPending{insufficientCapacity}
  else:                             // scale down: lower the limit only after the runtime drained
      if w.processes.running ≤ desired: assigned := desired; node.assignmentsRev++
cost(p) = (p × cpus, p × memoryMiB × MiB + 256 MiB)
```

The state poll returns `min(desired, applied)` while scaling up and `desired` at once while scaling down
([api](api.md) §8.2).

### 12.7 Guarantees and non-goals

- Deterministic: the same snapshot gives the same placements, so a unit test can table-drive it.
- Fair enough: schedulers first, then FIFO by scan start. There are no priorities in v1.
- No preemption, no rebalancing, no bin-packing. Spread maximises headroom for live scale-up and limits
  the blast radius of a node failure.
- Capacity is reservation-based (declared per-process resources), not measured usage.

## 13. Operational reference

| Symptom | Where to look |
|---|---|
| workers stay `pending` | scan condition `workersPending` → reasons (§12.3); `GET /api/nodes` capacity |
| node `offline` while the daemon runs | daemon logs: transport refusals, 401 |
| daemon logs 409 `nodeInstanceConflict` or "standing by" | two daemons run with one token (§5.2); stop one of them |
| `imagePullFailed` | realm reachability from the node host (§10.1), registry TLS trust (§10.3), `insufficient_scope` (the worker is not assigned to the node) |
| `crashLoop` with `oomKilled: true` | raise `resources.memoryMiB` per process, or lower `processes` |
| `egressDenyApplied: false` | daemon warn log: firewall backend, rootless Docker, IPv6 |
| `clockSkew` | NTP on the node host |

## 14. Decisions made in this document

Decisions 1, 2 and 5 are approved by the lead; 8 and 11 follow lead rulings. The rest are flagged for
lead review:

1. **Instance lease takeover on the same engine:** a hello whose `instanceId` has the same Docker engine
   ID as the live lease holder takes over at once (a restarted daemon). A live lease of a different
   engine gives 409.
2. **Built-in node record name** `builtin`.
3. **Free disk** is measured with `statfs("/")` inside the daemon container. No host mount is needed.
4. **Egress helper:** chain `SCANTOR-EGRESS` jumped to from `DOCKER-USER`, `REJECT` target, iptables
   backend auto-detected. The helper image is the daemon's own image, found by self-inspection, and the
   rules are re-applied every 10 min, each time in one `iptables-restore --noflush` transaction, so the
   chain is never empty while jumped to. The deny list proposed for `.env.example` also includes the Alibaba
   metadata address `100.100.100.200/32`.
5. **Plaintext allowance** also covers CGNAT `100.64.0.0/10` and IPv6 ULA `fc00::/7` (private overlay
   networks), checked on the resolved peer address.
6. **Worker exit 0** is treated as transient (10 s wait, no crash count, no `crashLoop`). Crash backoff
   is 5 s × 2ⁿ up to 5 min and resets after 10 min of uptime.
7. **Worker capabilities** come from `SCANTOR_WORKER_CAP_ADD` for every worker (no manifest knob in v1).
   The node-side allowlist is fixed to `NET_BIND_SERVICE` and `NET_RAW`.
8. **Worker scratch** (lead ruling): no tmpfs at `/tmp`. The runtime's work root `/tmp/scantor` lives on
   the disk-backed writable layer. Workers also get `ShmSize` (`SCANTOR_NODE_SHM_SIZE`, counted against
   the memory limit) and a fixed `nofile` ulimit (`SCANTOR_NODE_NOFILE`).
9. **Status `workers` is a complete snapshot**; `removed` entries are repeated three times, and absence
   for two reports completes a drain.
10. **Pending reason** = the first filter that empties the candidate set, with filters in the fixed order
    of §12.3.
11. **DinD:** `no-new-privileges` and the capability drop are omitted in DinD modes, an anonymous
    `/var/lib/docker` volume is added, `SCANTOR_DIND=1` is set in the worker environment so the runtime
    starts the inner `dockerd` (lead ruling), and the effective `dindMode` is reported (Sysbox is
    downgraded to `disabled` when `sysbox-runc` is missing).
12. **Unauthorized mode:** after a 401 lasting longer than the offline window, the daemon removes all of
    its workers.
13. **Daemon SIGTERM leaves workers running**, so upgrades are transparent. Draining a node is cordon
    plus waiting, or delete.
14. **`SCANTOR_NODE_MAX_WORKERS=0`** means "number of CPUs". The master maps
    `SCANTOR_BUILTIN_NODE_MAX_WORKERS` and `SCANTOR_BUILTIN_NODE_DIND` onto the daemon variables
    ([deployment](deployment.md)).
15. **Offline detection waits for a grace after every interruption** (§7.4): max(offline window, 60 s)
    after the lock is acquired, a late tick or a MongoDB outage, so orchestrator restarts and outages never
    mark live nodes offline. The daemon's backoff ceiling is not lowered instead, because the grace covers
    every daemon version in the window, reverse proxies included, and needs no protocol change.

## 15. Backbone change requests (written here as if applied)

- [api](api.md) §7.1: add `config.minFreeDiskBytes` (int, from `SCANTOR_NODE_MIN_FREE_DISK`) to the hello
  response.
- [api](api.md) §7.3: state that `workers` is a complete snapshot and that `removed` entries are repeated
  (§7.1 above).
- [data model](data-model.md) §4.8: the built-in node record is named `builtin`; `info.dindMode` is the
  effective mode.
- [data model](data-model.md) §4.5.4: `crashLoop` is raised only for a non-zero exit code or an OOM kill.

## 16. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Node evacuation (`drain` flag: move workers off a node gracefully) | Placement already supports `draining` and replacements; a `nodes.draining` flag would make the reconciler drain its workers and filter the node like `cordoned`. |
| Per-user node-pool allowances | Filter 3 gains a check against a user `allowedPools` field; pools and selectors already exist. |
| Scan priorities and preemption | Placement is a pure function over an ordered pending list; a priority key slots into the sort, and a preemption pass could pick victims with the existing victim ordering. |
| Multi-arch task images | Filter 2 becomes membership in `revision.image.platforms`; pulls by index digest already work. |
| Separate builder nodes | A node capability flag (`info.builder`) and a job kind dispatched through assignments; the daemon already runs arbitrary containers by spec. |
| WebSocket or HTTP/2 push instead of long-poll | The assignments endpoint is idempotent and revisioned (`rev`), so a push channel can carry the same payload. |
| Measured-usage placement | Status reports could carry container stats (`/containers/{id}/stats`); the score function is the only place to change. |
| nftables egress backend | `egress-apply` already detects the backend; an nftables implementation can be added behind the same command. |
| Additional DinD runtimes (rootless DinD, gVisor) | `SCANTOR_NODE_DIND` is an enum mapped to a container profile in §6.9. |
| Pull-through cache on nodes | Assignments carry digests, so a node-local registry mirror can serve them without protocol changes. |
| Node labels reported by the daemon (auto-labels such as GPU, region) | `info` is free-form; placement could match `nodeSelector.labels` against `labels ∪ info.autoLabels`. |
