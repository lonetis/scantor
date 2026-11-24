# Nodes

This document specifies everything about compute nodes. On the node side it covers the node daemon
(`scantor node`, part of the `scantor` binary, package `internal/node`): its configuration, how the built-in
node differs from remote nodes, the join flow, registration with the instance lease, the assignments
long-poll, the reconcile loop, the exact Docker container spec of a worker, the node resolver that answers the
workers' DNS queries, daemon overrides, status reporting, offline handling, image and disk hygiene, the egress
deny helper, and the registry and transport security of a node. On the orchestrator side it covers placement,
the function that maps desired workers to nodes. The
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
   │          ── node resolver scantor-dns-* (host network, §6.11)   │
   │   workers: task image + injected runtime + connector processes  │
   │            DNS: 127.0.0.11 ─► <worker network gateway>:53       │
   └──────────────────────────────────────────────────────────────────┘
```

- The node daemon is **stateless**. Its only inputs are its environment, the Docker engine, the
  orchestrator's desired set and the daemon overrides that arrive with it (§6.12). It rebuilds its state
  from container labels whenever it starts, and a new daemon instance starts without overrides.
- The daemon only ever makes outbound HTTP(S) requests to `SCANTOR_URL`. It listens on no port. The node
  resolver it runs listens only on port 53 of the worker network's gateway address and answers only the
  node's own workers (§6.11).
- The daemon manages only containers it created itself. It identifies them by the managed labels it set
  (`scantor.managed=true`, `scantor.kind`, `scantor.node=<nodeId>`) plus the name prefix of the kind:
  `scantor-w-` for workers, `scantor-dns-` for the node resolver, `scantor-dnsprobe-` for its probe and
  `scantor-netpol-` for the egress helper. It never touches any other container on the host. It does not
  touch the helper, editor, build and test-run containers that the orchestrator creates on the master either.
- A node is trusted like the master. It sees everything about the scans placed on it: configs including
  secrets, worker tokens and per-scan AMQP credentials ([architecture](architecture.md) §6.2, zone Z3).

## 2. Configuration

The daemon reads its configuration only from environment variables, documented with their defaults in
`.env.example`, the only place that states them. The one other input is the daemon overrides that an admin sets
for the running instance and that arrive with the assignments (§6.12); they replace a value of the variables
marked "overridable" below until the instance stops, and the daemon reports the resulting daemon configuration
with the source of every value.

| Variable | Used for |
|---|---|
| `SCANTOR_URL` | Orchestrator base URL. Built-in node: `SCANTOR_INTERNAL_URL`. Remote node: `SCANTOR_PUBLIC_URL`, never the tunnel URL (`SCANTOR_TUNNEL_URL` answers 404 to `/api/node/*` and `/api/runtime/*`, [deployment](deployment.md) §10.2). |
| `SCANTOR_NODE_TOKEN` | The node token (`snt_…`). Required unless `SCANTOR_NODE_BUILTIN=true`. |
| `SCANTOR_NODE_BUILTIN` | `true` only for the master's built-in node. The daemon derives its token from `SCANTOR_SECRET` (§3). |
| `SCANTOR_SECRET` | Built-in node only: input of the token derivation. Never set it on remote nodes. |
| `SCANTOR_NODE_MAX_WORKERS` | Maximum concurrent workers on this node, reported as `info.maxWorkers`. `0` means "number of CPUs". Overridable (`maxWorkers`, 1–100000, §6.12). |
| `SCANTOR_NODE_DIND` | `disabled`, `sysbox` or `privileged` (§6.9). |
| `SCANTOR_NODE_EGRESS_DENY` | Comma-separated CIDRs that workers must not reach (§9), or `none` to disable the helper. An empty value means the default list, as for every variable: compose passes a variable missing from `.env` on as an empty one, which must never switch the metadata blocking off. The node resolver never sends a query to these ranges either, except to the host nameservers and to the upstream and root servers of this environment (§6.11.7); it takes at most 4096 CIDRs, and a longer list leaves the node without a resolver (`failed`, `createFailed`, §6.11.6). |
| `SCANTOR_NODE_PIDS_LIMIT` | `PidsLimit` of every worker container. Overridable (`pidsLimit`). |
| `SCANTOR_NODE_SHM_SIZE` | `ShmSize` (`/dev/shm`) of every worker container. Overridable (`shmSizeBytes`). |
| `SCANTOR_NODE_NOFILE` | `nofile` soft and hard ulimit of every worker container. Overridable (`nofile`). |
| `SCANTOR_NODE_WORKER_LOG_MAX_SIZE`, `SCANTOR_NODE_WORKER_LOG_MAX_FILES` | Rotation of the `local` log driver of worker containers. Overridable (`workerLogMaxSizeBytes`, `workerLogMaxFiles`). |
| `SCANTOR_NODE_IMAGE_RETENTION` | How long an unreferenced task or base image is kept before the image GC removes it (§8). Overridable (`imageRetentionMs`). |
| `SCANTOR_NODE_PULL_TIMEOUT` | Upper bound of a single image pull. Overridable (`pullTimeoutMs`). |
| `SCANTOR_NODE_DNS_MODE` | Mode of the node resolver (§6.11): `recursive` (through the upstream servers), `iterative` (from the root servers) or `disabled` (no resolver; workers use Docker's DNS). Security-relevant: an invalid value exits with code 2. Overridable (`dns.mode`). |
| `SCANTOR_NODE_DNS_UPSTREAMS` | Upstream servers of mode `recursive`, 1–16 entries: `ip`, `ip:port`, `[v6]:port`, or the keyword `host` for the host nameservers (for networks that allow DNS only to the site's own resolver). A server is a unicast address without zone and not IPv6 link-local, with a port of 1–65535 (53 without one); loopback, private and IPv4 link-local servers (such as `169.254.169.253`) are allowed here, and the resolver trusts every server of this variable (§6.11.7). Security-relevant. Overridable (`dns.upstreams`), but an override takes only public servers (§6.12.2). |
| `SCANTOR_NODE_DNS_ROOT_SERVERS` | Root servers of mode `iterative`, 0–16 entries (`ip`, `ip:port`, `[v6]:port`, the same rules); empty means the IANA root servers. Security-relevant. Overridable (`dns.rootServers`), public servers only. |
| `SCANTOR_NODE_DNS_LOCAL_DOMAINS` | Extra domains (0–64; suffix match on a label boundary) that the resolver resolves through the host nameservers in every mode, next to the master's endpoint hosts and the built-in local suffixes (§6.11). Security-relevant: a malformed list must never leak internal names to the upstream servers. Overridable (`dns.localDomains`). |
| `SCANTOR_NODE_DNS_CACHE_SIZE` | Byte size of the resolver's answer cache (16 MiB–64 GiB). The cache counts the estimated memory of its answers, not their wire size, so it holds fewer answers than the byte count suggests (§6.11.7); the resolver container's memory limit and, in mode `iterative`, zdns' delegation cache follow it. Overridable (`dns.cacheSizeBytes`). |
| `SCANTOR_NODE_DNS_MAX_LOOKUPS` | Lookups the resolver runs at once (1–20000). Overridable (`dns.maxLookups`). |
| `SCANTOR_NODE_DNS_UPSTREAM_QPS` | Queries per second to each upstream server or host nameserver (0 = no limit). Overridable (`dns.upstreamQps`). |
| `SCANTOR_NODE_DNS_AUTHORITATIVE_QPS` | Queries per second to each root and authoritative server in mode `iterative` (0 = no limit). Overridable (`dns.authoritativeQps`). |
| `SCANTOR_NODE_OVERRIDES` | Which daemon overrides this daemon accepts: `all`, `none`, or a comma list of override keys (`maxWorkers,dns.mode,…`, the keys of `schemas/daemon-overrides.json`). Security-relevant: it is the node operator's limit on what master admins may change on this node (§6.12). Never overridable. |
| `SCANTOR_CA_CERT` | PEM bundle of additional trusted CAs. The daemon trusts it and passes it on to workers (§11). |
| `SCANTOR_ALLOW_INSECURE_TRANSPORT` | `true` allows plaintext to public hosts (§11). The daemon passes it on to workers. |
| `SCANTOR_LOG_LEVEL`, `SCANTOR_LOG_FORMAT` | Daemon logging (`debug`/`info`/`warn`/`error`; `json`/`text`); the node resolver logs at the same level and format. The level of the daemon's own logger is overridable (`logLevel`); the resolver keeps the environment's. |

The security-relevant variables (also `SCANTOR_URL`, `SCANTOR_NODE_BUILTIN`, `SCANTOR_NODE_DIND`, `SCANTOR_CA_CERT`,
`SCANTOR_ALLOW_INSECURE_TRANSPORT`, `SCANTOR_ALLOW_UNISOLATED_NETWORKS` and `SCANTOR_NODE_EGRESS_DENY`) end the
daemon with exit code 2 when invalid; the others log a warning and keep their default (§5.1). The numeric bounds
of the overridable variables are those of `schemas/daemon-overrides.json`, which the environment and the overrides
share.

Everything else comes from the orchestrator, in the hello response `config` and in each assignments response:
intervals, drain grace, registry host, minimum free disk, the master's endpoint hosts, images, resources, the
worker environment and the daemon overrides. Node pool, labels and the admin worker limit (`maxWorkers` of the
node record) are **admin-owned** attributes of the node record (`createNode`/`updateNode`). The daemon does not
report them and cannot change them.

The daemon must run as a container with the Docker socket mounted. It uses its own container image as the
image of the egress helper (§9), of the node resolver and of its probe (§6.11), and its own rootfs to measure
free disk (§7.2). The `scantor` image runs as
root by default, which is required for the Docker socket. Docker Engine 25 or newer (API ≥ 1.44) is
required: on an older engine the daemon exits with code 2 at start (§5.1). Docker 29 is the tested
version.

## 3. Built-in node vs remote nodes

| | Built-in node | Remote node |
|---|---|---|
| Runs | the compose service `node` on the master ([deployment](deployment.md)) | `docker run … scantor node` on any Docker host |
| Record | upserted by the orchestrator at every boot: `builtIn: true`, name `builtin`, `endpointProfile: internal`, pool `shared` (admin-editable) | created by an admin (`createNode`), `endpointProfile: public` |
| Token | `snt_` + base64url(HKDF(`SCANTOR_SECRET`, `builtin-node`)), derived by both the daemon and the orchestrator. The orchestrator stores its SHA-256 as `tokenHash` at every boot, so a changed secret takes effect at the next boot. It cannot be rotated, revoked or deleted (409 `builtInNode`). | 32 random bytes, `snt_` prefix, shown once, stored as SHA-256; rotate and revoke per [architecture](architecture.md) §11.4 |
| `SCANTOR_URL` | `SCANTOR_INTERNAL_URL` (the orchestrator on compose network `scantor`) | `SCANTOR_PUBLIC_URL` |
| Worker network | `scantor-sandbox` (created by compose; the daemon only checks that it exists) | `scantor-workers` (created by the daemon, inter-container traffic disabled) |
| Node resolver (§6.11) | on the gateway of `scantor-sandbox`, in the master's host network; built-in workers still resolve `orchestrator`, `rabbitmq` and `rustfs` through Docker's embedded DNS | on the gateway of `scantor-workers`, in the node host's network |
| Registry host in image refs | `localhost:${SCANTOR_REGISTRY_PORT}` (the host daemon's loopback) | `SCANTOR_REGISTRY_PUBLIC_HOST` |
| Worker URLs (`SCANTOR_URL`, AMQP, S3) | internal profile | public profile ([architecture](architecture.md) §8) |
| DinD | `SCANTOR_BUILTIN_NODE_DIND`. Keep it `disabled`: enabling DinD here makes every user with `canRunPrivileged` root on the master. | `SCANTOR_NODE_DIND` |
| Max workers | `SCANTOR_BUILTIN_NODE_MAX_WORKERS`, kept small: the master also runs MongoDB, RabbitMQ, RustFS and builds | `SCANTOR_NODE_MAX_WORKERS` (`0` = number of CPUs) |
| Daemon overrides (§6.12) | survive orchestrator restarts (the built-in daemon keeps its instance); a restart of the `node` service clears them | cleared when the daemon restarts |
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

`compose` (written to `compose.yml` in an empty directory, then `docker compose up -d`). Its comments name
the two changes a rootless Docker host needs: the user's socket `/run/user/<uid>/docker.sock` as the mount
source, and `SCANTOR_ALLOW_UNISOLATED_NETWORKS=true` when root has not loaded `br_netfilter` (§6.8). The
one-line `dockerRun` has no room for comments; edit its `-v` source the same way.

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
      # rootless Docker: /run/user/<uid>/docker.sock:/var/run/docker.sock
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - SCANTOR_URL=https://scantor.example.com
      - SCANTOR_NODE_TOKEN=snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9
      # optional:
      # - SCANTOR_NODE_MAX_WORKERS=8
      # - SCANTOR_NODE_DIND=sysbox
      # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...
      # rootless Docker without br_netfilter (workers can then reach each other):
      # - SCANTOR_ALLOW_UNISOLATED_NETWORKS=true
```

The UI shows both snippets next to a checklist:

1. Docker Engine ≥ 25 on the node host.
2. Outbound HTTPS from the node host to `SCANTOR_PUBLIC_URL`, `SCANTOR_REGISTRY_PUBLIC_HOST`,
   `SCANTOR_S3_PUBLIC_URL` and the AMQPS endpoint of `SCANTOR_AMQP_PUBLIC_URL`.
3. Outbound HTTPS to the registry of the node image (`ghcr.io`, or the mirror that `SCANTOR_IMAGE_PREFIX`
   names): the join command pulls the daemon image from there, also for upgrades. Base-image layers come
   from there too when it is reachable (an optimisation, §10).
4. For a private CA, the host Docker daemon must trust the CA for the registry host (§10.3).
5. For `SCANTOR_NODE_DIND=sysbox`, Sysbox must be installed on the host.

## 5. Daemon lifecycle

### 5.1 Start-up

```
1. load env; validate (exit 2 on invalid security-relevant values: unknown DinD or DNS mode, malformed CIDRs,
   upstream or root servers, local domains or override keys, both token sources)
2. check transport for SCANTOR_URL (§11); exit 2 when refused
3. connect to Docker (client.FromEnv, API version negotiation, User-Agent scantor-node/<version>)
4. info := docker /info; self := inspect own container (§2)
   exit 2 when the engine's API is older than 1.44 (Docker Engine 25); other Docker errors are retried
5. instanceId := info.ID + ":" + 8 random hex chars           // engine ID + boot nonce
6. found := list managed worker containers (§6.1)
7. hello loop (§5.2) with containers = found, until 200
8. start, concurrently:
     network check (§6.8)           — scantor-workers (remote) / verify scantor-sandbox (built-in); records the
                                      gateway and subnets of the worker network
     resolver manager (§6.11)       — the first loop after the network check; start() never waits for it
     egress loop (§9)               — apply now, re-apply every 10 min
     adopt (§6.1)                   — track found containers of this node; no removals before the first assignments response
     assignments loop (§5.3)        — applies the daemon overrides (§6.12) before the desired set
     reconcile loop (§6)
     status loop (§7)
     docker events watcher          — label=scantor.managed=true, type=container; resolver events of this node
                                      kick the resolver manager (health_status included); other events trigger
                                      reconcile (except the exec_* and health_status events of healthcheck probes,
                                      §6.3); a reconnect does both
     image GC loop (§8)             — every 10 min
```

No step waits for the node resolver: status reports, the lease and adoption never depend on it, so a resolver
that never becomes healthy cannot make the node go offline. Only a worker that needs a new container in the first
seconds waits, at most for the settle window of §6.11.

### 5.2 Hello and the instance lease

`POST /api/node/hello` ([api](api.md) §7.1) carries `instanceId`, `version`, `info` and the managed
containers found at start (`containers[]`, for adoption), plus the optional reports `info.resolver` (the
resolver report the daemon process already holds from an earlier session, otherwise absent, because the node id
is unknown before the first hello) and `daemonConfig` (§6.12). On the orchestrator:

| Condition | Result |
|---|---|
| unknown or revoked token | 401 `unauthorized` |
| version outside the window (same or previous minor) | 426 `incompatibleVersion` |
| `node.instance` is null, or `instance.id == instanceId`, or `instance.lastSeenAt < now − SCANTOR_NODE_OFFLINE_AFTER` | lease granted |
| `instance.id` has the **same engine ID** (part before `:`) but a different nonce | lease taken over immediately: a restarted daemon on the same host. The previous instance gets 409 on its next request and stands by (below). |
| a live lease of a **different** engine | 409 `nodeInstanceConflict`, `details.retryAfterMs` = remaining lease time; event `node.instanceConflict` |

On success the orchestrator sets `instance = {id, version, startedAt, lastSeenAt}`, stores `info`, sets
`state: online` and `lastSeenAt`, emits `node.online`, and returns `{serverTime, node, config}`. A hello whose
`instanceId` differs from the stored instance (a new daemon process) also clears the node's daemon overrides
(event `node.daemonOverridesCleared` when they held values); a hello of the same instance keeps them. Every hello
replaces the stored daemon configuration with its report, or with null without one (§6.12), and `info` with its
own, so a hello without a resolver report leaves no `info.resolver` behind.

`config` fields: `statusIntervalMs` (`SCANTOR_NODE_STATUS_INTERVAL`), `assignmentsWaitSeconds`
(`SCANTOR_NODE_ASSIGNMENTS_WAIT`), `offlineAfterMs` (`SCANTOR_NODE_OFFLINE_AFTER`), `drainGraceMs`
(`SCANTOR_WORKER_DRAIN_GRACE`), `registry {host, username: "node"}`, `minFreeDiskBytes`
(`SCANTOR_NODE_MIN_FREE_DISK`) and `endpointHosts`, the host names of every URL the orchestrator gives the
node's workers ([architecture](architecture.md) §8), which the node resolver resolves through the host
nameservers (§6.11). `minFreeDiskBytes` is a backbone change request, see §15. A change of `endpointHosts`
between hellos changes the resolver's configuration and replaces it.

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
  applyOverrides(resp.daemonOverrides)                 // §6.12; before the desired set, so new workers see them
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
node whose node resolver was `ready` (§6.11) on the gateway `10.10.0.1` of `scantor-workers`. The values are
those of the [api](api.md) §7.2 example: `processes` 2, 1 CPU and 512 MiB per process, so 2 CPUs and
2 × 512 MiB + 256 MiB = 1280 MiB.

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
  "Healthcheck": {
    "Test": ["CMD", "/scantor/scantor", "runtime", "healthcheck"],
    "Interval": 30000000000, "Timeout": 10000000000, "Retries": 3,
    "StartPeriod": 120000000000, "StartInterval": 5000000000
  },
  "HostConfig": {
    "Init": true,
    "RestartPolicy": { "Name": "no" },
    "NetworkMode": "scantor-workers",
    "Dns": ["10.10.0.1"],
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
| `Healthcheck` | `/scantor/scantor runtime healthcheck` every 30 s (timeout 10 s, 3 retries, start period 2 min, start interval 5 s) | The runtime's heartbeat check ([runtime](runtime.md) §5.3): healthy while the orchestrator answers the worker's state polls. It replaces any `HEALTHCHECK` of the task image (Dockerfile policy W1, [tasks](tasks.md) §8.2). Docker only reports the status (`docker ps`); the daemon's restart logic does not use it, and the daemon's events watcher ignores the probes' `exec_*` and `health_status` events (§5.1). The start period covers bootstrap, an inner `dockerd` (§6.9) and the broker connect. |
| `Init` | `true` | `docker-init` is PID 1. It reaps zombies (Chromium, subprocesses) and forwards SIGTERM to the runtime. |
| `RestartPolicy` | `no` | The daemon owns restarts and backoff (§6.5). Docker never restarts workers on its own, also not after a host reboot. |
| `NetworkMode` + `EndpointsConfig` | `scantor-sandbox` (built-in) / `scantor-workers` (remote) | Exactly one network (§6.8). No published ports, no aliases. |
| `Dns` | `[<IPv4 gateway of the worker network>]` while the node resolver is `ready` at that gateway when the container is created; unset otherwise (Docker's DNS, the host's nameservers) | The worker's `resolv.conf` stays Docker's embedded DNS `127.0.0.11`, which answers container and service names and forwards every other name to this server. The choice is fixed for the container's life: DNS cannot change through `ContainerUpdate`, and workers are never recreated because of it (§6.11). It is not part of the `specHash`. |
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

The values named by a `SCANTOR_NODE_*` variable (`PidsLimit`, `ShmSize`, `nofile`, the log rotation) come from
the daemon configuration: the variable, or its daemon override (§6.12). Each create reads one snapshot of it, so
an override applies to workers created afterwards and never changes a running one.

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

After every check the daemon inspects the worker network again and records its IPv4 gateway and subnets, the
listen address and the client ranges of the node resolver (§6.11); a change of either kicks the resolver
manager, which replaces the resolver. Docker removes a network only while no running container is attached, so the
gateway changes only when no running worker uses the old one. Without these facts (the network is missing or not
usable) the resolver state is `failed` with `noNetwork`.

**Unisolated networks (explicit opt-in).** A Docker daemon that cannot restrict inter-container traffic
refuses `enable_icc=false` (rootless Docker without the `br_netfilter` module: `cannot restrict
inter-container communication`). Such a node runs no worker unless `SCANTOR_ALLOW_UNISOLATED_NETWORKS=true`
is set in its environment. With it, the daemon first still asks for an isolated network; only when the
daemon refuses does it create `scantor-workers` as a plain bridge (same driver, IPv6 off and labels), and an
existing network that differs from the table only in `enable_icc` is accepted. The orchestrator handles
`scantor-egress` (test runs and git helpers on the master) the same way with the same variable. Containers on
such a network can reach each other, across scans and users, so the opt-in never happens on its own:

- every daemon reports `networkIsolated` in hello and status (§7.1): a remote node for `scantor-workers`; the
  built-in node for `scantor-egress`, because master workers share `scantor-sandbox` with the platform
  services by design;
- the daemon logs a warning when its network loses isolation, the orchestrator one at boot, and Admin → Nodes
  shows "Network not isolated" ([ui](ui.md) §5.15).

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

### 6.11 Node resolver

Every node runs one **node resolver** ([architecture](architecture.md) D26): a DNS server built on the zdns
library, compiled into the `scantor` binary (package `internal/resolver`, the only importer of zdns and of its DNS
library `github.com/zmap/dns`) and run by the daemon from its own image as the hidden `scantor node resolver serve`.
Every worker of the node resolves names through it, so a node has one cache and one fan-out instead of one stub
resolver per connector process. Mode `recursive` resolves through the upstream servers, mode `iterative` from the
root servers, and in both zdns performs the lookups; mode `disabled` runs no resolver, and workers use Docker's DNS
(the behaviour before the node resolver existed). Mode and settings come from the `SCANTOR_NODE_DNS_*` variables
(§2) or their daemon overrides (§6.12).

#### 6.11.1 Networking

- Workers keep exactly one network and the `resolv.conf` Docker writes for user-defined networks: the embedded DNS
  `127.0.0.11`. It still answers container and service names (`orchestrator`, `rabbitmq` and `rustfs` for built-in
  workers) and forwards every other name to `HostConfig.Dns`, from the worker's own network namespace, with a fresh
  socket per query, a 4 s timeout and at most 1024 forwards per container; SERVFAIL or REFUSED moves on to the next
  server, and with none left the client gets SERVFAIL.
- A worker created while the resolver is `ready` gets `HostConfig.Dns = [<IPv4 gateway of the worker network>]`
  (§6.11.5). That traffic is local delivery on the host (INPUT), so `enable_icc=false` and `DOCKER-USER` do not
  apply, and its source address is the worker's own address in the worker subnet.
- The resolver binds only `<gateway>:53`, UDP and TCP, with `SO_REUSEPORT`, and never a wildcard address. Port 53 is
  forced, because Docker's `Dns` has no port. Other hosts normally have no route to the gateway address, and the
  resolver answers only sources in the worker network's subnets anyway (REFUSED otherwise), so it is never an open
  resolver.
- Its own queries leave from the host network namespace, where the egress deny chain (§9) does not apply; the
  server guard (§6.11.7) refuses the deny-list ranges and every private range itself, except for the servers the
  node's own configuration names: the host nameservers and the environment's upstream and root servers.
- Test runs, editors, git helpers and script runs keep Docker's DNS (describe and check containers have no
  network), so a task can resolve names differently in a test run than in a scan.

Limitations, each detected and reported as the resolver state with an error code (§6.11.5) and a hint in the
daemon log:

| Situation | Effect | Fix |
|---|---|---|
| rootless Docker with RootlessKit `--detach-netns` (the default of current `dockerd-rootless.sh`) | host-network containers join dockerd's own namespace, which does not hold the worker bridges: the bind fails with `bindUnavailable`, and workers keep Docker's DNS | `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false` in the environment of the user's `docker.service`; host-network containers then share RootlessKit's namespace ([deployment](deployment.md) §10.1) |
| a host DNS server bound to `0.0.0.0:53` without `SO_REUSEPORT` (dnsmasq without `bind-interfaces`, unbound, CoreDNS, AdGuard Home, Pi-hole) | `bindInUse`. The other way round, a resolver bound first makes a later wildcard bind of such a server fail | bind the host's DNS server to its own interfaces (dnsmasq `bind-interfaces` or `except-interface=br-*`, unbound `interface:`) |
| a host firewall that drops traffic from the bridge to the host's port 53 (ufw, an nftables or iptables INPUT policy) | the probe fails: `unreachable`, and new workers keep Docker's DNS | allow it by address, because the bridge name `br-<network id>` differs on every host: `ufw allow from <subnet> to <gateway> port 53 proto udp` and the same with `proto tcp`; the daemon log names subnet and gateway. firewalld's `docker` zone already accepts it |
| user-namespace remapping (`/info` security option `name=userns`) | a host-network container is refused without `UsernsMode: host` | the daemon sets it for the resolver and for the egress helper on the host network (§9) |
| Docker-in-Docker workers (§6.9) | containers on user-defined networks of the inner dockerd go through the resolver (the inner embedded DNS forwards from the worker's namespace); containers on the inner default bridge use public DNS | – |

#### 6.11.2 Container spec (kind `resolver`)

```
name        scantor-dns-<nodeId>-<hash12>                    (hash12: first 12 hex digits of the spec hash)
labels      ManagedLabels(KindResolver, Identity{Node, SpecHash})  scantor.spec-hash = "sha256:<64 hex>"
image       the daemon's own image id (self-inspection, as for the egress helper); none → state failed
            (noImage), workers keep Docker's DNS
Entrypoint  ["/usr/local/bin/scantor"]
Cmd         ["node", "resolver", "serve", "--spec-hash", "<sha256:…>", "--config", "<compact JSON, §6.11.6>"]
User        "0:0"
Env         ["GOMAXPROCS=<min(cpus, 16)>", "GOMEMLIMIT=<80 % of Memory>"]
StopTimeout 10 (container.Config)
Healthcheck ["CMD", "/usr/local/bin/scantor", "node", "resolver", "healthcheck"]: interval 10 s, timeout 5 s,
            retries 3, start period 30 s, start interval 1 s   (container.ResolverHealthcheck)
HostConfig  NetworkMode host; UsernsMode host only when userns-remap is on; CapDrop ALL;
            CapAdd [NET_BIND_SERVICE]; SecurityOpt [no-new-privileges:true]; ReadonlyRootfs true;
            Tmpfs {"/run": "size=1m"}; PidsLimit 1024; Memory = MemorySwap = 2 × cacheBytes + 768 MiB;
            Ulimits nofile = max(65536, 4 × maxLookups + 1024) soft = hard; RestartPolicy no;
            LogConfig local, max-size 10m, max-file 3; no mounts; no Init
```

- `GOMAXPROCS` bounds the Go runtime's threads (healthcheck execs inherit it and run in the same pids cgroup), and
  `GOMEMLIMIT` with the memory limit makes a cgroup OOM kill only the resolver, never the host's other processes.
- `RestartPolicy: no`: the daemon owns restarts, as for workers. A resolver that exits is started again by the
  manager on its `die` event or at its retry time: every exit counts as a failure of its spec, the starts back off
  from 2 s, doubling up to 5 min, three exits in a row report `crashLoop`, and a healthy resolver resets the backoff.
  A `dead` resolver of the desired spec is removed and created again. The daemon leaves the resolver running on
  SIGTERM and when it aborts a session (409, 426), like workers, so a daemon restart or upgrade does not interrupt
  name resolution; the next daemon instance adopts it.
- **Spec hash** = `sha256:` + the hex SHA-256 of the canonical JSON `{image: <image id>, config: <the configuration
  of §6.11.6 with every list sorted and deduplicated>}` (`resolver.SpecHash`). The resolver's log level and format
  come from the daemon's environment (`SCANTOR_LOG_LEVEL`, `SCANTOR_LOG_FORMAT`), never from the `logLevel`
  override, and are not part of the hash. A daemon upgrade (a new image) and every change of `dns.*`, of the
  network facts or of the endpoint hosts therefore replaces the resolver, and its cache starts empty.

#### 6.11.3 Probe container (kind `resolverProbe`)

The probe checks the workers' own path: a one-shot container `scantor-dnsprobe-<nodeId>`, created with the egress
helper's mechanics (removal of a leftover, refusal of a foreign container of that name, a forced remove at the end
that survives cancellation, the last stdout line as the JSON result):

```
image own; Entrypoint scantor; Cmd ["node","resolver","probe"]; User 65534:65534; Env ["GOMAXPROCS=2"];
NetworkMode <worker network>; Dns [<gateway>]; CapDrop ALL; no-new-privileges; ReadonlyRootfs; PidsLimit 128;
Memory 64 MiB; RestartPolicy no; Healthcheck NONE; ManagedLabels(KindResolverProbe, Identity{Node});
LogConfig local, max-size 1m, max-file 1, compress false   (container.OneShotLogConfig)
```

The explicit log driver lets the daemon read the result whatever the engine's default driver (`none`, a remote
driver); the `local` driver refuses compression with a single file, hence `compress false`.

`scantor node resolver probe` looks up `TXT resolver.scantor.invalid.` through the container's normal resolver (Go's
pure resolver, `127.0.0.11`, the embedded DNS, the gateway), exactly a worker's path. The resolver answers that name
itself with one TXT string `scantor-resolver node=<nodeId> spec=<specHash>`. The probe prints
`{"ok":true,"node":"…","spec":"sha256:…","ms":3}` or `{"ok":false,"error":"<code>"}`. An answer from another
node's resolver sets the state `failed` with `foreignResolver`.

Cadence: at every manager start (also when it adopts a running resolver after a daemon restart), after every
replacement, every 10 min while `ready`, and every 60 s while `unreachable`. A failed lookup is repeated once after
5 s; the second failure in a row makes the state `unreachable`. Errors of the probe's own infrastructure (create,
start, wait, reading its output) are logged and retried with a backoff from 5 s to 60 s; they never change the state:
only a probe that completed a lookup (answered by this node, by another node, or failed) does, and a successful probe
stays valid beyond its 15 min while every probe since then failed for such a reason (§6.11.5). Probes are created only
while the daemon may create containers (never in unauthorized mode, §7.4).

#### 6.11.4 Manager (`internal/node/resolver.go`)

One goroutine, `resolverLoop`, started as the **first** loop after the network check of a session; `start()` never
waits for it. It runs a pass on every trigger (a capacity-1 kick channel): session start; a change of the network
facts (§6.8); applied daemon overrides that change `dns.*`; a change of the hello's `config.endpointHosts`; Docker
events of kind `resolver` of this node (handled before the probe-event filter of §5.1: `exec_*` events are ignored,
`health_status: …` counts); a reconnect of the event stream; and its timers (a pass every 30 s, a stats refresh
every status interval, the probe timer). All Docker I/O for the resolver happens here.

```
pass():
  desired := desiredResolver()                     // mode, configuration, image, hash; disabled when the mode is
                                                   // disabled or the session purged its workers (§7.4)
  own, foreign := list kind=resolver containers    // label + name prefix; misnamed or foreign: ignored, logged once
  if desired.disabled:
      if any worker container of this node exists  // the count of the last reconcile pass, else one list call
          → keep the own resolvers as they are (state disabled, kept = true); when none runs, start a stopped one,
            the one on the current gateway first, with the restart backoff of its spec (an exit is a failure;
            a die event before the retry time starts nothing); a dead one is never started (logged once)
      else → remove every own resolver (stop t=10 with steering, §6.11.8; force remove); state disabled
      return
  if desired has a problem → state failed with it, touch nothing, return
                                                   // noNetwork: no network facts (§6.8); noImage; createFailed:
                                                   // resolver.Config.Validate refuses the configuration
  if a foreign running resolver listens on the gateway → failed (foreignResolver), touch nothing, return
  cur, others := the own container whose scantor.spec-hash == desired.hash, the other own containers
  ensure cur (each step only after the retry time of the spec's backoff):
      cur == nil       → create + start it, unless the daemon may not create containers
      cur is dead      → remove it (the next pass creates it again)
      cur is created or exited → start it; an exit is a failure of the spec (2 s doubling up to 5 min,
                                  crashLoop after 3 in a row)
  wait while cur starts (inspect every resolverPoll, at most resolverHealthWait = 30 s after its start)
  judge cur against old := a healthy other on the current gateway:
      cur healthy      → stop (t=10, with steering) and remove every other own resolver; reset the backoff;
                         run the probe; cur serves
      cur exited and old exists → remove cur; backoff of the spec 10 s doubling up to 5 min; old serves (crashLoop)
      cur not running  → old serves, if any
      cur unhealthy (or still starting at the deadline) and old exists → a failed replacement: stop cur
                         (t=10, then force remove); backoff 10 s doubling up to 5 min; old serves, with cur's error
      cur in its start period → nothing yet
      cur unhealthy for upstreamUnreachable or a bind error → keep it as it is: the resolver retries its upstream
                         check and its bind itself (degraded, or failed with the bind error)
      cur unhealthy for another reason for 3 passes in a row → ContainerRestart t=2 (once per backoff step);
                         failed (unhealthy)
  report := the state of the serving resolver (§6.11.5)
```

- The manager publishes an immutable report in a **daemon-level** atomic pointer that outlives sessions. Status
  reports and hello only read it, so the heartbeat never waits for a Docker call; the manager calls for an early
  status only on state transitions, never for new stats.
- A daemon-wide read-write lock orders the DNS choice against removals: the manager holds it exclusively while it
  publishes `disabled` and lists or removes resolvers; a worker create holds it shared from the DNS choice through
  `ContainerCreate`, so no worker is ever created with the gateway of a resolver that is being removed.
- SIGTERM and a session abort leave the resolver running (§7.5). Unauthorized mode (§7.4) marks the session purged,
  which makes the desired resolver `disabled`, so the resolver goes once the drained workers are gone.

#### 6.11.5 States and the worker DNS choice

`info.resolver.state` (status and hello, [api](api.md) §7.3):

| State | Meaning |
|---|---|
| `starting` | a resolver was created or adopted and is not yet healthy or not yet probed at the current gateway |
| `ready` | a resolver of this node at the current gateway runs, is healthy (its upstream check passes) and the last probe succeeded (at most 15 min ago, or longer while every probe since then could not run, §6.11.3); new workers use it |
| `degraded` | it runs, but its upstream check fails (no upstream or root server answers); new workers use Docker's DNS |
| `unreachable` | it runs and is healthy, but the probe from the worker network kept failing, its retries included (§6.11.3; a host firewall, …); new workers use Docker's DNS |
| `failed` | it cannot serve: no image, no network, an invalid configuration (no container is created), a bind error, a foreign resolver, a crash loop, unhealthy; `error` is set |
| `disabled` | mode `disabled`; `kept: true` while a resolver still runs for existing workers |

During a replacement the state is that of the resolver that is serving (the old one) until the swap; a failed
replacement reports the old resolver's state with the replacement's error.

`error` is a fixed code, never log text, so nothing a scanned target controls reaches the API, the UI or MCP:
`noImage`, `noNetwork`, `bindInUse` (port 53 of the gateway held by another process), `bindUnavailable` (the
gateway is not an address of the daemon's network namespace: rootless `--detach-netns`), `bindDenied`,
`foreignResolver`, `upstreamUnreachable`, `unhealthy`, `crashLoop`, `probeFailed`, `createFailed` (the container
could not be created or started, or `resolver.Config.Validate` refused the configuration the daemon built, §6.11.6).
An optional short `detail` (at most 256 characters of letters, digits, spaces and `.:,;/[]()=%+_-`) is composed by
the daemon from addresses and numbers, and for an invalid configuration from the validation message of the node's
own configuration (line breaks become `; `, other characters are dropped), never from anything a scanned zone
sends. The report also carries `mode`, `address` (the gateway), `kept`, `since`, `spec` (the serving resolver's spec
hash), `ipv6`, `upstreamOk` and `stats` (`queries`, `cacheHits`, `lookups`, `failures` = SERVFAIL answers + timeouts
+ overloaded refusals, `inflight`, `qps`, `conntrackUsed` = the host's `nf_conntrack_count / nf_conntrack_max`).
The daemon takes `upstreamOk`, `ipv6` and the stats from the newest `State.Health.Log` entry whose first line
parses as stats with the serving resolver's `spec`, whatever its exit code (a failing check prints them too, so a
`degraded` resolver reports `upstreamOk: false` with fresh counters); while none of the five entries Docker keeps
parses, the last values seen for that container stay. Without any (`stats: null`), `upstreamOk` and `ipv6` are
false and mean "unknown".

The orchestrator records the event `node.resolverFailed` (warning) when the state enters `failed`, `degraded` or
`unreachable`, and `node.resolverReady` (info) when it is `ready` after one of them, also when `starting`,
`disabled`, absent or invalid reports or the hello of a new daemon instance came in between: the node document
keeps the last failing state (`resolverFailedState`, [data model](data-model.md) §4.8) until a `ready` report. A
first `ready`, such as `starting` → `ready` after a daemon start, records nothing. Hello and status judge the
transition against the report stored before their own atomic update, so overlapping reports record a change once.

**Worker DNS choice** (`workerDNS()` in the worker actor, after the image is present and before
`ContainerCreate`, and before an exited worker whose `Dns` is the gateway is started again):

- the report is `ready` and its gateway equals the current network gateway → `Dns = [gateway]`;
- the report is absent or `starting`, and the settle window (45 s after the manager started or decided to create a
  resolver) has not passed → the actor waits and retries the step, at most until the window ends;
- otherwise → no `Dns` (Docker's DNS), with one warning per state change.

The choice is fixed for the container's life. A switch between `recursive` and `iterative` changes nothing for
existing workers (they keep using the gateway, served by the new resolver), and no label records the choice.

#### 6.11.6 Resolver configuration and routing

The daemon builds the configuration (`resolver.Config` in `internal/resolver/types.go`), checks it with
`resolver.Config.Validate` and passes it as compact JSON with `--config`; `resolver.ParseConfig` rejects unknown
fields and applies the same checks. A configuration that `Validate` refuses never gets a container: the state is
`failed` with `createFailed` and the cleaned validation message as `detail`, the daemon log carries the whole error
with a hint to check `SCANTOR_NODE_DNS_*`, `SCANTOR_NODE_EGRESS_DENY` and the node's `dns` daemon overrides, new
workers use Docker's DNS, and a resolver that already runs is left alone.

```json
{
  "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "listen": "10.10.0.1:53",
  "clients": ["10.10.0.0/24"],
  "mode": "recursive",
  "upstreams": ["1.0.0.1:53", "1.1.1.1:53", "8.8.4.4:53", "8.8.8.8:53"],
  "useHostNameservers": false,
  "rootServers": [],
  "localNames": ["amqp.scantor.example.com", "s3.scantor.example.com", "scantor.example.com"],
  "localDomains": ["10.in-addr.arpa", "16.172.in-addr.arpa", "…", "corp.example", "home.arpa", "internal", "localhost"],
  "denyServers": ["100.100.100.200/32", "169.254.0.0/16", "fd00:ec2::254/128"],
  "trustedServers": ["1.0.0.1:53", "1.1.1.1:53", "8.8.4.4:53", "8.8.8.8:53"],
  "cacheBytes": 268435456,
  "maxLookups": 1000,
  "upstreamQps": 0,
  "authoritativeQps": 200,
  "logLevel": "info",
  "logFormat": "json"
}
```

Every list is sorted and deduplicated (the spec hash depends only on the content).

- `clients`: the worker network's subnets; the listen address is always allowed; every other source gets REFUSED.
- `upstreams`: `ip:port`; the keyword `host` of `SCANTOR_NODE_DNS_UPSTREAMS` becomes `useHostNameservers: true`, which
  uses the host nameservers as upstream servers.
- `rootServers`: empty means zdns' built-in IANA root servers; a custom list is never filled up with them.
- `localNames`: the hello's `config.endpointHosts` and the host of the daemon's own `SCANTOR_URL`.
- `localDomains`: the built-in always-local suffixes and `SCANTOR_NODE_DNS_LOCAL_DOMAINS`.
- `denyServers`: the CIDRs of `SCANTOR_NODE_EGRESS_DENY` (at most 4096).
- `trustedServers`: every upstream and root server of the node's environment (`SCANTOR_NODE_DNS_UPSTREAMS` without
  `host`, and `SCANTOR_NODE_DNS_ROOT_SERVERS`), whatever its address, also while daemon overrides replace the
  servers or the mode. The guard allows a trusted server on its own route even inside the always-refused ranges,
  the deny list or the node's own addresses (for example the test stack's `172.17.0.1`, §6.11.7). Servers set by a
  daemon override are never trusted; the daemon and the orchestrator reject those in such ranges (§6.12.2).

`upstreams`, `rootServers` and `trustedServers` take `ip:port` or `[v6]:port`. `ParseConfig` refuses zoned
addresses and IPv6 link-local ones ("IPv6 link-local and zoned addresses are not supported"), multicast and
unspecified addresses ("not a unicast address"), port 0 and anything else that is not `ip:port` or `[ipv6]:port`;
IPv4 link-local servers such as `169.254.169.253` are valid. The daemon checks the variables and the overrides with
the same rules first (§2, §6.12.2).

The router decides per question, in this order:

1. `resolver.scantor.invalid.` TXT → the local probe answer (other types: NODATA).
2. `invalid.` and below, `onion.` and below → NXDOMAIN, answered locally and never forwarded.
3. Exactly `localhost.` → A `127.0.0.1`, AAAA `::1`, otherwise NODATA (local). Names below `localhost.` are not
   special, so a master under `*.localhost` stays resolvable through rule 4 or 5.
4. A `localNames` entry (exact) → the **local route**: the host nameservers.
5. A built-in always-local suffix (`localhost`, `internal`, `home.arpa`, `10.in-addr.arpa`, `16.172.in-addr.arpa` …
   `31.172.in-addr.arpa`, `168.192.in-addr.arpa`, `254.169.in-addr.arpa`, `d.f.ip6.arpa`, `8.e.f.ip6.arpa`,
   `9.e.f.ip6.arpa`, `a.e.f.ip6.arpa`, `b.e.f.ip6.arpa`) or a `SCANTOR_NODE_DNS_LOCAL_DOMAINS` entry (suffix on a label
   boundary) → the local route.
6. Everything else → the engine of the mode.

The host nameservers are those Docker gives a host-network container: a copy of the host's `/etc/resolv.conf`
(systemd-resolved's `127.0.0.53` works), replaced by a daemon-level `dns` setting in `daemon.json`. The resolver
re-reads them every 60 s and keeps at most 16, each on port 53. It keeps IPv4 link-local nameservers, often a cloud's
only one (GCE's `169.254.169.254`), and drops zoned and IPv6 link-local addresses (they cannot be dialled without an
interface), unspecified and multicast addresses, addresses other than loopback of a family the node has no address of,
and its own listen address. The guard always allows them on the routes that use them, whatever the deny list
(§6.11.7).

Without a usable host nameserver, local names and local domains go to the mode's servers instead: the upstream
servers in mode `recursive`, and from the root servers in mode `iterative` (with the iterative time budget). The
stats report `hostNameservers: []`, and the resolver logs once "no usable host nameservers: local names (the master's
hosts, local domains) are resolved through the upstream servers" ("root servers" in mode `iterative`). A master or
a mirror that only internal DNS knows is then unresolvable for the workers, and those names reach the mode's
servers; a daemon-level `dns` setting in `daemon.json` gives the resolver usable host nameservers.

#### 6.11.7 Lookups, answers, cache and guard

- **Requests.** Questions are lowercased with the trailing dot trimmed; a name containing `\`, the root, or a name
  longer than 253 characters gets REFUSED and never reaches zdns. Opcode other than QUERY → NOTIMP; a question count
  other than 1 → FORMERR; a class other than IN → REFUSED; AXFR and IXFR → REFUSED. ANY is forwarded as is in the
  recursive and local routes and answered with HINFO `RFC8482` in mode `iterative` (RFC 8482). Every reply has
  RA=1, AA=0, AD=0 and the CD bit of the query. A query with OPT gets OPT (UDP size 1232, DO=0, no options); an
  EDNS version other than 0 gets BADVERS. UDP replies are truncated (TC=1) to the client's EDNS size (512–1232) or to
  512 bytes; TCP replies may reach 65535 bytes.
- **Client TCP connections.** The listener closes a connection at accept when it does not come from a client (the
  ACL of `clients` and the listen address) or when 1024 connections are open in total or 32 from that client
  address (counter `tcpRejected`). An open connection is closed after 2 s without a query (also before the first)
  and after 16 queries. An accept that fails for lack of file descriptors or kernel memory (`EMFILE`, `ENFILE`,
  `ENOBUFS`, `ENOMEM`), or with `ECONNABORTED`, `EINTR` or `EPROTO`, pauses from 5 ms, doubling up to 1 s, and
  accepts again; outbound lookups keep the rest of the file descriptors.
- **PTR names** that zdns would reject (not letter-digit-hyphen, for example DNS-SD names) or rewrite (names that
  look like IP literals) are sent in the recursive and local routes as one direct exchange through the guarded dialer
  to a chosen server; mode `iterative` answers SERVFAIL for them.
- **Deadline and flights.** A client gets an answer or SERVFAIL within 3 s, below Docker's 4 s. One flight runs per
  cache key `(qname, qtype)`; it first takes a lookup slot (at most `maxLookups`) with the deadline of its first
  waiter, and a flight that gets no slot, or whose last waiter left before it got one, ends with SERVFAIL that is not
  cached. Once started, a lookup runs detached within its budget (6 s for the recursive and local routes, 15 s
  iterative) and fills the cache. One client address starts at most `max(16, maxLookups / 4)` flights and waits
  for at most `max(64, maxLookups / 2)` answers at once (flights it started or joined), so one client cannot hold
  the global caps; beyond those, more than `8 × maxLookups` waiting clients or more than `2 × maxLookups` pending
  flights, a query gets SERVFAIL at once (counter `overloaded`), never cached. Fairness is per client address, not
  per scan: a scan with several workers on the node has several addresses.
- **Query budget.** One client lookup sends at most 64 queries: every attempt and CNAME or DNAME hop, zdns' own
  lookups of name server addresses, TCP fallbacks and direct PTR exchanges, including the queries the guard or a
  rate limit refuses. The 65th ends the lookup's context, so zdns stops at once; the client gets SERVFAIL, a local
  failure that is never cached (counter `queryBudgetExceeded`). This bounds the amplification of hostile
  delegations with many name servers (NXNS). The self-checks have no budget.
- **Retries.** zdns runs with `Retries 0`; the engine retries: at most 3 attempts over distinct servers in the
  recursive and local routes, at most 3 per hop iteratively, only after TIMEOUT, ITERATIVE_TIMEOUT, SERVFAIL, REFUSED
  or ERROR, never after NXDOMAIN or NOERROR. So an NXDOMAIN costs one query.
- **Answers come only from captured messages.** The dialer wraps every connection zdns opens and captures every
  message whose QR bit is set and whose ID and question equal the query it wrote, on a connected socket; zdns' status
  and its result are never used to build a reply. The recorder of an attempt keeps only replies to the attempt's
  question, and at most one of them (at most 64 KiB): the first acceptable one in the recursive and local routes, the
  last acceptable one in the iterative route; other replies are only counted. Recursive and local: the reply is the
  first accepted message of an attempt (the question, TC=0, rcode NOERROR or NXDOMAIN, and not a referral, which is
  NOERROR with RA=0, no answer and no SOA), with its rcode, answer and authority copied verbatim and the additional
  section dropped. A TC=1 message is never final (only truncated replies → SERVFAIL, counter `tcpFallbackFailures`).
  Iterative: zdns follows no CNAME (`FollowCNAMEs false`); the engine walks the chain itself for at most 16 hops,
  takes per hop the last accepted message that is authoritative, an NXDOMAIN or holds a record of the hop's name,
  keeps only records owned by the hop name (DNAMEs of a proper ancestor synthesise the CNAME), and answers SERVFAIL
  for a loop, a failed target or an incomplete chain; NXDOMAIN and NODATA carry the SOA of an ancestor-or-self of the
  last name.
- **Trimmed replies in the iterative route.** zdns caches delegations and name server addresses under names the
  zones choose, so the capture trims every reply of the iterative route before zdns parses it (the engine still
  answers from the original reply). A reply whose rcode is not NOERROR, and an authoritative reply to the hop's
  question, pass unchanged. Every other reply keeps in its authority section only the NS records of the first NS
  owner (at most 13) and at most one SOA, in its additional section the OPT record and the A and AAAA records of the
  kept name servers (at most 26), and in its answer section everything for a non-authoritative answer to the hop's
  question, otherwise (the questions zdns asks itself) at most 26 records; all kept records together are at most
  4096 bytes, filled in the order answer, NS, SOA, glue. A reply that does not answer the hop's question and is
  larger than 16 KiB on the wire (in practice a TCP reply) reaches zdns as an empty SERVFAIL.
- **Caches.** zdns' own cache holds only delegations and server addresses: in mode `iterative` one entry per 16 KiB of
  `cacheBytes`, at least 16384 and at most 262144 entries (16384 up to 256 MiB, 65536 at 1 GiB), and 4096 entries
  recursively. Trimmed replies keep an entry well below 16 KiB (about 7 KB for hostile delegations), so it holds at
  most about `cacheBytes`, the second `cacheBytes` of the container's memory limit (§6.11.2). Before every attempt the
  engine removes the question's own keys from it, so zdns never answers a client question from it. The answer cache is
  the resolver's: bounded by `cacheBytes`, 64 shards, least recently used first out; answers larger than 16 KiB (wire
  format, uncompressed) are served but not cached. It counts the estimated memory of an entry, not its wire size:
  every record with what it references (structs, strings, slices, rounded to the allocator's sizes), the entry and its
  record slices, plus 256 bytes and the name per key (an NXDOMAIN stored under its name as well counts twice);
  measured heap is 0.49–0.92 of the counted bytes, hostile record shapes included. A single A answer counts about
  512 bytes, so a given `cacheBytes` holds 2 to 2.5 times fewer typical answers than their wire sizes would fill, and
  the container's memory limit really bounds the cache. Positive answers live for the smallest TTL of the answer
  section, at most 1 h (a TTL of 0 is not cached); NXDOMAIN and NODATA for the smallest of the chain's TTLs, the SOA
  TTL, the SOA MINIMUM and 15 min (the served SOA carries that negative TTL; without a SOA 5 s); remote failures
  (servers answered SERVFAIL or REFUSED, or every server timed out) 5 s. Failures with a local cause (rate limit,
  overload, slot timeout, guard refusal, a spent query budget, a dial that found no file descriptor or kernel memory,
  a recovered panic, the client deadline) are never cached. An NXDOMAIN is also stored for its name and answers the
  name's other types (RFC 2308 §5). Served TTLs count down from the stored ones. Results are cached only under the
  client's question.
- **Server guard** (by IP and port, addresses normalised with `Unmap()`). The refused ranges are the always-refused
  ones (`resolver.AlwaysRefused`: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
  `192.0.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`,
  `ff00::/8`, `64:ff9b::/96`, `64:ff9b:1::/48`), the `denyServers` and the node's own interface addresses (refreshed
  every 30 s). The dialer allows, in this order:
  1. a host nameserver on the local route, and on the recursive route with `useHostNameservers`, whatever its
     address: the node operator configures them, and they never come from a reply or a worker;
  2. any other server outside the refused ranges, on every route, whether configured or found in glue;
  3. inside the refused ranges only a server configured for the route that is also a `trustedServers` entry, by
     address and port: an upstream server on the recursive route, a root server on the iterative route (at any
     layer).

  So the environment's servers work on loopback, private and deny-listed addresses and on the node's own address,
  while a daemon override's server in those ranges would always be refused, which is why the daemon and the
  orchestrator reject it (§6.12.2). A hostile delegation (glue `169.254.169.254`, `10.x`, `127.0.0.53`, the node's
  own address) is never dialled: zdns sees a dial error and tries other servers.
- **Rate limits.** A token bucket per server address (burst `max(1, qps / 5)`; a query waits at most 250 ms, then it
  is refused as a dial error, counter `rateLimited`) applies `upstreamQps` to upstream servers and host nameservers
  and `authoritativeQps` to every server of the iterative route. A refusal by a rate limit or by the guard reaches
  zdns as a failed query, and zdns' server health tracker counts it: it keeps an exponentially weighted failure
  score per server address (α 0.2, idle half-life 30 s, forgotten after 5 min), and its choice of server (the
  better of two random picks) prefers the route's other servers while one is throttled. The score only biases that
  choice and never excludes a server; a throttled lookup is never cached as a failure. Refusals for a spent query
  budget are not counted (the lookup's context ends first). The self-checks (§6.11.8) skip the rate limits and take
  no tokens.

#### 6.11.8 Self-checks, lifecycle and stats

- **Upstream check**, at start and every 30 s: in mode `recursive` a `. NS` query (RD=1) to up to 3 upstream
  servers (with the host nameservers when `useHostNameservers` is set), iteratively `. NS` (RD=0) to up to 3 root
  servers; any NOERROR answer passes. `upstreamOk` and `upstreamError` go into the stats. The healthcheck fails
  while it does not pass, so a replacement whose servers do not answer never takes a query or wins the swap, and the
  daemon reports `degraded`. Both self-checks pass the server guard, but skip the rate limits (they take no tokens,
  so lookups that hold a server's bucket at its maximum wait never fail them) and have no query budget.
- **IPv6 check**, at start and every 10 min: `. NS` to up to 2 IPv6 servers of the mode with a 2 s timeout; IPv6
  servers are used only while it passes (`ipv6` in the stats). When every configured server is IPv6 and the check
  fails, the upstream check fails too.
- **Serving**: parse the configuration, bridge zdns' logrus output into the daemon's log format (debug maps to
  debug; info and warn to warn, so there is no line per query; error to error), read the host nameservers, build the
  engines, bind UDP and TCP on `listen` with `SO_REUSEPORT` and a receive buffer of up to 4 MiB (a bind error is
  written to the state file with `ready: false` and retried every 5 s; the process never exits for it), steer the
  reuseport group (below), run the checks, and rewrite the state file `/run/scantor-resolver/state.json` every
  second. One info line with the stats every 60 s.
- **Blue/green replacement without lost queries** (`handover.go`, Linux). Two resolvers of one node share
  `<gateway>:53` through `SO_REUSEPORT` while a replacement runs. The kernel hashes new datagrams and connections over
  the sockets of the group unless a reuseport BPF program (`SO_ATTACH_REUSEPORT_CBPF`, shared by the group) returns
  the index of one; a socket that joins is appended, so of two resolvers the older is at index 0 and the newer at
  index 1.
  - Before each bind attempt the resolver checks whether another socket serves the address (a UDP bind without
    `SO_REUSEPORT` fails with `EADDRINUSE`) and records the inodes of the sockets bound to it (`/proc/net/udp`, and
    the listening ones of `/proc/net/tcp`; the default `/proc` of a host-network container is enough).
  - A resolver that bound next to a serving one (a replacement) attaches `ret #0` until its first upstream check
    passes: every new query goes to the older resolver, and the log says "another resolver serves the address: it
    takes every query until the upstream check passes". When the check passes it attaches `ret #0xffffffff` (out of
    range: the kernel hashes again) and logs "upstream check passes: taking queries". A replacement whose servers
    do not answer therefore never takes a query, and removing it loses nothing. A resolver that bound alone
    attaches `ret #0xffffffff` at once, which clears a program a departed resolver left in the group.
  - On SIGTERM the departing resolver steers new queries away from itself: to index 0 while a socket that was bound
    when it bound is still there (it is the newer of the two), otherwise to index 1 when another socket exists (the
    resolver that bound after it), and attaches nothing when it is alone. Without the socket tables the bind order
    decides (a resolver that bound second steers to 0, one that bound first to 1). It keeps serving until no
    request has been in flight for 300 ms or 3.5 s have passed, then closes its sockets directly and exits 0.
  - The indexes assume at most two resolvers per address (the kernel moves the last socket into the place of one
    that leaves), which holds because the manager runs at most one replacement next to the serving resolver
    (§6.11.4).
- **Panics.** zdns ends a few malformed lookups with a fatal log call; the resolver turns it into a recovered panic,
  answers SERVFAIL, replaces the zdns resolver object and counts `panics`. Any other panic exits with code 1, and the
  daemon starts the resolver again.
- **Healthcheck and stats.** `scantor node resolver healthcheck` exits 0 when the state file is fresh (younger than
  5 s), the listener is bound and the upstream check passes. Whenever the state file is readable, also when the check
  fails, it prints the stats as one JSON line first, which becomes the health output the daemon reads (§6.11.5).
  Counters are cumulative since the process started; `queryBudgetExceeded` counts the lookups that spent their query
  budget and `tcpRejected` the client TCP connections closed at accept; `cacheBytes` is the answer cache's estimated
  memory (§6.11.7):

```json
{"v":1,"ready":true,"node":"2d9e4f1a-…","spec":"sha256:…","mode":"recursive","listen":"10.10.0.1:53",
 "upstreamOk":true,"ipv6":false,"hostNameservers":["127.0.0.53"],
 "startedAt":"2026-10-21T07:00:00.000Z","at":"2026-10-21T10:05:10.000Z","queries":120345,"cacheHits":98000,
 "lookups":20100,"inflight":12,"overloaded":0,"rateLimited":0,"timeouts":40,"tcpFallbackFailures":0,"panics":0,
 "queryBudgetExceeded":0,"tcpRejected":0,
 "rcodes":{"noError":110000,"nxDomain":9000,"servFail":300,"refused":2,"other":0},
 "qps":850.5,"cacheBytes":15000000,"cacheEntries":15000,"conntrack":{"count":12000,"max":262144}}
```

#### 6.11.9 Operations

- **Capacity.** One resolver serves tens of thousands of cached queries per second and about `maxLookups` lookups
  at once. The host limit is usually connection tracking: Docker's embedded DNS opens a new socket for every
  forwarded query, so every worker query creates a host conntrack entry that lives about 30 s, and at high rates
  `nf_conntrack_max` is exhausted ("table full, dropping packet"). The stats report its use (`conntrackUsed`), and
  [deployment](deployment.md) §15 gives the sizing.
- **Uninstall.** The resolver outlives its daemon, like workers: `docker compose down`, `just down` and stopping the
  daemon leave it running, and after a host reboot the next daemon starts it again. To decommission a node, remove
  it with `docker rm -f $(docker ps -aq --filter label=scantor.kind=resolver)` after the daemon is gone; `just prune`
  and the test runner's cleanup remove it with every other managed container.
- **A stale resolver** of a node that no longer exists on this engine still holds the gateway: the new node's probe
  sees its answer and reports `failed` with `foreignResolver`; remove it with the command above.

### 6.12 Daemon overrides

The **daemon configuration** is what a node daemon runs with: its environment variables (or their defaults) with
the daemon overrides applied. A **daemon override** replaces one value of it in the running daemon instance until
that instance stops ([architecture](architecture.md) D27). Overrides are set by admins through the API, the UI, the
CLI or MCP, never persisted on the node, and limited by the node operator's `SCANTOR_NODE_OVERRIDES`.

#### 6.12.1 Daemon configuration

The daemon reports its daemon configuration in hello and in every status (`daemonConfig`, [api](api.md) §7.1,
§7.3): `{appliedOverridesRev, values, sources, warnings, rejected}`. `values` (camelCase; byte sizes as integers
`*Bytes`, durations `*Ms`):

```
url (userinfo stripped), builtIn, maxWorkers, dind, egressDeny[], allowUnisolatedNetworks,
allowInsecureTransport, caCertificates[{subject, sha256, notAfter}], pidsLimit, shmSizeBytes, nofile,
workerLogMaxSizeBytes, workerLogMaxFiles, imageRetentionMs, pullTimeoutMs, logLevel, logFormat,
overrides ("all" | "none" | string[]),
dns {mode, upstreams[] (as configured, "host" allowed), rootServers[], localDomains[],
     cacheSizeBytes, maxLookups, upstreamQps, authoritativeQps}
```

- Secrets are never part of it: neither the node token nor `SCANTOR_SECRET`, and `caCertificates` lists only each
  certificate's subject, SHA-256 and expiry.
- `sources` mirrors the structure of `values` (`{"maxWorkers": "env", "dns": {"mode": "override", …}, …}`) with
  `env`, `default` or `override`. A non-security variable whose invalid value fell back to the default counts as
  `default`, and its warning is in `warnings`.
- `rejected` mirrors the structure too and holds, per rejected override, the reason (below).
- `appliedOverridesRev` is the `rev` of the overrides the daemon applied last.
- **Bounded**, so that every configuration the daemon accepts gives a report the orchestrator stores (§6.12.3):
  `url` at most 2048 characters; `caCertificates` the first 32 certificates, each subject at most 256 characters (cut
  with "…"); `egressDeny` the first 256 CIDRs; `warnings` at most 32 of at most 512 characters each; each `rejected`
  message at most 512 characters. When a list is cut, the last warning (one of the 32) says so: "the daemon
  configuration report is truncated: it lists 32 of 120 certificates of SCANTOR_CA_CERT, … (the daemon applies every
  certificate and CIDR)", naming only the lists that were cut. A report whose JSON is still larger than 64 KiB then
  loses entries from the end of `caCertificates`, then `warnings`, then `egressDeny`, until it fits. The daemon itself
  always applies every certificate and every CIDR.

#### 6.12.2 Overridable keys

The keys are dotted paths into `values`; they are the vocabulary of `SCANTOR_NODE_OVERRIDES` and of
`updateNodeDaemonOverrides`, defined once with their bounds in `schemas/daemon-overrides.json`, which Go
(`internal/node`) and TS (`orchestrator/shared/schemas/nodes.ts`) read and test against. The bounds are those of
the environment.

| Key | Variable | Takes effect |
|---|---|---|
| `maxWorkers` (1–100000) | `SCANTOR_NODE_MAX_WORKERS` | the next status reports it as `info.maxWorkers`, and placement uses it (§12.2); running workers are never stopped |
| `pidsLimit`, `shmSizeBytes`, `nofile`, `workerLogMaxSizeBytes`, `workerLogMaxFiles` | the worker container variables of §2 | workers created afterwards (§6.3) |
| `imageRetentionMs`, `pullTimeoutMs` | `SCANTOR_NODE_IMAGE_RETENTION`, `SCANTOR_NODE_PULL_TIMEOUT` | the next image GC pass, the next pull |
| `logLevel` | `SCANTOR_LOG_LEVEL` | at once, for the daemon's own logger only (the resolver keeps the environment's level) |
| `dns.mode`, `dns.upstreams`, `dns.rootServers`, `dns.localDomains`, `dns.cacheSizeBytes`, `dns.maxLookups`, `dns.upstreamQps`, `dns.authoritativeQps` | the `SCANTOR_NODE_DNS_*` variables | the node resolver is replaced blue/green (§6.11.4) and its cache starts empty; `disabled` affects new workers only, and the resolver stays while workers that use it exist |

Never overridable (read-only in the daemon configuration): `url`, `builtIn`, `dind`, `egressDeny`,
`allowUnisolatedNetworks`, `allowInsecureTransport`, `caCertificates`, `logFormat` and `overrides`.

**Override servers** (`dns.upstreams`, `dns.rootServers`) are public servers only. Syntax: an IPv4 or IPv6 address
(port 53), `ip:port` or `[v6]:port` with a port of 1–65535, and for upstreams the keyword `host`; no zone, no IPv6
link-local address (`fe80::/10`), no unspecified or multicast address; an IPv4-mapped IPv6 address counts as its IPv4
address. An entry whose address lies in an always-refused range (`resolver.AlwaysRefused`: private, loopback,
link-local, shared, benchmark, multicast, reserved and NAT64 space, §6.11.7) is rejected: such a server can only be
configured in the node's environment, because the resolver trusts only the environment's servers (§6.11.6) and its
guard would refuse an override's one on every query. `updateNodeDaemonOverrides`, the UI and the CLI check the
syntax and these ranges (400 `validationFailed` with a message per entry, [api](api.md) §4.17). The daemon checks
them again, and also refuses an address inside its `SCANTOR_NODE_EGRESS_DENY`, which the orchestrator does not
know: it rejects the whole key with "private and special-purpose servers can only be configured in the node
environment (SCANTOR_NODE_DNS_*)" (also when its environment names the same server), and the environment's value
stays.

#### 6.12.3 Lifecycle

Both node document fields are optional; absent means null ([data model](data-model.md) §4.8):

```
daemonConfig:     {instanceId, values, sources, warnings, appliedOverridesRev, rejected, reportedAt}
daemonOverrides:  {instanceId, values, rev, updatedAt, updatedBy}
```

- **Hello of a new instance** (a new daemon process): `daemonOverrides` is cleared (event
  `node.daemonOverridesCleared` with the new `instanceId` and the `keys` that ended, when it held values). A daemon
  restart is therefore the node operator's reset, and so is a lease takeover by another daemon on the same engine.
  A hello of the same instance keeps the overrides.
- **Every hello**: `daemonConfig` becomes the hello's report for its instance, or null without one or when it is
  invalid.
- **Status**: `daemonConfig` is stored only when the report belongs to the current instance; a status without one
  leaves the stored report alone.
- **`PATCH /api/nodes/{nodeId}/daemon-overrides`** ([api](api.md) §4.17) takes a JSON merge patch of the overrides:
  `null` removes a key (`dns: null` every `dns.*` key), and the merged result is validated against the bounds. It
  needs a daemon instance (`instance != null`), a node that is not revoked, and a valid daemon configuration reported
  by that instance (`daemonConfig.instanceId == instance.id`); otherwise 409 `daemonOverridesUnavailable` with
  `details.reason` `noInstance` or `notReported` ("node <name> has not reported a valid daemon configuration (an old
  daemon or an invalid report; see the orchestrator log)": a daemon that predates daemon overrides, one whose report
  the orchestrator stored as null, or one that has not reported yet). Keys outside the reported `overrides` allow-list
  are 409 with reason `notAllowed` and `details.keys`. The write is a conditional update on `{_id, instance.id, state
  ≠ revoked, daemonConfig.instanceId, daemonOverrides as read (instance and rev, or null)}`, tried up to 3 times
  against a freshly read node; after the third lost race the route answers 409 `invalidState` (`details.state`,
  "changed concurrently; try again"). It sets `daemonOverrides {instanceId, values, rev + 1, updatedAt, updatedBy}`;
  then the node's assignments revision is increased and same-process long-polls are woken, so the overrides reach the
  daemon at once. Event `node.daemonOverridesChanged` (`{by, keys, cleared: false}`). An offline node that still holds
  its instance accepts overrides; they arrive when its daemon polls again.
- **`DELETE /api/nodes/{nodeId}/daemon-overrides`** is idempotent: when the current instance's overrides hold values,
  they become `{}` with `rev + 1`, the daemon is woken, and the event has `cleared: true`; otherwise the node is
  returned unchanged. It needs no daemon configuration (so overrides that an invalid report hides can still be
  removed) and uses the same conditional write, with 409 `invalidState` after three lost races.
- **Delivery**: every assignments response carries `daemonOverrides {rev, values}`, `{rev: 0, values: {}}` when there
  are none or when they belong to another instance ([api](api.md) §7.2).
- **Applying** (`applyOverrides`, before `applyDesired` on every assignments response): the daemon computes the
  environment's values with `values` applied, always and without comparing revisions (a lease takeover can lower the
  rev). It decodes `values` key by key, so a key this daemon version does not know is rejected with "not supported by
  this daemon version", a key outside `SCANTOR_NODE_OVERRIDES` with "not allowed on this node", and an invalid value
  with a message; the other keys apply. It swaps its immutable daemon configuration only when the result differs
  (canonical JSON), and every operation reads one snapshot (one per create, GC pass or pull). It sets
  `appliedOverridesRev = rev`; a change requests an early status, and a change of `dns.*` kicks the resolver manager.
- **Pending and rejected**: the `Node` representation shows `pending: true` while `appliedOverridesRev` is below the
  overrides' `rev`, and the daemon's `rejected` reasons next to the overrides.
- **Robust reports**: `daemonConfig` and `info.resolver` are parsed separately from the heartbeat. The strict status
  and hello schemas take them as unknown values; each is then checked against its own lenient schema (at most 64 KiB
  of JSON; unknown keys are dropped; every inner key optional except `daemonConfig.values` and the resolver's `mode`
  and `state`), and an invalid one is stored as null and logged (at most every 10 min per node and report), never a
  400 of the heartbeat, so a newer daemon's extra keys never take a node offline. Keys added in later versions are
  always optional. The schema's list limits (64 certificates with subjects of at most 1024 characters, 256 deny
  CIDRs, 64 warnings of at most 1024 characters, 64 upstream and root servers, 256 local domains, 64 allowed
  override keys) are at least the daemon's own caps (§6.12.1), so the report of every configuration a daemon
  accepts is stored.

#### 6.12.4 Capacity

Placement uses `min(info.maxWorkers, node.maxWorkers ?? ∞)` (§12.2). `info.maxWorkers` is the daemon's value,
override included; `node.maxWorkers` is the **admin worker limit**, a persistent attribute of the node record set
with `updateNode`. With the `maxWorkers` override an admin can raise a node above its operator's
`SCANTOR_NODE_MAX_WORKERS` until the daemon restarts, unless the operator leaves `maxWorkers` out of
`SCANTOR_NODE_OVERRIDES`.

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
| `maxWorkers` | `SCANTOR_NODE_MAX_WORKERS` or its daemon override (§6.12), or `cpus` when 0 |
| `egressDenyApplied` | result of the last egress helper run (§9) |
| `networkIsolated` | `false` while containers on the node's network can reach each other (§6.8): `scantor-workers` on a remote node, `scantor-egress` on the built-in node. Older daemons omit it. |
| `resolver` | the node resolver's report (§6.11.5): `{mode, state, address?, kept, error, detail?, since, spec?, ipv6, upstreamOk, stats}`, read from the manager's last published report without a Docker call. Absent before the daemon knows it and from older daemons. |

  `arch`, `os`, `kernel`, `hostname` and `dockerVersion` are sent in `hello` (they never change while
  the daemon runs).
- `daemonConfig` is the daemon configuration with the applied overrides revision and the rejected overrides
  (§6.12.1). Like `info.resolver` it is optional and parsed separately from the heartbeat: an invalid sub-report is
  stored as null, never a 400 (§6.12.3).
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
| `info.resolver.state` entered `failed`, `degraded` or `unreachable` | event `node.resolverFailed` (warning); `ready` again after one of them, also through `starting`, `disabled`, absent reports or a new daemon instance → `node.resolverReady` (info) (§6.11.5). Neither notifies |
| `daemonConfig` of the current instance | stored with `reportedAt`; `appliedOverridesRev` ends `pending` in the `Node` representation (§6.12.3) |
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
all managed worker containers, because the orchestrator has already marked them lost. The purge also makes the
desired node resolver `disabled`, so the resolver is removed once the drained workers are gone, and no probe runs
in this mode (§6.11.4). The operator restarts the daemon with the new token. Before the first successful
`hello` the daemon does not know its node id and cannot attribute containers to itself (§1, §6.1): a 401
there only retries `hello` every 60 s and never removes containers.

### 7.5 Daemon shutdown (SIGTERM)

The daemon cancels the long-poll and any running pull, waits up to 10 s for create, start and update
calls in progress, sends a final status (2 s timeout, best effort) and exits 0. **Workers keep running**
and are adopted by the next daemon instance (§6.1). As long as that happens within
`SCANTOR_NODE_OFFLINE_AFTER`, daemon upgrades and restarts are transparent. The node resolver keeps running
too, so workers keep resolving names; the next instance adopts it, probes it, and replaces it when its image (an
upgrade) or its configuration changed (§6.11.4). The daemon overrides end with the instance (§6.12.3).

Planned node maintenance:

| Goal | Procedure |
|---|---|
| upgrade or restart the daemon | `docker pull` the new image, recreate the daemon container. Workers continue and are adopted. Old workers keep their injected runtime until they are recreated; that is fine within the version window. |
| reboot the host | Optionally cordon the node first (`updateNode {cordoned: true}`). After the reboot, workers that are still desired are restarted (`RestartPolicy: no`, so the daemon does it), and so is the node resolver. If the host is gone longer than the offline window, they are lost and replaced elsewhere, and the daemon removes the stale containers when it comes back. |
| decommission | Cordon the node and wait until no workers remain (scans finish or are scaled), or delete the node at once (`deleteNode`: workers lost and replaced). Then stop the daemon. It removes remaining workers itself after the unauthorized window, and its node resolver once those workers are gone; a resolver left behind (the daemon was removed earlier) goes with `docker rm -f $(docker ps -aq --filter label=scantor.kind=resolver)` (§6.11.9). |

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
| what is never touched | Images not matching the patterns (among them the daemon's own image, which the node resolver, its probe and the egress helper run), volumes, networks, build cache, and on the master the draft images `tasks/<taskId>:draft-*` and the script images `scripts/<scriptId>:<packSha256>` (neither matches the patterns; the orchestrator's GC handles both, [tasks](tasks.md), [scripts](scripts.md) §6.8), and the script-run containers `scantor-s-*` (kind `scriptRun`; the daemon reconciles only kind `worker`, and only the resolver manager handles kinds `resolver` and `resolverProbe`, §6.11.4). |

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
  --log-driver local --log-opt max-size=1m --log-opt max-file=1 --log-opt compress=false \
  [--userns host] \
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
  editors, test runs and BuildKit. Host-network containers and the host itself are not affected; the node
  resolver, a host-network container, therefore refuses the deny-list ranges in its own server guard (§6.11.7),
  whether or not the helper could apply the chain.
- `egressDenyApplied` is `true` only when every configured CIDR is in place. Otherwise the daemon logs a
  warning with the errors, keeps running and retries at the next interval. This is best effort by design.
  The same failure again (rootless Docker fails this way on every run: the helper finds no `DOCKER-USER`
  chain in the daemon's network namespace) is logged at debug level; a new reason is a warning again. On a
  rootless Docker daemon (`/info` security option `name=rootless`) the warning carries a hint to block the
  denied ranges on the host instead.
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
- The helper logs with the `local` driver whatever the engine's default (`container.OneShotLogConfig`, as the
  resolver probe, §6.11.3), because the daemon reads its result from its logs. Under user-namespace remapping
  (`/info` security option `name=userns`) a host-network helper gets `UsernsMode: host` (`--userns host`), which
  Docker requires for host-network containers there.
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

`node.info.maxWorkers` is the daemon's value, a `maxWorkers` daemon override included (§6.12.4); `node.maxWorkers`
is the admin worker limit of the node record.

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
| `networkIsolated: false` | `SCANTOR_ALLOW_UNISOLATED_NETWORKS` on a daemon that cannot disable inter-container traffic (§6.8); load `br_netfilter` as root and remove the network, so it is created again isolated |
| workers `createFailed` "cannot restrict inter-container communication" | rootless Docker without `br_netfilter` (§6.8): load the module or set `SCANTOR_ALLOW_UNISOLATED_NETWORKS=true` |
| `clockSkew` | NTP on the node host |
| resolver `failed`, `bindUnavailable` | rootless Docker with RootlessKit `--detach-netns`: set `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false` for the user's `docker.service`, or accept Docker's DNS (§6.11.1) |
| resolver `failed`, `bindInUse` | a host DNS server holds `0.0.0.0:53`: bind it to its own interfaces (dnsmasq `bind-interfaces`, unbound `interface:`) |
| resolver `unreachable` | the host firewall drops bridge → host port 53: allow `<subnet>` to `<gateway>` port 53, UDP and TCP (the daemon log names both) |
| resolver `degraded` (`upstreamUnreachable`) | outbound DNS to the upstream servers (recursive) or to the internet (iterative) is blocked: allow UDP and TCP 53, or set `SCANTOR_NODE_DNS_UPSTREAMS=host` (or the `dns.upstreams` override) to use the site's own resolver |
| resolver `failed`, `foreignResolver` | a resolver of another node (an earlier node on this engine) holds the gateway: remove it (§6.11.9) |
| resolver `failed`, `crashLoop` or `unhealthy` | `docker logs scantor-dns-<nodeId>-<hash12>`; `docker inspect --format '{{json .State.Health}}'` shows the last checks |
| resolver `failed`, `createFailed` with a `detail` starting "resolver config:" | the configuration the daemon built is invalid (the daemon log has the whole error): check `SCANTOR_NODE_DNS_*`, `SCANTOR_NODE_EGRESS_DENY` (at most 4096 CIDRs) and the node's `dns` daemon overrides (§6.11.6) |
| the master's hosts or `SCANTOR_NODE_DNS_LOCAL_DOMAINS` do not resolve in workers; the resolver logs "no usable host nameservers" | the host's `/etc/resolv.conf` has no nameserver the resolver can use (only IPv6 link-local or zoned entries, or none), so local names go to the upstream or root servers: give Docker a `dns` setting in `daemon.json` (§6.11.6) |
| some names fail with SERVFAIL while others resolve; the health output's `queryBudgetExceeded` grows | those lookups needed more than 64 queries (hostile or broken delegations with many name servers); nothing to fix on the node (§6.11.7) |
| lookups fail at high rates; the kernel log says "nf_conntrack: table full" | raise `net.netfilter.nf_conntrack_max` on the host ([deployment](deployment.md) §15); `info.resolver.stats.conntrackUsed` shows the use |
| a daemon override stays `pending` | the daemon has not polled since (offline, or an older daemon without overrides); `rejected` names keys the daemon refused (unknown to its version, not allowed by `SCANTOR_NODE_OVERRIDES`, invalid) |
| PATCH of daemon overrides answers 409 `daemonOverridesUnavailable` | `details.reason`: `noInstance` (no daemon connected yet), `notReported` (no valid daemon configuration of the current instance: an older daemon, a report the orchestrator stored as null, which its log names, or a daemon still connecting), `notAllowed` (`details.keys` are outside `SCANTOR_NODE_OVERRIDES`) |
| PATCH or DELETE of daemon overrides answers 409 `invalidState` | other writes changed the overrides three times in a row while the request merged its patch; try again |
| a daemon override of `dns.upstreams` or `dns.rootServers` is refused | a private or special-purpose server (400 from the API, or rejected by the daemon for an address inside its `SCANTOR_NODE_EGRESS_DENY`): only `SCANTOR_NODE_DNS_UPSTREAMS` and `SCANTOR_NODE_DNS_ROOT_SERVERS` on the node may name one (§6.12.2) |
| the daemon configuration warns "the daemon configuration report is truncated" | the node has more CA certificates, deny CIDRs or warnings than the report lists (§6.12.1); the daemon applies all of them |

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
16. **One node resolver per node** (§6.11, [architecture](architecture.md) D26) in a host-network container of the
    daemon's own image, bound only to the worker network's gateway: workers reach it through Docker's embedded DNS
    and `HostConfig.Dns`, so they keep exactly one network and container-name resolution. No new image exists, and
    the daemon's own image is already present on every node, also in nested test daemons.
17. **The worker DNS choice is made once per container**, at create time, from the resolver's published state: the
    gateway only while a probed resolver of this node is `ready` at the current gateway, otherwise Docker's DNS;
    a short settle window lets the first workers after a start wait for a resolver instead of missing it for their
    whole life. The heartbeat never waits for the resolver, so a resolver that never becomes healthy cannot take the
    node offline.
18. **Health gates the resolver** (the one exception to "health is informational"): a replacement wins only when it
    is healthy, its health includes an upstream check, and readiness needs a probe through the workers' own path.
    The daemon starts a resolver that exited (restart policy `no`), removes a dead one and creates it again, and
    restarts a running resolver that stays unhealthy for other reasons than its upstream servers or a bind error
    (the resolver retries both itself, so a restart would not help), because Docker restart policies do not act on
    health and a policy would restart a stale resolver forever after its daemon is gone.
19. **Blue/green through `SO_REUSEPORT` with reuseport BPF steering**: a replacement steers every new query to the
    serving resolver until its own upstream check passes, so a broken replacement never answers a client; a
    departing resolver steers new queries to the socket that stays (found through the socket tables of `/proc/net`)
    and closes directly after a short drain, which loses no query (measured), where a plain shutdown leaves its
    unread socket in the group and drops about half of the queries for seconds. Steering by index assumes at most
    two resolvers per address, which the manager guarantees.
20. **zdns for lookups, the resolver's own code for answers**: replies come only from captured, ID- and
    question-checked messages, zdns' cache never answers a client question, the iterative engine walks CNAME and
    DNAME chains itself, and retries happen in the engine (never after NXDOMAIN). zdns' status-based results give
    answer-less NOERROR for cached MX/SRV/TXT, dangling CNAMEs after a failed target and doubled NXDOMAIN queries.
21. **Daemon overrides travel with the assignments** (§6.12): the long-poll already wakes on `assignmentsRev`, every
    response carries the complete overrides, and the daemon applies them before the desired set without a revision
    check, so a lease takeover or a missed response cannot leave stale overrides in force. They belong to one daemon
    instance, so a daemon restart is a reset, and the node operator limits them with `SCANTOR_NODE_OVERRIDES`.

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
| Encrypted upstream servers (DNS over TLS or HTTPS) | The resolver's configuration is a strict, hashed JSON document; a new upstream kind is a new field, and the spec hash replaces running resolvers blue/green. |
| Test runs through the built-in node's resolver | Test runs join `scantor-egress`; the resolver would need a second listen address on that network's gateway and `HostConfig.Dns` in the test-run spec. |
| `NOTRACK` for the client leg of worker DNS | The egress helper already writes host rules with `NET_ADMIN`; raw-table `NOTRACK` rules for traffic to and from `<gateway>:53` would remove the per-query conntrack entries (§6.11.9). |
| Persistent daemon overrides | `daemonOverrides` is a keyed, bounded document per node; a persistent variant would omit the instance id and survive hellos, with the same delivery through assignments. |
