# Deployment

This document specifies how scantor runs. It covers the compose services of the master: images, commands,
healthchecks, networks, volumes, ports and environment. It covers the three compose files (development
with hot reload, production from GHCR images, and the dockerized test runner), Traefik as the optional
TLS front door, secret handling (HKDF derivation, `just init`, the startup guard), resource guards,
production setup and updates, remote node deployment, backups, observability, and maintenance recipes.
The YAML drafts below are near-final; implementers refine them but keep their names, ports, networks,
volumes and variables. Variables are only *named* here and documented with their defaults in
`.env.example`. The node daemon is specified in [nodes](nodes.md), the editor and workspace helpers in
[editor](editor.md), and the system context in [architecture](architecture.md).

## 1. Topology

```
                         Internet / LAN
                               │
      SCANTOR_TRAEFIK_BIND_ADDRESS :80/:443 (profile traefik)   SCANTOR_BIND_ADDRESS     SCANTOR_ADMIN_BIND_ADDRESS
                               │                                (public services)        (admin GUIs, databases)
┌──────────────────────────────┼───────────── network: scantor ───────────────────────────────────────────┐
│ traefik ──► orchestrator :3000 (dashboard, API, MCP)  :3001 (editor origin)   ◄── :SCANTOR_PORT / :SCANTOR_EDITOR_PORT
│         ──► registry :5000                                                    ◄── :SCANTOR_REGISTRY_PORT (host daemon pushes/pulls via localhost)
│         ──► rustfs :9000 (S3)  :9001 (console)                                ◄── :SCANTOR_S3_PORT / admin :SCANTOR_RUSTFS_CONSOLE_PORT
│         ──► rabbitmq :15672 (mgmt)  TCP :5672 (AMQP)                          ◄── admin :SCANTOR_RABBITMQ_MANAGEMENT_PORT / :SCANTOR_AMQP_PORT
│         ──► mongo-express :8081                                               ◄── admin :SCANTOR_MONGO_EXPRESS_PORT
│         ──► mongo TCP :27017 (only SCANTOR_EXPOSE_MONGO=true)                 ◄── admin :SCANTOR_MONGO_PORT
│ node (built-in daemon, Docker socket)                                                                    │
└───────┬───────────────────────┬──────────┬─────────────────────────────────────────────────────────────┘
        │ orchestrator          │ rabbitmq │ rustfs           (also attached)
┌───────▼───────────────────────▼──────────▼──── network: scantor-sandbox ────────────────────────────────┐
│ master workers scantor-w-* (built-in node)      editors scantor-editor-* (orchestrator)                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 network: scantor-egress (created by the orchestrator at boot): git helpers scantor-h-*, test runs scantor-t-*
 host Docker daemon: builds (BuildKit), helpers, editors, test runs, master workers
```

Host ports and the address variable they bind to:

| Service | Container port | Host port variable | Bind address variable | Purpose |
|---|---|---|---|---|
| orchestrator | 3000 | `SCANTOR_PORT` | `SCANTOR_BIND_ADDRESS` | dashboard, `/api`, `/mcp` |
| orchestrator | 3001 | `SCANTOR_EDITOR_PORT` | `SCANTOR_BIND_ADDRESS` | editor origin ([editor](editor.md)) |
| rabbitmq | 5672 | `SCANTOR_AMQP_PORT` | `SCANTOR_BIND_ADDRESS` | AMQP for remote workers without Traefik |
| rustfs | 9000 | `SCANTOR_S3_PORT` | `SCANTOR_BIND_ADDRESS` | S3 (presigned URLs) |
| registry | 5000 | `SCANTOR_REGISTRY_PORT` | `SCANTOR_BIND_ADDRESS` | registry; **the master's host daemon uses `localhost:${SCANTOR_REGISTRY_PORT}`** |
| rabbitmq | 15672 | `SCANTOR_RABBITMQ_MANAGEMENT_PORT` | `SCANTOR_ADMIN_BIND_ADDRESS` | management UI |
| rustfs | 9001 | `SCANTOR_RUSTFS_CONSOLE_PORT` | `SCANTOR_ADMIN_BIND_ADDRESS` | RustFS console (`/rustfs/console/`) |
| mongo-express | 8081 | `SCANTOR_MONGO_EXPRESS_PORT` | `SCANTOR_ADMIN_BIND_ADDRESS` | DB browser |
| mongo | 27017 | `SCANTOR_MONGO_PORT` | `SCANTOR_ADMIN_BIND_ADDRESS` | direct DB access (needs `directConnection=true`) |
| traefik | 80, 443 | `SCANTOR_HTTP_PORT`, `SCANTOR_HTTPS_PORT` | `SCANTOR_TRAEFIK_BIND_ADDRESS` | public entry (profile `traefik`) |

`SCANTOR_BIND_ADDRESS` must include loopback: use `127.0.0.1`, `0.0.0.0` or `::`. The master's
host Docker daemon pushes to and pulls from the registry at `localhost:${SCANTOR_REGISTRY_PORT}`, so
binding only a specific non-loopback address breaks builds. Without Traefik, admin GUIs are reached
through an SSH tunnel to `SCANTOR_ADMIN_BIND_ADDRESS`, for example
`ssh -L 15672:127.0.0.1:15672 master`.

## 2. Compose conventions

- Every compose file starts with a fixed project name: `name: scantor` for dev and prod, and
  `name: scantor-tests` for tests. The Traefik provider constraint matches
  `com.docker.compose.project=scantor`. Every container scantor creates itself carries the managed label
  `com.docker.compose.project=scantor-managed`, so it can never match ([security](security.md)).
- Settings within a service follow the project order: (1) `build`/`image`; (2) `command`, `entrypoint`,
  `depends_on`, `restart`, `healthcheck`; (3) everything else (`container_name`, `hostname`,
  `working_dir`, `profiles`, `mem_limit`, `stop_grace_period`, `shm_size`, `privileged`, `logging`,
  `labels`); (4) `ports`, `networks`; (5) `volumes`; (6) `environment`, `env_file`. There is a blank line
  between services and between top-level blocks, and none within a service.
- Variables are interpolated as plain `${VAR}`. **Compose files contain no defaults**, because defaults
  live only in `.env.example`. `.env` must be complete; `just init` creates it and merges new variables
  into it (§8.3). Every `just` recipe that starts a stack runs `just init` first. The one exception is the
  image prefix of `docker-compose.prod.yml`, written `${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}` (`-`, not
  `:-`): an unset prefix pulls from GHCR, and an explicitly empty prefix selects locally built images (the
  test runner, [testing](testing.md) §7.3). `docker-compose.tests.yml` is owned by
  [testing](testing.md) §7.1.
- The dev and prod compose files never build images. Every platform image is defined in
  `docker-bake.hcl` ([development](development.md) §10); the dev stack's images are built by `just up`
  before compose starts (§6.2).
- Only the orchestrator gets `env_file: .env`, because it needs nearly everything. Traefik also gets it,
  for the ACME DNS provider credentials (§7.6). Every other service receives an explicit, minimal
  `environment:` list.
- Every master service logs through the shared `x-logging` anchor (`local` driver, 20 MiB × 5 files).
- Named volumes and networks have fixed `name:`s, so containers created outside compose can reference
  them. Compose creates only the networks and volumes that some compose service uses (verified with
  Compose 5.6). The orchestrator therefore ensures the rest at boot (§5).

## 3. Images

| Service | Prod image | Dev image | Source |
|---|---|---|---|
| orchestrator | `${SCANTOR_IMAGE_PREFIX}scantor-orchestrator:${SCANTOR_IMAGE_TAG}` | `scantor-orchestrator-dev:dev` (bake target `orchestrator-dev` = Dockerfile target `dev`; source mounted) | `orchestrator/Dockerfile` (context: repo root) |
| node | `${SCANTOR_IMAGE_PREFIX}scantor:${SCANTOR_IMAGE_TAG}` | `scantor:dev` | root `Dockerfile` |
| mongo | `mongo:9.0` | same | Docker Hub |
| rabbitmq | `rabbitmq:4.4-management` | same | Docker Hub |
| rustfs | `rustfs/rustfs:1.0.3` | same | Docker Hub |
| registry | `registry:3.1.2` | same | Docker Hub |
| mongo-express | `mongo-express:1.0.2-20-alpine3.19` | same | Docker Hub |
| traefik | `traefik:v3.7` | same | Docker Hub |
| (spawned) editor | `${SCANTOR_IMAGE_PREFIX}scantor-editor:${SCANTOR_IMAGE_TAG}` | `scantor-editor:dev` | `editor/Dockerfile` target `editor` |
| (spawned) helpers, egress helper | `${SCANTOR_IMAGE_PREFIX}scantor:${SCANTOR_IMAGE_TAG}` | `scantor:dev` | root `Dockerfile` |
| (build base) | `${SCANTOR_IMAGE_PREFIX}scantor-base-{python,js,go}:${SCANTOR_IMAGE_TAG}` | `scantor-base-{python,js,go}:dev` | `connectors/<lang>/Dockerfile` |

- In production `SCANTOR_IMAGE_PREFIX` points at GHCR (`ghcr.io/lonetis/`) and `SCANTOR_IMAGE_TAG`
  selects the release. Pinning a version such as `1.4.0` is recommended over `latest`, which follows the newest
  `main` commit whose tests passed ([development](development.md) §14). The dev compose
  file overrides both, to an empty prefix and the tag `dev`, through `environment:` on the orchestrator.
- Dev images are tagged `dev` without a registry prefix and built by `docker buildx bake`
  ([development](development.md) §10). The dev orchestrator image has its own name
  (`scantor-orchestrator-dev`), so it never collides with the production-style `scantor-orchestrator:dev`
  that the bake `default` group builds for the test runner's prod compose.
- `docker compose pull` updates only the images of compose services (orchestrator, node and therefore
  `scantor`, and the infra services). At boot the orchestrator pulls the editor image in the background
  when the prefix is not empty, so the first editor start does not wait for a 2 GB pull. The task
  pipeline pulls base images when it pins them by digest ([tasks](tasks.md)).
- The orchestrator image contains the `scantor` binary (`/usr/local/bin/scantor`), the built Nuxt output
  and `schemas/` and `docs/guide/` as Nitro server assets (bases `schemas` and `guide`). Its build context
  is the repo root, so it includes `schemas/` and `docs/`. It has its own Go build stage, so it never
  depends on another image build. The dev orchestrator image has the same Go stage, so it also contains
  the `scantor` binary. Its build-context filter is `orchestrator/Dockerfile.dockerignore`, an allowlist
  (BuildKit reads `<Dockerfile>.dockerignore` next to a Dockerfile instead of the context root's
  `.dockerignore`, and never a `.dockerignore` in a subdirectory); the editor and base images have their own
  `Dockerfile.dockerignore` files likewise ([development](development.md) §10).

## 4. Services

### 4.1 orchestrator

| Aspect | Value |
|---|---|
| command | image default `node .output/server/index.mjs` (prod). Dev: `npm install … && npx nuxt dev --host 0.0.0.0 --port 3000` |
| depends_on | `mongo`, `rabbitmq` and `rustfs` with `condition: service_healthy`. Not `registry`: the registry waits for the orchestrator (§4.5). |
| healthcheck | `wget -qO- http://127.0.0.1:3000/api/health` every 10 s, timeout 5 s, 6 retries, `start_period` 60 s (dev 180 s). `/api/health` is 503 only when MongoDB is down. |
| other | `container_name: scantor-orchestrator`, `mem_limit: ${SCANTOR_ORCHESTRATOR_MEMORY_LIMIT}`, `stop_grace_period: 30s` (components stop at the signal and requeue their jobs, waits and long-polls answer at once, Nitro drains the open requests, then the AMQP and MongoDB clients close; [architecture](architecture.md) §4.1) |
| networks | `scantor`, `scantor-sandbox` (the service name `orchestrator` is its DNS alias on both) |
| ports | 3000 and 3001 (§1) |
| volumes | `/var/run/docker.sock` (builds, helpers, editors, test runs, registry GC exec); `scantor-editor-sockets:/run/scantor/editor-sockets`; `scantor-registry-auth:/run/scantor/registry-auth`. **Never `scantor-workspaces`.** |
| env | `env_file: .env` (dev adds `SCANTOR_IMAGE_PREFIX=`, `SCANTOR_IMAGE_TAG=dev`, `SCANTOR_BUILD_CACHE_MAX_BYTES=0` because the dev stack shares the developer's Docker daemon and its build cache with other projects, and `NODE_ENV=development`) |
| process | runs as root inside its container (Docker socket; connects to the editors' 0600 sockets) |

Boot steps are in [architecture](architecture.md) §4.1. In addition, step 6 does the following:

- writes `jwks.json` **and** `http-secret` atomically into `/run/scantor/registry-auth` (§4.5), creating
  the directory when it is missing. A throwaway orchestrator started without that volume (security tests,
  [testing](testing.md)) therefore boots normally; its files are simply unused;
- upserts the built-in node record;
- ensures the Docker network `scantor-egress` and the volumes `scantor-workspaces` and
  `scantor-editor-home` (§5).

### 4.2 node (built-in node daemon)

| Aspect | Value |
|---|---|
| command | `["node"]` (the image entrypoint is `scantor`) |
| depends_on | `orchestrator` (`service_healthy`) |
| healthcheck | `/usr/local/bin/scantor node healthcheck` every 30 s, 3 retries, `start_period` 60 s ([nodes](nodes.md) §7.1) |
| other | `container_name: scantor-node`, `stop_grace_period: 30s`. Workers keep running when it stops ([nodes](nodes.md) §7.5). |
| networks | `scantor` only (reaches `orchestrator:3000`). The workers it creates join `scantor-sandbox`. |
| volumes | `/var/run/docker.sock` |
| env | `SCANTOR_URL=${SCANTOR_INTERNAL_URL}`, `SCANTOR_NODE_BUILTIN=true`, `SCANTOR_SECRET`, `SCANTOR_NODE_MAX_WORKERS=${SCANTOR_BUILTIN_NODE_MAX_WORKERS}`, `SCANTOR_NODE_DIND=${SCANTOR_BUILTIN_NODE_DIND}`, `SCANTOR_NODE_EGRESS_DENY`, `SCANTOR_NODE_PIDS_LIMIT`, `SCANTOR_NODE_SHM_SIZE`, `SCANTOR_NODE_NOFILE`, `SCANTOR_NODE_WORKER_LOG_MAX_SIZE`, `SCANTOR_NODE_WORKER_LOG_MAX_FILES`, `SCANTOR_NODE_IMAGE_RETENTION`, `SCANTOR_NODE_PULL_TIMEOUT`, `SCANTOR_LOG_LEVEL`, `SCANTOR_LOG_FORMAT` |

### 4.3 mongo

| Aspect | Value |
|---|---|
| command | `["mongod", "--replSet", "rs0", "--keyFile", "/tmp/mongo-keyfile", "--wiredTigerCacheSizeGB", "${SCANTOR_MONGO_CACHE_GB}", "--noscripting", "--slowOpSampleRate", "0", "--bind_ip_all"]` |
| entrypoint | a bash wrapper that writes a fresh random keyFile (`openssl rand -base64 756`, mode 400, owner `mongodb`) and then `exec docker-entrypoint.sh "$@"`. A single-member replica set needs a keyFile with `--auth` but never compares it with anything. |
| healthcheck | `mongosh` as root: `try { rs.status().ok } catch (e) { rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'mongo:27017'}]}).ok }`. This initiates the replica set on first start and reports health. Interval 5 s, timeout 10 s, 12 retries, `start_period` 30 s, `start_interval` 2 s. |
| other | `container_name: scantor-mongo`, `mem_limit: ${SCANTOR_MONGO_MEMORY_LIMIT}`. The member host `mongo:27017` is stored in the replica-set config, so **never rename the service**. |
| networks | `scantor` |
| ports | `${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_PORT}:27017` |
| volumes | `scantor-mongo-data:/data/db`, `scantor-mongo-config:/data/configdb` |
| env | `MONGO_INITDB_ROOT_USERNAME=${SCANTOR_MONGO_USER}`, `MONGO_INITDB_ROOT_PASSWORD=${SCANTOR_MONGO_PASSWORD}`. **Applied only at first init.** |
| labels | Traefik TCP router `mongo`, enabled only by `traefik.enable=${SCANTOR_EXPOSE_MONGO}` (§7.3) |

- The orchestrator connects with `SCANTOR_MONGO_URL` (the in-network replica-set URL with `authSource=admin`)
  as `SCANTOR_MONGO_USER`, which is the root user, because it must create `scantor_query` and the
  analytics user.
- `--noscripting` disables `$where`, `$function` and `$accumulator` server-wide ([api](api.md) §5.2).
- `--slowOpSampleRate 0` keeps slow operations out of the MongoDB log ([security](security.md) MC-11): a slow-operation
  line carries the whole command, for example the session token of a better-auth session insert or lookup, and the
  Community server cannot redact it. To diagnose slow queries, enable the profiler for a while with
  `db.setProfilingLevel(1, { slowms: 100, sampleRate: 1 })`: it writes to `system.profile`, but the sample rate also
  applies to the log, so the log carries those commands again until `db.setProfilingLevel(0, { sampleRate: 0 })` or a
  restart of the container.
- While `SCANTOR_EXPOSE_MONGO=true` or `SCANTOR_MONGO_EXPRESS_READONLY=true` (the shipped value), the
  orchestrator also ensures a read-only analytics user `SCANTOR_MONGO_ANALYTICS_USER` /
  `SCANTOR_MONGO_ANALYTICS_PASSWORD` (role `read` on `SCANTOR_MONGO_DB`) at boot. The MongoDB TCP router
  (§7.3) and a read-only mongo-express (§4.7) connect with it. Direct database access bypasses per-user
  scoping and is for admins only.
- External clients need `tls=true&directConnection=true` through Traefik, and `directConnection=true` on
  the admin port.

### 4.4 rabbitmq

| Aspect | Value |
|---|---|
| healthcheck | `rabbitmq-diagnostics -q check_port_connectivity`, interval 10 s, timeout 10 s, 6 retries, `start_period` 30 s. Do not use `check_local_alarms`, because an alarm is no reason to restart. |
| other | `container_name: scantor-rabbitmq`, `hostname: rabbitmq` (**required**: the data directory is keyed by node name, so without a fixed hostname every container recreation starts an empty broker), `mem_limit: ${SCANTOR_RABBITMQ_MEMORY_LIMIT}` |
| networks | `scantor`, `scantor-sandbox` (master workers reach `rabbitmq:5672`) |
| ports | AMQP on `SCANTOR_BIND_ADDRESS`, management on `SCANTOR_ADMIN_BIND_ADDRESS` (§1) |
| volumes | `scantor-rabbitmq-data:/var/lib/rabbitmq` |
| env | `RABBITMQ_DEFAULT_USER=${SCANTOR_RABBITMQ_USER}` and `RABBITMQ_DEFAULT_PASS=${SCANTOR_RABBITMQ_PASSWORD}` (**first boot only**); `RABBITMQ_ENABLED_PLUGINS=rabbitmq_management` with `RABBITMQ_ENABLED_PLUGINS_FILE=/var/lib/rabbitmq/enabled_plugins` (below); `RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS` (below) |
| labels | HTTP router `rabbitmq` (management, forwardAuth); TCP router `amqp` (§7.3) |

`RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS` sets the broker configuration without a config file:

```
-rabbit max_message_size 4194304
-rabbit vm_memory_high_watermark {absolute,"${SCANTOR_RABBITMQ_MEMORY_WATERMARK}"}
-rabbit disk_free_limit {absolute,"${SCANTOR_RABBITMQ_DISK_FREE_LIMIT}"}
-rabbit consumer_timeout 1800000
-rabbit anonymous_login_user none
-rabbit auth_mechanisms ['PLAIN','AMQPLAIN']
```

The settings and their reasons are in [queue](queue.md) §2 (verified on RabbitMQ 4.4.0). Both size
variables use the byte-size syntax of [architecture](architecture.md) §10 (`1536MiB`, `5GiB`).

- The vhost `scantor`, exchanges and global queues are ensured idempotently by the orchestrator at boot
  ([queue](queue.md); scantor defines no RabbitMQ policies). There is no definitions file, because it
  would carry secrets and would suppress the default user.
- Only the management plugin runs. The `-management` image also enables the Prometheus plugin, whose
  endpoint (`:15692/metrics`, including `/metrics/per-object` with the depth and consumers of every scan
  queue) answers without credentials; rabbitmq is attached to `scantor-sandbox`, so every master worker and
  editor could read it ([security](security.md) SB-5). `RABBITMQ_ENABLED_PLUGINS` replaces the image's
  plugin list at every boot; RabbitMQ writes it to the enabled-plugins file first, and the image's
  `/etc/rabbitmq/enabled_plugins` is not writable for the broker, so `RABBITMQ_ENABLED_PLUGINS_FILE` moves
  that file into the data volume (verified on RabbitMQ 4.4: without it the broker fails to boot). A listener
  bound to the container's loopback is no alternative, because `check_port_connectivity` (the healthcheck)
  dials every listener through the node's host name.
- Do not set any deprecated `RABBITMQ_*_FILE` or `RABBITMQ_SSL_*` variable; the entrypoint exits with an
  error on them.

### 4.5 registry

| Aspect | Value |
|---|---|
| entrypoint | a `sh` wrapper that waits until `/run/scantor/registry-auth/jwks.json` and `http-secret` exist and are not empty (logging every 2 s), exports `REGISTRY_HTTP_SECRET` from `http-secret`, then `exec /entrypoint.sh /etc/distribution/config.yml` |
| healthcheck | `wget -qO- http://127.0.0.1:5001/debug/health` (the debug listener; `/v2/` answers 401 with token auth), interval 10 s, timeout 5 s, 6 retries, `start_period` 180 s |
| other | `container_name: scantor-registry` (the registry GC execs into this name, §14.1) |
| networks | `scantor` |
| ports | `${SCANTOR_BIND_ADDRESS}:${SCANTOR_REGISTRY_PORT}:5000` (§1 loopback rule) |
| volumes | `scantor-registry-data:/var/lib/registry`, `scantor-registry-auth:/run/scantor/registry-auth:ro` |
| env | `OTEL_TRACES_EXPORTER=none`, `REGISTRY_LOG_LEVEL=info`, `REGISTRY_HTTP_RELATIVEURLS=true`, `REGISTRY_STORAGE_DELETE_ENABLED=true`, `REGISTRY_AUTH_TOKEN_REALM=${SCANTOR_PUBLIC_URL}/api/registry/token`, `REGISTRY_AUTH_TOKEN_SERVICE=scantor-registry`, `REGISTRY_AUTH_TOKEN_ISSUER=scantor`, `REGISTRY_AUTH_TOKEN_JWKS=/run/scantor/registry-auth/jwks.json` |
| labels | HTTP router `registry` without forwardAuth: token auth protects it (§7.3) |

- The healthcheck fails until the orchestrator has written the key files and the wrapper has started the
  registry. The `start_period` of 180 s covers a cold orchestrator boot (the orchestrator's own is 60 s,
  dev 180 s), so meanwhile the registry is reported `starting`, not `unhealthy`. It is identical in both
  compose files (§6.2: the infrastructure services are identical). Nothing waits on `service_healthy` of
  the registry. `just up` still polls the orchestrator's health instead of using `docker compose up
  --wait`, because the first dev start installs `node_modules`, which can outlast the dev orchestrator's
  start period.
- The JWKS is read only at registry start. After `SCANTOR_SECRET` changes, restart the registry
  (`docker compose restart registry`). The orchestrator logs a reminder when it rewrites a JWKS whose
  `kid` changed.
- `REGISTRY_HTTP_SECRET` signs upload state. It is derived (HKDF label `registry-http`, §8.1), so it is
  stable across restarts without another secret in `.env`.
- The realm must be reachable from the Docker daemon of every node, including the master's own host
  daemon (§15).
- Filesystem storage keeps blobs out of RustFS and out of Node. The S3 backend is a future extension.

### 4.6 rustfs

| Aspect | Value |
|---|---|
| healthcheck | `curl -fsS http://127.0.0.1:9000/health/ready`, interval 10 s, timeout 5 s, 6 retries, `start_period` 20 s |
| other | `container_name: scantor-rustfs`. The image runs as uid 10001; a named volume works as is. |
| networks | `scantor`, `scantor-sandbox` (master workers PUT presigned URLs to `rustfs:9000`) |
| ports | S3 on `SCANTOR_BIND_ADDRESS`, console on `SCANTOR_ADMIN_BIND_ADDRESS` (§1) |
| volumes | `scantor-rustfs-data:/data` |
| env | `RUSTFS_ACCESS_KEY=${SCANTOR_S3_ACCESS_KEY}`, `RUSTFS_SECRET_KEY=${SCANTOR_S3_SECRET_KEY}`, `RUSTFS_OBS_LOG_DIRECTORY=` (empty: log to stdout), `RUSTFS_OBS_LOGGER_LEVEL=info`, `RUSTFS_CHECK_UPDATE=false`, `RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=${SCANTOR_RUSTFS_CONSOLE_URL}`, `RUSTFS_BROWSER_REDIRECT_URL=${SCANTOR_RUSTFS_CONSOLE_URL}` |
| labels | HTTP router `s3` (no forwardAuth: SigV4 and presigned URLs, Host preserved); HTTP router `rustfs` (console, forwardAuth, redirect `/` → `/rustfs/console/`) |

- The bucket `SCANTOR_S3_BUCKET`, its CORS (dashboard origin only) and its lifecycle rules are ensured by
  the orchestrator at boot ([data model](data-model.md) §9).
- RustFS exits on an empty key, so a missing `.env` value fails loudly.
- Presigned URLs embed the host they were signed for: internal `http://rustfs:9000` for the built-in
  node, `SCANTOR_S3_PUBLIC_URL` for everyone else. Proxies must preserve `Host`, never re-encode bodies,
  and keep upstream keep-alive below 75 s. Traefik does all of this by default. Serve S3 at the root of
  its own host, never under a path prefix.

### 4.7 mongo-express

| Aspect | Value |
|---|---|
| command | `["mongo-express"]` |
| entrypoint | a bash wrapper that picks the database identity: when `ME_CONFIG_OPTIONS_READONLY` is `true` (case-insensitive, as mongo-express reads it) it uses `READONLY_MONGODB_URL` with `ME_CONFIG_MONGODB_ENABLE_ADMIN=false`, otherwise `ROOT_MONGODB_URL` with `ME_CONFIG_MONGODB_ENABLE_ADMIN=true`; it unsets both URLs, exports `ME_CONFIG_MONGODB_URL` and then `exec /sbin/tini -- /docker-entrypoint.sh "$@"` |
| depends_on | `mongo` and `orchestrator` (both `service_healthy`: the orchestrator ensures the analytics user at boot) |
| healthcheck | `wget -qO- http://127.0.0.1:8081/status` (answers without auth), interval 30 s, 3 retries |
| other | `container_name: scantor-mongo-express` |
| networks | `scantor` |
| ports | `${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_EXPRESS_PORT}:8081` |
| env | `READONLY_MONGODB_URL=mongodb://${SCANTOR_MONGO_ANALYTICS_USER}:${SCANTOR_MONGO_ANALYTICS_PASSWORD}@mongo:27017/${SCANTOR_MONGO_DB}?authSource=admin&directConnection=true`, `ROOT_MONGODB_URL=mongodb://${SCANTOR_MONGO_USER}:${SCANTOR_MONGO_PASSWORD}@mongo:27017/?authSource=admin&directConnection=true`, `ME_CONFIG_BASICAUTH=true`, `ME_CONFIG_BASICAUTH_USERNAME=${SCANTOR_MONGO_EXPRESS_USER}`, `ME_CONFIG_BASICAUTH_PASSWORD=${SCANTOR_MONGO_EXPRESS_PASSWORD}`, `ME_CONFIG_SITE_COOKIESECRET=${SCANTOR_MONGO_EXPRESS_SECRET}`, `ME_CONFIG_SITE_SESSIONSECRET=${SCANTOR_MONGO_EXPRESS_SECRET}`, `ME_CONFIG_OPTIONS_READONLY=${SCANTOR_MONGO_EXPRESS_READONLY}` |
| labels | HTTP router `mongo-express` with forwardAuth |

It stays in the default stack (decisions §8) but is bound to the admin address, read-only by default, and
behind forwardAuth plus its own basic auth. Its own `readOnly` option only hides the write controls: its
add-database and add-collection routes still write. Read-only therefore also means the analytics
user (§4.3), so MongoDB itself refuses every write, and mongo-express shows only `SCANTOR_MONGO_DB`
without server status, because that user may not run `serverStatus`. The root URL leaves the process
environment before mongo-express starts. `SCANTOR_MONGO_EXPRESS_READONLY=false` connects it as the root
user with every database and the server status. It is an unmaintained Node 20 app that renders
attacker-influenced data, so never publish it any other way. Secrets in the URLs must be URL-safe;
`just init` generates hex values.

### 4.8 traefik (profile `traefik`)

| Aspect | Value |
|---|---|
| command | CLI flags only (§7.1). Because flags are given, any `TRAEFIK_*` variables are ignored. |
| healthcheck | `traefik healthcheck --ping`, interval 10 s, 3 retries |
| other | `container_name: scantor-traefik`, `profiles: [traefik]` |
| networks | `scantor` |
| ports | `${SCANTOR_TRAEFIK_BIND_ADDRESS}:${SCANTOR_HTTP_PORT}:80`, `${SCANTOR_TRAEFIK_BIND_ADDRESS}:${SCANTOR_HTTPS_PORT}:443` |
| volumes | `/var/run/docker.sock:/var/run/docker.sock:ro`, `scantor-traefik-acme:/acme`, `./traefik/dynamic:/etc/traefik/dynamic:ro` (file-provider dynamic configuration, empty by default, §7.4) |
| env | `env_file: .env` (DNS provider credentials such as `CF_DNS_API_TOKEN`, §7.6) |
| labels | the dashboard router and the shared `scantor-tools-auth` forwardAuth middleware (§7.5) |

## 5. Networks and volumes

| Network | Created by | Members | Properties |
|---|---|---|---|
| `scantor` | compose | all master services | bridge |
| `scantor-sandbox` | compose (used by orchestrator, rabbitmq, rustfs) | + master workers, editors | bridge, inter-container traffic on (workers must reach the three services). Never attach mongo, mongo-express, registry, traefik or the node daemon. |
| `scantor-egress` | orchestrator boot (`NetworkCreate`, idempotent) | git workspace helpers, test-run containers | bridge, `com.docker.network.bridge.enable_icc=false`, managed labels, no services |
| `scantor-workers` | remote node daemon | remote workers | bridge, `enable_icc=false` ([nodes](nodes.md) §6.8) |

| Volume | Created by | Mounted into | Content | Back up? |
|---|---|---|---|---|
| `scantor-mongo-data`, `scantor-mongo-config` | compose | mongo | database | **yes** (§12) |
| `scantor-rabbitmq-data` | compose | rabbitmq | queues, users, definitions | optional |
| `scantor-rustfs-data` | compose | rustfs | bucket (snapshots, files, exports, uploads, logs) | **yes** |
| `scantor-registry-data` | compose | registry | task images | **yes** |
| `scantor-registry-auth` | compose | orchestrator (rw), registry (ro) | `jwks.json`, `http-secret` (derived; regenerated at boot) | no |
| `scantor-editor-sockets` | compose | orchestrator (whole), editors (subpath `<userId>`) | code-server unix sockets | no |
| `scantor-traefik-acme` | compose | traefik | `acme.json` (certificates, ACME account) | optional |
| `scantor-workspaces` | orchestrator boot (`VolumeCreate`, idempotent) | editors and workspace helpers (subpath `<userId>`); `init`/`purge` helpers (whole) | user workspaces | **yes** |
| `scantor-editor-home` | orchestrator boot | editors (subpath `<userId>`); `init`/`purge` helpers (whole) | per-user editor home (settings, shell history, caches) | yes |
| `scantor-orchestrator-node-modules` | compose (dev only) | dev orchestrator | Linux `node_modules` kept off the host | no |
| `scantor-test-runner-docker` | compose (tests only) | test runner | the DinD daemon's `/var/lib/docker` | no |
| `scantor-test-runner-node-modules` | compose (tests only) | test runner | the runner's `node_modules` | no |

Docker volume subpaths must exist before a container can mount them (verified: `cannot access path …
no such file or directory`). The orchestrator creates `<userId>` directories through the `init` helper
([editor](editor.md) §9.4) and creates the socket directories directly in `scantor-editor-sockets`.
`docker compose down -v` removes the compose-created volumes, including the database. It never removes
`scantor-workspaces` or `scantor-editor-home`, because compose did not create them.

## 6. The compose files

### 6.1 `docker-compose.prod.yml`

```yaml
name: scantor

x-logging: &logging
  driver: local
  options:
    max-size: 20m
    max-file: "5"

services:
  orchestrator:
    image: ${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}scantor-orchestrator:${SCANTOR_IMAGE_TAG}
    depends_on:
      mongo:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
      rustfs:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 60s
    container_name: scantor-orchestrator
    mem_limit: ${SCANTOR_ORCHESTRATOR_MEMORY_LIMIT}
    stop_grace_period: 30s
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.scantor.rule=Host(`${SCANTOR_DOMAIN}`)
      - traefik.http.routers.scantor.service=scantor
      - traefik.http.services.scantor.loadbalancer.server.port=3000
      - traefik.http.routers.scantor-editor.rule=Host(`editor.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.scantor-editor.service=scantor-editor
      - traefik.http.services.scantor-editor.loadbalancer.server.port=3001
    ports:
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_PORT}:3000"
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_EDITOR_PORT}:3001"
    networks:
      - scantor
      - scantor-sandbox
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - scantor-editor-sockets:/run/scantor/editor-sockets
      - scantor-registry-auth:/run/scantor/registry-auth
    env_file:
      - .env

  node:
    image: ${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}scantor:${SCANTOR_IMAGE_TAG}
    command: ["node"]
    depends_on:
      orchestrator:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/usr/local/bin/scantor", "node", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    container_name: scantor-node
    stop_grace_period: 30s
    logging: *logging
    networks:
      - scantor
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - SCANTOR_URL=${SCANTOR_INTERNAL_URL}
      - SCANTOR_NODE_BUILTIN=true
      - SCANTOR_SECRET=${SCANTOR_SECRET}
      - SCANTOR_NODE_MAX_WORKERS=${SCANTOR_BUILTIN_NODE_MAX_WORKERS}
      - SCANTOR_NODE_DIND=${SCANTOR_BUILTIN_NODE_DIND}
      - SCANTOR_NODE_EGRESS_DENY=${SCANTOR_NODE_EGRESS_DENY}
      - SCANTOR_NODE_PIDS_LIMIT=${SCANTOR_NODE_PIDS_LIMIT}
      - SCANTOR_NODE_SHM_SIZE=${SCANTOR_NODE_SHM_SIZE}
      - SCANTOR_NODE_NOFILE=${SCANTOR_NODE_NOFILE}
      - SCANTOR_NODE_WORKER_LOG_MAX_SIZE=${SCANTOR_NODE_WORKER_LOG_MAX_SIZE}
      - SCANTOR_NODE_WORKER_LOG_MAX_FILES=${SCANTOR_NODE_WORKER_LOG_MAX_FILES}
      - SCANTOR_NODE_IMAGE_RETENTION=${SCANTOR_NODE_IMAGE_RETENTION}
      - SCANTOR_NODE_PULL_TIMEOUT=${SCANTOR_NODE_PULL_TIMEOUT}
      - SCANTOR_LOG_LEVEL=${SCANTOR_LOG_LEVEL}
      - SCANTOR_LOG_FORMAT=${SCANTOR_LOG_FORMAT}

  mongo:
    image: mongo:9.0
    command: ["mongod", "--replSet", "rs0", "--keyFile", "/tmp/mongo-keyfile", "--wiredTigerCacheSizeGB", "${SCANTOR_MONGO_CACHE_GB}", "--noscripting", "--slowOpSampleRate", "0", "--bind_ip_all"]
    entrypoint:
      - bash
      - -c
      - |
        set -euo pipefail
        openssl rand -base64 756 > /tmp/mongo-keyfile
        chmod 400 /tmp/mongo-keyfile
        chown mongodb:mongodb /tmp/mongo-keyfile
        exec docker-entrypoint.sh "$$@"
      - mongo-entrypoint
    restart: unless-stopped
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          mongosh --quiet -u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
          --eval "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }).ok }"
      interval: 5s
      timeout: 10s
      retries: 12
      start_period: 30s
      start_interval: 2s
    container_name: scantor-mongo
    mem_limit: ${SCANTOR_MONGO_MEMORY_LIMIT}
    logging: *logging
    labels:
      - traefik.enable=${SCANTOR_EXPOSE_MONGO}
      - traefik.tcp.routers.mongo.rule=HostSNI(`mongo.${SCANTOR_DOMAIN}`)
      - traefik.tcp.routers.mongo.entrypoints=websecure
      - traefik.tcp.routers.mongo.tls=true
      - traefik.tcp.routers.mongo.tls.certresolver=${SCANTOR_TRAEFIK_CERT_RESOLVER}
      - traefik.tcp.routers.mongo.service=mongo
      - traefik.tcp.services.mongo.loadbalancer.server.port=27017
    ports:
      - "${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_PORT}:27017"
    networks:
      - scantor
    volumes:
      - scantor-mongo-data:/data/db
      - scantor-mongo-config:/data/configdb
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${SCANTOR_MONGO_USER}
      - MONGO_INITDB_ROOT_PASSWORD=${SCANTOR_MONGO_PASSWORD}

  rabbitmq:
    image: rabbitmq:4.4-management
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]
      interval: 10s
      timeout: 10s
      retries: 6
      start_period: 30s
    container_name: scantor-rabbitmq
    hostname: rabbitmq
    mem_limit: ${SCANTOR_RABBITMQ_MEMORY_LIMIT}
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.rabbitmq.rule=Host(`rabbitmq.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.rabbitmq.service=rabbitmq
      - traefik.http.routers.rabbitmq.middlewares=scantor-tools-auth@docker
      - traefik.http.services.rabbitmq.loadbalancer.server.port=15672
      - traefik.tcp.routers.amqp.rule=HostSNI(`amqp.${SCANTOR_DOMAIN}`)
      - traefik.tcp.routers.amqp.entrypoints=websecure
      - traefik.tcp.routers.amqp.tls=true
      - traefik.tcp.routers.amqp.tls.certresolver=${SCANTOR_TRAEFIK_CERT_RESOLVER}
      - traefik.tcp.routers.amqp.service=amqp
      - traefik.tcp.services.amqp.loadbalancer.server.port=5672
    ports:
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_AMQP_PORT}:5672"
      - "${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_RABBITMQ_MANAGEMENT_PORT}:15672"
    networks:
      - scantor
      - scantor-sandbox
    volumes:
      - scantor-rabbitmq-data:/var/lib/rabbitmq
    environment:
      - RABBITMQ_DEFAULT_USER=${SCANTOR_RABBITMQ_USER}
      - RABBITMQ_DEFAULT_PASS=${SCANTOR_RABBITMQ_PASSWORD}
      - RABBITMQ_ENABLED_PLUGINS=rabbitmq_management
      - RABBITMQ_ENABLED_PLUGINS_FILE=/var/lib/rabbitmq/enabled_plugins
      - "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=-rabbit max_message_size 4194304 -rabbit vm_memory_high_watermark {absolute,\"${SCANTOR_RABBITMQ_MEMORY_WATERMARK}\"} -rabbit disk_free_limit {absolute,\"${SCANTOR_RABBITMQ_DISK_FREE_LIMIT}\"} -rabbit consumer_timeout 1800000 -rabbit anonymous_login_user none -rabbit auth_mechanisms ['PLAIN','AMQPLAIN']"

  rustfs:
    image: rustfs/rustfs:1.0.3
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9000/health/ready"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    container_name: scantor-rustfs
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.s3.rule=Host(`s3.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.s3.service=s3
      - traefik.http.services.s3.loadbalancer.server.port=9000
      - traefik.http.routers.rustfs.rule=Host(`rustfs.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.rustfs.service=rustfs
      - traefik.http.routers.rustfs.middlewares=scantor-tools-auth@docker,rustfs-console-root
      - traefik.http.middlewares.rustfs-console-root.redirectregex.regex=^https://([^/]+)/?$$
      - traefik.http.middlewares.rustfs-console-root.redirectregex.replacement=https://$${1}/rustfs/console/
      - traefik.http.services.rustfs.loadbalancer.server.port=9001
    ports:
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_S3_PORT}:9000"
      - "${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_RUSTFS_CONSOLE_PORT}:9001"
    networks:
      - scantor
      - scantor-sandbox
    volumes:
      - scantor-rustfs-data:/data
    environment:
      - RUSTFS_ACCESS_KEY=${SCANTOR_S3_ACCESS_KEY}
      - RUSTFS_SECRET_KEY=${SCANTOR_S3_SECRET_KEY}
      - RUSTFS_OBS_LOG_DIRECTORY=
      - RUSTFS_OBS_LOGGER_LEVEL=info
      - RUSTFS_CHECK_UPDATE=false
      - RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=${SCANTOR_RUSTFS_CONSOLE_URL}
      - RUSTFS_BROWSER_REDIRECT_URL=${SCANTOR_RUSTFS_CONSOLE_URL}

  registry:
    image: registry:3.1.2
    entrypoint:
      - sh
      - -c
      - |
        until [ -s /run/scantor/registry-auth/jwks.json ] && [ -s /run/scantor/registry-auth/http-secret ]; do
          echo "registry: waiting for the orchestrator to write /run/scantor/registry-auth"
          sleep 2
        done
        REGISTRY_HTTP_SECRET="$$(cat /run/scantor/registry-auth/http-secret)"
        export REGISTRY_HTTP_SECRET
        exec /entrypoint.sh /etc/distribution/config.yml
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:5001/debug/health"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 180s
    container_name: scantor-registry
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.registry.rule=Host(`registry.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.registry.service=registry
      - traefik.http.services.registry.loadbalancer.server.port=5000
    ports:
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_REGISTRY_PORT}:5000"
    networks:
      - scantor
    volumes:
      - scantor-registry-data:/var/lib/registry
      - scantor-registry-auth:/run/scantor/registry-auth:ro
    environment:
      - OTEL_TRACES_EXPORTER=none
      - REGISTRY_LOG_LEVEL=info
      - REGISTRY_HTTP_RELATIVEURLS=true
      - REGISTRY_STORAGE_DELETE_ENABLED=true
      - REGISTRY_AUTH_TOKEN_REALM=${SCANTOR_PUBLIC_URL}/api/registry/token
      - REGISTRY_AUTH_TOKEN_SERVICE=scantor-registry
      - REGISTRY_AUTH_TOKEN_ISSUER=scantor
      - REGISTRY_AUTH_TOKEN_JWKS=/run/scantor/registry-auth/jwks.json

  mongo-express:
    image: mongo-express:1.0.2-20-alpine3.19
    command: ["mongo-express"]
    # Read-only connects as the analytics user (role read, ensured by the orchestrator at boot), so no request
    # can write; the unused URL leaves the environment before mongo-express starts.
    entrypoint:
      - bash
      - -c
      - |
        set -euo pipefail
        if [ "$${ME_CONFIG_OPTIONS_READONLY,,}" = true ]; then
          ME_CONFIG_MONGODB_URL="$$READONLY_MONGODB_URL"
          ME_CONFIG_MONGODB_ENABLE_ADMIN=false
        else
          ME_CONFIG_MONGODB_URL="$$ROOT_MONGODB_URL"
          ME_CONFIG_MONGODB_ENABLE_ADMIN=true
        fi
        unset READONLY_MONGODB_URL ROOT_MONGODB_URL
        export ME_CONFIG_MONGODB_URL ME_CONFIG_MONGODB_ENABLE_ADMIN
        exec /sbin/tini -- /docker-entrypoint.sh "$$@"
      - mongo-express-entrypoint
    depends_on:
      mongo:
        condition: service_healthy
      orchestrator:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8081/status"]
      interval: 30s
      timeout: 5s
      retries: 3
    container_name: scantor-mongo-express
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.mongo-express.rule=Host(`mongo-express.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.mongo-express.service=mongo-express
      - traefik.http.routers.mongo-express.middlewares=scantor-tools-auth@docker
      - traefik.http.services.mongo-express.loadbalancer.server.port=8081
    ports:
      - "${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_EXPRESS_PORT}:8081"
    networks:
      - scantor
    environment:
      - READONLY_MONGODB_URL=mongodb://${SCANTOR_MONGO_ANALYTICS_USER}:${SCANTOR_MONGO_ANALYTICS_PASSWORD}@mongo:27017/${SCANTOR_MONGO_DB}?authSource=admin&directConnection=true
      - ROOT_MONGODB_URL=mongodb://${SCANTOR_MONGO_USER}:${SCANTOR_MONGO_PASSWORD}@mongo:27017/?authSource=admin&directConnection=true
      - ME_CONFIG_BASICAUTH=true
      - ME_CONFIG_BASICAUTH_USERNAME=${SCANTOR_MONGO_EXPRESS_USER}
      - ME_CONFIG_BASICAUTH_PASSWORD=${SCANTOR_MONGO_EXPRESS_PASSWORD}
      - ME_CONFIG_SITE_COOKIESECRET=${SCANTOR_MONGO_EXPRESS_SECRET}
      - ME_CONFIG_SITE_SESSIONSECRET=${SCANTOR_MONGO_EXPRESS_SECRET}
      - ME_CONFIG_OPTIONS_READONLY=${SCANTOR_MONGO_EXPRESS_READONLY}

  traefik:
    image: traefik:v3.7
    command:
      - --global.checknewversion=false
      - --global.sendanonymoususage=false
      - --ping=true
      - --log.level=${SCANTOR_TRAEFIK_LOG_LEVEL}
      - --accesslog=${SCANTOR_TRAEFIK_ACCESS_LOG}
      - --api.dashboard=true
      - --api.insecure=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=scantor
      - --providers.docker.constraints=Label(`com.docker.compose.project`,`scantor`)
      - --providers.file.directory=/etc/traefik/dynamic
      - --providers.file.watch=true
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --entrypoints.websecure.asdefault=true
      - --entrypoints.websecure.http.tls=true
      - --entrypoints.websecure.http.tls.certresolver=${SCANTOR_TRAEFIK_CERT_RESOLVER}
      - --entrypoints.websecure.http.tls.domains[0].main=${SCANTOR_DOMAIN}
      - --entrypoints.websecure.http.tls.domains[0].sans=*.${SCANTOR_DOMAIN}
      - --entrypoints.websecure.transport.respondingTimeouts.readTimeout=${SCANTOR_TRAEFIK_READ_TIMEOUT}
      - --certificatesresolvers.acme.acme.email=${SCANTOR_ACME_EMAIL}
      - --certificatesresolvers.acme.acme.storage=/acme/acme.json
      - --certificatesresolvers.acme.acme.caserver=${SCANTOR_ACME_CA_SERVER}
      - --certificatesresolvers.acme.acme.dnschallenge.provider=${SCANTOR_ACME_DNS_PROVIDER}
      - --certificatesresolvers.acme.acme.dnschallenge.resolvers=${SCANTOR_ACME_DNS_RESOLVERS}
      - --certificatesresolvers.acme.acme.dnschallenge.propagation.delaybeforechecks=${SCANTOR_ACME_DNS_DELAY}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "traefik", "healthcheck", "--ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    container_name: scantor-traefik
    profiles:
      - traefik
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.traefik.rule=Host(`traefik.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.traefik.service=api@internal
      - traefik.http.routers.traefik.middlewares=scantor-tools-auth@docker
      - traefik.http.middlewares.scantor-tools-auth.forwardauth.address=http://orchestrator:3000/api/tools/forward-auth
      - traefik.http.middlewares.scantor-tools-auth.forwardauth.authResponseHeaders=X-Scantor-User
      - traefik.http.middlewares.scantor-tools-auth.forwardauth.trustForwardHeader=false
      - traefik.http.middlewares.scantor-tools-auth.forwardauth.maxResponseBodySize=65536
    ports:
      - "${SCANTOR_TRAEFIK_BIND_ADDRESS}:${SCANTOR_HTTP_PORT}:80"
      - "${SCANTOR_TRAEFIK_BIND_ADDRESS}:${SCANTOR_HTTPS_PORT}:443"
    networks:
      - scantor
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - scantor-traefik-acme:/acme
      - ./traefik/dynamic:/etc/traefik/dynamic:ro
    env_file:
      - .env

volumes:
  scantor-mongo-data:
    name: scantor-mongo-data
  scantor-mongo-config:
    name: scantor-mongo-config
  scantor-rabbitmq-data:
    name: scantor-rabbitmq-data
  scantor-rustfs-data:
    name: scantor-rustfs-data
  scantor-registry-data:
    name: scantor-registry-data
  scantor-registry-auth:
    name: scantor-registry-auth
  scantor-editor-sockets:
    name: scantor-editor-sockets
  scantor-traefik-acme:
    name: scantor-traefik-acme

networks:
  scantor:
    name: scantor
  scantor-sandbox:
    name: scantor-sandbox
```

Notes on the YAML:

- `$$` escapes a literal `$` for compose. The Traefik redirect regex and replacement, the mongo
  entrypoint `"$$@"`, and the healthcheck variables are evaluated in the container, not by compose.
- Labels of services are inert while Traefik is not running.
- Traefik hostnames are fixed subdomains of `SCANTOR_DOMAIN` (§7.3). The admin-tool hosts must match the
  redirect targets and the forwardAuth host allowlist of [auth](auth.md) §11.
- `./traefik/dynamic/` ships in the repository (empty except for a `.gitkeep`; the file provider reads
  only `*.yml`, `*.yaml` and `*.toml`) and is resolved relative to the compose file.

### 6.2 `docker-compose.dev.yml`

Identical to production for `mongo`, `rabbitmq`, `rustfs`, `registry`, `mongo-express` and `traefik`
(copy them verbatim; the `compose-lint` security spec asserts that these services are identical in both
files, [testing](testing.md)). The file has no `build:` sections. `just up` first builds every dev image
with `docker buildx bake --load dev` (bake group `dev` of `docker-bake.hcl`, tag `dev`, no registry prefix, layer cache
reused, so unchanged images take seconds; [development](development.md) §10) and then runs
`docker compose -f docker-compose.dev.yml up -d`, which recreates every container whose image changed. The
differences:

```yaml
name: scantor

x-logging: &logging
  driver: local
  options:
    max-size: 20m
    max-file: "5"

services:
  orchestrator:
    image: scantor-orchestrator-dev:dev
    command: ["sh", "-c", "npm install --no-audit --no-fund && exec npx nuxt dev --host 0.0.0.0 --port 3000"]
    depends_on:
      mongo:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
      rustfs:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 180s
    container_name: scantor-orchestrator
    working_dir: /app/orchestrator
    mem_limit: ${SCANTOR_DEV_ORCHESTRATOR_MEMORY_LIMIT}
    stop_grace_period: 30s
    logging: *logging
    labels:
      - traefik.enable=true
      - traefik.http.routers.scantor.rule=Host(`${SCANTOR_DOMAIN}`)
      - traefik.http.routers.scantor.service=scantor
      - traefik.http.services.scantor.loadbalancer.server.port=3000
      - traefik.http.routers.scantor-editor.rule=Host(`editor.${SCANTOR_DOMAIN}`)
      - traefik.http.routers.scantor-editor.service=scantor-editor
      - traefik.http.services.scantor-editor.loadbalancer.server.port=3001
    ports:
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_PORT}:3000"
      - "${SCANTOR_BIND_ADDRESS}:${SCANTOR_EDITOR_PORT}:3001"
    networks:
      - scantor
      - scantor-sandbox
    volumes:
      - .:/app
      - scantor-orchestrator-node-modules:/app/orchestrator/node_modules
      - /var/run/docker.sock:/var/run/docker.sock
      - scantor-editor-sockets:/run/scantor/editor-sockets
      - scantor-registry-auth:/run/scantor/registry-auth
    environment:
      - SCANTOR_IMAGE_PREFIX=
      - SCANTOR_IMAGE_TAG=dev
      - SCANTOR_BUILD_CACHE_MAX_BYTES=0
      - NODE_ENV=development
    env_file:
      - .env

  node:
    image: scantor:dev
    command: ["node"]
    # depends_on, restart, healthcheck, container_name, stop_grace_period, logging, networks,
    # volumes and environment: exactly as in docker-compose.prod.yml

  # mongo, rabbitmq, rustfs, registry, mongo-express, traefik: verbatim copies from docker-compose.prod.yml

volumes:
  scantor-orchestrator-node-modules:
    name: scantor-orchestrator-node-modules
  # + every volume of docker-compose.prod.yml

networks:
  scantor:
    name: scantor
  scantor-sandbox:
    name: scantor-sandbox
```

What hot reload covers:

| Change | Effect in dev |
|---|---|
| `orchestrator/**` (UI, Nitro server) | Nuxt dev server hot reload / Nitro restart (source mounted at `/app`) |
| `schemas/**`, `docs/guide/**` | read from the mounted source through Nitro server assets; Nitro restarts |
| Go code (`cmd/`, `internal/`) | `just up`: bake rebuilds `scantor:dev` and `scantor-orchestrator-dev:dev` (both have a Go build stage) from cache, and compose recreates `orchestrator` and `node`. No host-built binary is mounted. Workers started afterwards get the new runtime from the new node daemon; running workers keep theirs until they are recreated. |
| connectors, editor | `just up` (or `just build-images <target>` for a single image); new revisions and test runs use the new base images; editors use the new image at their next start |

- The dev orchestrator image (`orchestrator/Dockerfile` target `dev`, bake target `orchestrator-dev`) is
  Node 26 with the `scantor` binary built in a Go stage. The Nuxt source is mounted at `/app` for hot
  reload; its dependencies are installed into the named `node_modules` volume at container start, so
  Linux/musl modules never touch the host.
- `nuxt dev` (Vite, the Nitro builder and the app) needs far more memory than the production server: its
  heap holds about 600 MiB at rest and about 800 MiB after a full Nuxt restart (a new file under
  `server/plugins/`, a `nuxt.config.ts` change), which overflows the heap Node derives from a 2 GiB limit. The
  container's limit is therefore `SCANTOR_DEV_ORCHESTRATOR_MEMORY_LIMIT`, not
  `SCANTOR_ORCHESTRATOR_MEMORY_LIMIT`; Node sizes its heap from it.
- Vite answers 403 to a `Host` it does not know (its DNS-rebinding guard). `nuxt.config.ts` allows the hosts
  of `SCANTOR_INTERNAL_URL` (the built-in node dials `http://orchestrator:3000`) and `SCANTOR_PUBLIC_URL`, and
  `host.docker.internal`, which the containerized CLI (`just cli`) dials for a localhost `SCANTOR_URL`
  (on Docker Desktop the host gateway, on a Linux Docker Engine the host's loopback through the shim's host
  network, [development](development.md) §6); `localhost`, `*.localhost` and IP addresses always pass.
- `SCANTOR_PUBLIC_URL` stays a localhost URL. The browser, the host Docker daemon (registry
  realm) and the CLI on the host all reach it there.
- Traefik also works locally: `COMPOSE_PROFILES=traefik`, `SCANTOR_DOMAIN=scantor.localhost` (browsers
  resolve `*.localhost` to loopback), self-signed certificate, and the URL variables changed per §7.7.
  The `traefik` profile makes the deployment public for the startup guard (§8.2), so run `just init`
  (random secrets) or set `SCANTOR_ALLOW_INSECURE_DEFAULTS=true`.

### 6.3 `docker-compose.tests.yml`

[testing](testing.md) §7 owns this file, the runner image, its entrypoint and the `SCANTOR_TEST_*`
variables. The properties this document relies on:

- One privileged Docker-in-Docker runner (`scantor-test-runner`) without published ports. Its
  `/var/lib/docker` is the named volume `scantor-test-runner-docker`, because overlay2 cannot nest on the
  container rootfs; the volume also caches images and build layers between runs.
- The runner builds the images with `docker buildx bake` (tag `dev`) and starts the **real**
  `docker-compose.prod.yml` with `SCANTOR_IMAGE_PREFIX=` (empty), `SCANTOR_IMAGE_TAG=dev` and the pull
  policy of [testing](testing.md) §7.4 (phase 7), plus the override `tests/docker/stack.tests.yml`.
- The stack runs with `--project-directory /run/scantor-test`, so the production file's relative paths
  (`env_file: .env` and the `./traefik/dynamic` mount of §7.4) resolve to generated test files: a
  directory holding the test CA's wildcard certificate and a `tls.yml` that makes it the default
  certificate ([testing](testing.md) §7.3). `stack.tests.yml` only adds the fixtures server, the remote
  node pair and test settings; it adds no Traefik mount and uses no relative paths. Nodes and workers trust the test CA
  through `SCANTOR_CA_CERT`. Nothing disables certificate verification ([nodes](nodes.md) §11).

## 7. Traefik

### 7.1 Static configuration

Traefik is configured only with the CLI flags in §6.1. With flags present, Traefik ignores `TRAEFIK_*`
variables, and the flags interpolate scantor variables from `.env`. The docker provider:

- `exposedbydefault=false`: only services with `traefik.enable=true` are routed;
- `network=scantor`: the network Traefik dials, because several services are on two networks;
- `constraints=Label(com.docker.compose.project, scantor)`: only containers of this compose project.
  Workers, editors and helpers carry `com.docker.compose.project=scantor-managed` and
  `traefik.enable=false` as run-time labels, so user images cannot claim routes even with hostile
  `LABEL`s ([security](security.md)).

The file provider (`--providers.file.directory=/etc/traefik/dynamic`, `watch=true`) reads dynamic
configuration from the read-only mount `./traefik/dynamic`. It is empty by default and only ever holds TLS
settings, such as an operator-provided default certificate (§7.4). Routers are never defined there.

### 7.2 Entrypoints

| Entrypoint | Address | Behaviour |
|---|---|---|
| `web` | `:80` | permanent redirect to `websecure`, scheme https |
| `websecure` | `:443` | `asdefault`; TLS for every HTTP router through the entrypoint (`http.tls=true`, certresolver, wildcard domains); TCP routers with `HostSNI` share the port and are matched first by the TLS ClientHello SNI; `respondingTimeouts.readTimeout=${SCANTOR_TRAEFIK_READ_TIMEOUT}`, because the default of 60 s for the whole request body breaks large S3 uploads |

### 7.3 Routers

| Router | Kind | Rule | Target | Middlewares |
|---|---|---|---|---|
| `scantor` | HTTP | `Host(${SCANTOR_DOMAIN})` | orchestrator:3000 | – (the app authenticates; security headers come from Nitro) |
| `scantor-editor` | HTTP | `Host(editor.${SCANTOR_DOMAIN})` | orchestrator:3001 | – (editor cookie, [editor](editor.md)) |
| `registry` | HTTP | `Host(registry.${SCANTOR_DOMAIN})` | registry:5000 | – (token auth) |
| `s3` | HTTP | `Host(s3.${SCANTOR_DOMAIN})` | rustfs:9000 | – (SigV4; Host preserved) |
| `rustfs` | HTTP | `Host(rustfs.${SCANTOR_DOMAIN})` | rustfs:9001 | `scantor-tools-auth`, `rustfs-console-root` |
| `rabbitmq` | HTTP | `Host(rabbitmq.${SCANTOR_DOMAIN})` | rabbitmq:15672 | `scantor-tools-auth` |
| `mongo-express` | HTTP | `Host(mongo-express.${SCANTOR_DOMAIN})` | mongo-express:8081 | `scantor-tools-auth` |
| `traefik` | HTTP | `Host(traefik.${SCANTOR_DOMAIN})` | `api@internal` | `scantor-tools-auth` |
| `amqp` | TCP | `HostSNI(amqp.${SCANTOR_DOMAIN})`, `tls=true` (terminated) | rabbitmq:5672 | – |
| `mongo` | TCP | `HostSNI(mongo.${SCANTOR_DOMAIN})`, `tls=true` | mongo:27017 | – (only with `SCANTOR_EXPOSE_MONGO=true`) |

- The subdomains are fixed, not configurable. The four admin-tool hosts (`traefik.`, `rabbitmq.`,
  `mongo-express.`, `rustfs.`) are also the redirect targets of `createToolsSession` and the
  `X-Forwarded-Host` allowlist of `toolsForwardAuth` ([auth](auth.md) §11, [api](api.md) §4.18).

- TCP clients must send SNI: they must connect by hostname, never by IP. Without SNI the connection falls
  through to the HTTP routers.
- AMQP clients connect with `amqps://amqp.<domain>:443` and MongoDB clients with
  `mongodb://…@mongo.<domain>:443/?tls=true&directConnection=true&authSource=admin`.
- AMQP heartbeats stay on: the entrypoint read timeout does not apply to routed TCP streams, but NAT boxes
  in front of nodes do drop idle connections.
- The registry and S3 must sit at the root of their own host. Docker image references cannot carry a path
  prefix, and S3 signatures cover the path.

### 7.4 Certificates (ACME DNS-01, wildcard, self-signed fallback)

- One resolver named `acme` is always declared: DNS-01 with provider `${SCANTOR_ACME_DNS_PROVIDER}`
  (Cloudflare is the primary, tested provider), resolvers `${SCANTOR_ACME_DNS_RESOLVERS}` (public resolvers, so split-horizon
  DNS does not break propagation checks), and a delay before checks.
- The entrypoint requests **one wildcard certificate**: `domains[0].main=${SCANTOR_DOMAIN}`,
  `sans=*.${SCANTOR_DOMAIN}`. That avoids leaking every hostname to Certificate Transparency logs and
  covers the TCP routers too (they use the store certificate selected by SNI).
- `SCANTOR_TRAEFIK_CERT_RESOLVER=acme` enables ACME. **Empty** means no resolver: Traefik
  serves its built-in self-signed "TRAEFIK DEFAULT CERT" without errors (verified). That certificate
  changes on every Traefik start and cannot be trusted with a CA, so it is only for local use and tests.
  Remote nodes need ACME, a private ACME CA (`SCANTOR_ACME_CA_SERVER` plus `SCANTOR_CA_CERT` on nodes), or
  a private network ([nodes](nodes.md) §11).
- `SCANTOR_ACME_CA_SERVER` selects the ACME directory: Let's Encrypt production, its staging URL while
  testing (rate limits), or a private ACME CA. `SCANTOR_ACME_EMAIL` may stay empty.
- **Operator-provided certificate** (no ACME): put the certificate and key plus a `tls.yml` into
  `./traefik/dynamic/` and leave `SCANTOR_TRAEFIK_CERT_RESOLVER` empty. The file sets the default
  certificate of the default store:

  ```yaml
  tls:
    stores:
      default:
        defaultCertificate:
          certFile: /etc/traefik/dynamic/wildcard.crt
          keyFile: /etc/traefik/dynamic/wildcard.key
  ```

  The certificate must cover `${SCANTOR_DOMAIN}` and `*.${SCANTOR_DOMAIN}`. The test stack uses exactly
  this mechanism with a throwaway test CA ([testing](testing.md) §7.3).
- If ACME fails, Traefik keeps serving previously issued certificates, then the default certificate. It
  never stops routing.

### 7.5 forwardAuth for admin GUIs

The middleware `scantor-tools-auth` is declared once, on the Traefik service:

| Option | Value |
|---|---|
| `address` | `http://orchestrator:3000/api/tools/forward-auth` ([api](api.md) §4.18) |
| `authResponseHeaders` | `X-Scantor-User` |
| `trustForwardHeader` | `false` |
| `maxResponseBodySize` | `65536` |

`trustForwardHeader=false` makes Traefik build the `X-Forwarded-*` headers of the auth request from the
request itself, so the `X-Forwarded-Host` that forward-auth checks against the tool hosts cannot be
spoofed by the client.

Flow: an admin opens "Admin tools" in the UI → `GET /api/tools/session?target=rabbitmq` (session only)
sets `scantor_tools` (`Domain=${SCANTOR_DOMAIN}`, Secure, HttpOnly, SameSite=Lax, 8 h) and redirects
to `https://rabbitmq.${SCANTOR_DOMAIN}/`. Traefik then calls forward-auth with the cookie. A valid admin
cookie gets 200 and the request passes. Otherwise a browser request (`Accept: text/html`) gets a 302 to
`${SCANTOR_PUBLIC_URL}/api/tools/session?target=<tool>`, which issues a fresh cookie for a signed-in admin
and redirects back; every other request gets 401. Traefik returns these responses to the client
unchanged. The tools still ask for their own credentials (RabbitMQ admin, mongo-express basic auth,
RustFS keys). The better-auth session cookie stays host-only on `${SCANTOR_DOMAIN}`, so it never reaches
the tool, S3, registry or editor subdomains. Without Traefik (`SCANTOR_DOMAIN` empty), `createToolsSession`
answers 404, the UI shows the admin bind address instead, and the tools rely on their own credentials plus
`SCANTOR_ADMIN_BIND_ADDRESS` ([api](api.md) §4.1).

### 7.6 DNS provider credentials

Traefik's ACME client (lego) reads provider credentials from its environment, and Traefik receives
`.env` through `env_file`. For Cloudflare, set `CF_DNS_API_TOKEN`. For another provider, set
`SCANTOR_ACME_DNS_PROVIDER` to its lego name and add that provider's lego variables to `.env`.
`.env.example` explains how to create the token and where the per-provider variable list is.

### 7.7 URL checklist with Traefik

With `COMPOSE_PROFILES=traefik` and `SCANTOR_DOMAIN=scantor.example.com`, set these variables. The
orchestrator logs a warning at boot when a URL host does not match its fixed Traefik host (§7.3).

| Variable | Value |
|---|---|
| `SCANTOR_PUBLIC_URL` | `https://scantor.example.com` |
| `SCANTOR_EDITOR_URL` | `https://editor.scantor.example.com` |
| `SCANTOR_S3_PUBLIC_URL` | `https://s3.scantor.example.com` |
| `SCANTOR_AMQP_PUBLIC_URL` | `amqps://amqp.scantor.example.com:443` |
| `SCANTOR_REGISTRY_PUBLIC_HOST` | `registry.scantor.example.com` |
| `SCANTOR_RUSTFS_CONSOLE_URL` | `https://rustfs.scantor.example.com` |
| `SCANTOR_TRAEFIK_CERT_RESOLVER` | `acme` |
| `SCANTOR_TRUST_PROXY` | `true` (better-auth trusts `X-Forwarded-For` only from Traefik) |
| `SCANTOR_BIND_ADDRESS` | `127.0.0.1` (keep: only Traefik is public) |

DNS needs records for `scantor.example.com` and `*.scantor.example.com` pointing at the master. For S3,
disable CDN proxying ("grey cloud" on Cloudflare), because proxies that re-chunk bodies break large
uploads.

## 8. Secrets and configuration

### 8.1 Derived keys

Everything internal derives from `SCANTOR_SECRET` with
`HKDF-SHA256(ikm = SCANTOR_SECRET, salt = "scantor-v1", info = <label>, L = 32)`
([architecture](architecture.md) §9). Labels: `better-auth`, `registry-signing`, `registry-push`,
`worker-token`, `amqp`, `credentials`, `config-secrets`, `tools-cookie`, `editor-cookie`, `builtin-node`,
`mongo-query`, and `registry-http` (this document: `REGISTRY_HTTP_SECRET`, written hex-encoded to
`scantor-registry-auth/http-secret`).

Secrets that third-party images consume directly cannot be derived, so they live in `.env`:

| Variable | Consumer | When it takes effect |
|---|---|---|
| `SCANTOR_SECRET` | orchestrator, built-in node | every start (changing it is a disaster-recovery operation, §14.4) |
| `SCANTOR_MONGO_PASSWORD` | mongo (root), orchestrator, mongo-express (connects with it only when `SCANTOR_MONGO_EXPRESS_READONLY=false`) | **first init only** (§14.3) |
| `SCANTOR_RABBITMQ_PASSWORD` | rabbitmq (admin), orchestrator | **first boot only** (§14.3) |
| `SCANTOR_S3_SECRET_KEY` (+ `SCANTOR_S3_ACCESS_KEY`) | rustfs (root), orchestrator | every start of both |
| `SCANTOR_MONGO_EXPRESS_PASSWORD`, `SCANTOR_MONGO_EXPRESS_SECRET` | mongo-express | every start |
| `SCANTOR_MONGO_ANALYTICS_PASSWORD` | orchestrator (ensures the user while `SCANTOR_EXPOSE_MONGO=true` or `SCANTOR_MONGO_EXPRESS_READONLY=true`), mongo-express | every orchestrator start |
| `SCANTOR_ADMIN_PASSWORD` (optional, may be empty) | orchestrator (first admin when no user exists) | first boot only |
| `CF_DNS_API_TOKEN` (optional) | traefik | every start |

Every secret's default in `.env.example` ends in `-insecure-dev`, except the optional empty ones.

### 8.2 Startup guard

The startup guard is [security](security.md) CFG-2 (boot step 1, [architecture](architecture.md) §4.1).
At boot the orchestrator exits with code 1 and logs the offending variable names (never the values) when
**both** of these hold, unless `SCANTOR_ALLOW_INSECURE_DEFAULTS=true`:

1. the deployment is **public**: the host of `SCANTOR_PUBLIC_URL` or of `SCANTOR_EDITOR_URL` is not
   loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), **or** `COMPOSE_PROFILES` contains
   `traefik`, **or** `SCANTOR_BIND_ADDRESS` or `SCANTOR_ADMIN_BIND_ADDRESS` is not a loopback address;
2. there are offenders: **any** environment value ending in `-insecure-dev` (the orchestrator receives the
   whole `.env` through `env_file`, so this covers the infrastructure secrets it does not use itself), a
   core secret (`SCANTOR_SECRET`, `SCANTOR_MONGO_PASSWORD`, `SCANTOR_RABBITMQ_PASSWORD`,
   `SCANTOR_S3_SECRET_KEY`, `SCANTOR_MONGO_EXPRESS_PASSWORD`, `SCANTOR_MONGO_EXPRESS_SECRET`, plus
   `SCANTOR_MONGO_ANALYTICS_PASSWORD` while the analytics user exists, §4.3) shorter than 16 characters, or a
   non-empty `SCANTOR_ADMIN_PASSWORD` shorter than 16 characters.

With `SCANTOR_ALLOW_INSECURE_DEFAULTS=true` it warns once per name and continues. It always exits with
code 1 when `SCANTOR_EDITOR_URL` has the same origin as `SCANTOR_PUBLIC_URL` ([editor](editor.md)). This
is a summary: the algorithm in [security](security.md) §6.11 CFG-2 is authoritative.

### 8.3 `just init`

`just init` creates or completes `.env` from `.env.example`. It runs in a throwaway Alpine container, as
every recipe does, writes the file as the invoking user (a new `.env` gets mode 0600) and never prints
secret values:

```
1. If .env does not exist: copy .env.example to .env (comments included).
2. For every KEY in .env.example that is absent from .env: append its comment block and KEY=VALUE line.
3. For every KEY written in steps 1–2 whose value ends with "-insecure-dev":
   replace the value with 48 random hex characters (24 bytes from /dev/urandom).
4. Never change a KEY that already existed in .env, because database root passwords only apply at
   first init and changing them in .env would lock the orchestrator out.
5. Print the names of the added and generated keys.
```

Every recipe that starts a stack (`just up`, `just prod-up`, `just test`) runs `just init` first, so
`.env` is always complete after an update. Operators without `just` can do the same by hand:
`cp .env.example .env` and replace each `*-insecure-dev` value with `openssl rand -hex 24`.

### 8.4 First admin

When no user exists, the orchestrator either creates the admin from `SCANTOR_ADMIN_EMAIL` /
`SCANTOR_ADMIN_PASSWORD`, or logs a one-time setup URL
(`docker compose -f docker-compose.prod.yml logs orchestrator | grep /setup`). The token changes on every
restart ([auth](auth.md)).

## 9. Resource guards

| Guard | Variable(s) | Effect |
|---|---|---|
| RabbitMQ memory alarm | `SCANTOR_RABBITMQ_MEMORY_WATERMARK` (absolute) | publishers blocked above it; condition `brokerAlarm`; new scans 503 |
| RabbitMQ container memory | `SCANTOR_RABBITMQ_MEMORY_LIMIT` | hard cap (must exceed the watermark by about 30 %) |
| RabbitMQ disk alarm | `SCANTOR_RABBITMQ_DISK_FREE_LIMIT` | publishers blocked when free disk falls below (RabbitMQ's own default of 50 MB is far too low) |
| RabbitMQ message size | fixed 4 MiB (`max_message_size`) | oversized publishes rejected |
| MongoDB cache | `SCANTOR_MONGO_CACHE_GB` | WiredTiger cache (it otherwise sizes itself from host RAM) |
| MongoDB / orchestrator memory | `SCANTOR_MONGO_MEMORY_LIMIT`, `SCANTOR_ORCHESTRATOR_MEMORY_LIMIT` | hard caps |
| workers on the master | `SCANTOR_BUILTIN_NODE_MAX_WORKERS` | at most N workers share the master with the infrastructure |
| builds | `SCANTOR_BUILD_CONCURRENCY`, `SCANTOR_BUILD_TIMEOUT`, `SCANTOR_MAX_IMAGE_BYTES`, `SCANTOR_BUILD_CACHE_MAX_BYTES` | [tasks](tasks.md) |
| test runs | `SCANTOR_TEST_RUN_CONCURRENCY`, `SCANTOR_TEST_RUN_TIMEOUT` | [tasks](tasks.md) |
| editors | `SCANTOR_EDITOR_MAX_RUNNING`, `SCANTOR_EDITOR_MEMORY_LIMIT`, `SCANTOR_EDITOR_CPUS`, `SCANTOR_EDITOR_PIDS_LIMIT`, `SCANTOR_EDITOR_IDLE_TIMEOUT` | [editor](editor.md) |
| workspace helpers | `SCANTOR_HELPER_CONCURRENCY`, `SCANTOR_HELPER_CONCURRENCY_PER_USER`, `SCANTOR_HELPER_MEMORY_LIMIT`, `SCANTOR_HELPER_PIDS_LIMIT`, `SCANTOR_HELPER_TIMEOUT`, `SCANTOR_WORKSPACE_MAX_BYTES` | [editor](editor.md) §9 |
| placement on full disks | `SCANTOR_NODE_MIN_FREE_DISK` | no new workers on a node below it; emergency image GC on the node |
| per-user workers and storage | `user.maxWorkers` (default `SCANTOR_USER_MAX_WORKERS`), `SCANTOR_USER_STORAGE_QUOTA_BYTES` | [nodes](nodes.md) §12, [api](api.md) |
| service logs | `x-logging` (local driver, 20 MiB × 5 per service) | bounded |
| worker logs | `SCANTOR_NODE_WORKER_LOG_MAX_SIZE` × `SCANTOR_NODE_WORKER_LOG_MAX_FILES` | bounded per worker |

Size the master for MongoDB cache + RabbitMQ watermark + orchestrator + builds + 2 workers + editors.
16 GB RAM and 4 vCPUs are a reasonable minimum for small teams. Keep at least 50 GB free disk for images,
the build cache and RustFS.

## 10. Production setup

Requirements: a Linux host (amd64 or arm64), Docker Engine ≥ 29, the Compose plugin ≥ 2.24, DNS records
for `<domain>` and `*.<domain>` (Traefik mode), and a DNS provider token for ACME.

```sh
git clone https://github.com/lonetis/scantor.git && cd scantor   # or download a release archive
just init                                                        # creates .env with random secrets
$EDITOR .env      # COMPOSE_PROFILES=traefik, SCANTOR_DOMAIN, URL checklist §7.7, SCANTOR_TRAEFIK_CERT_RESOLVER=acme,
                  # CF_DNS_API_TOKEN, SCANTOR_IMAGE_TAG=<version>, optional SCANTOR_ADMIN_EMAIL/PASSWORD
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs orchestrator | grep /setup     # unless SCANTOR_ADMIN_* was set
curl -fsS https://<domain>/api/health
```

Then log in, add remote nodes (§11), and create users. `just prod-up` wraps `init`, `pull` and `up -d`.

**Updating**:

```sh
git pull                                   # compose file and .env.example changes, if any
just init                                  # appends new variables to .env, never changes existing ones
# set SCANTOR_IMAGE_TAG=<new version> in .env when pinning
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

- Data model migrations run at orchestrator boot under the `migrations` lock
  ([data model](data-model.md) §1).
- Running workers keep running. The built-in node daemon restarts and adopts them, while their injected
  runtime stays the old one until they are recreated. The orchestrator restart marks no node offline:
  after its start, offline detection waits until every daemon had the time to report again
  ([nodes](nodes.md) §7.4).
- Update the master first, then remote nodes. The orchestrator accepts daemons and runtimes of its own
  and the previous minor version (426 otherwise), so skipping a minor version requires updating nodes
  promptly.
- Rollback: set `SCANTOR_IMAGE_TAG` to the previous version and `up -d`. That works only when no
  migration of the newer version has run, so take a backup (§12) before minor or major updates.
- Infrastructure images are pinned in the compose file. They change only with a scantor release, which
  mentions such changes (RabbitMQ and MongoDB upgrades are one-way).

## 11. Remote node deployment

The flow, snippets, requirements and lifecycle are in [nodes](nodes.md) §4, §7.5 and §10. In short: an
admin creates the node in the UI and runs the shown `docker run` or compose snippet on a Docker host
that can reach the master over HTTPS. The node needs no inbound ports.

Master-side prerequisites for remote nodes:

| Need | Traefik mode | Without Traefik (private network only) |
|---|---|---|
| API | `https://<domain>` | `http://<private IP>:${SCANTOR_PORT}` with `SCANTOR_BIND_ADDRESS=0.0.0.0` |
| Registry | `registry.<domain>` | `<private IP>:${SCANTOR_REGISTRY_PORT}` plus `insecure-registries` on each node host |
| AMQP | `amqps://amqp.<domain>:443` | `amqp://<private IP>:${SCANTOR_AMQP_PORT}` |
| S3 | `https://s3.<domain>` | `http://<private IP>:${SCANTOR_S3_PORT}` |

Plaintext is accepted automatically only for loopback, RFC 1918, CGNAT and ULA addresses
([nodes](nodes.md) §11). Anything else needs TLS.

## 12. Backups

| Data | Required | How |
|---|---|---|
| `.env` | **critical**: without `SCANTOR_SECRET`, encrypted git credentials and config secrets cannot be recovered and every derived credential changes | keep an encrypted copy off the host |
| MongoDB | **yes** | `docker exec scantor-mongo mongodump --username "$SCANTOR_MONGO_USER" --password "$SCANTOR_MONGO_PASSWORD" --authenticationDatabase admin --oplog --archive --gzip > mongo-$(date +%F).archive.gz` (consistent while running) |
| RustFS (`scantor-rustfs-data`) | **yes** | stop `rustfs`, then `docker run --rm -v scantor-rustfs-data:/data:ro -v "$PWD:/backup" alpine:3.24 tar -czf /backup/rustfs.tgz -C /data .` (the justfile's pinned `alpine_image`, [development](development.md) §3), then start it again; or mirror the bucket to external S3 with `rustfs/rc` (`rc mirror`) while it runs |
| registry (`scantor-registry-data`) | **yes**: without it, ready revisions cannot be pulled again and must be republished | volume tar while no build is pushing (stop the orchestrator briefly, or accept a crash-consistent copy) |
| workspaces (`scantor-workspaces`), editor homes (`scantor-editor-home`) | **yes** / optional | volume tar; stop editors first for consistency (`DELETE /api/editor` per user, or stop all editor containers) |
| RabbitMQ | no | It holds only in-flight messages. After a restore with an empty broker, the reconciler recreates the topology. Analyses that were queued are detected by stall detection and recorded as `lost`. |
| Traefik ACME (`scantor-traefik-acme`) | optional | certificates are reissued automatically (watch the Let's Encrypt rate limits) |

`just backup <dir>` runs the MongoDB dump plus the volume tars in that order, stopping and starting
`rustfs` and `registry` around their tars. It creates a missing `<dir>` with mode 0700 and writes every file
with mode 0600, owned by the invoking user: the dump holds live session tokens (better-auth stores them in
clear), password hashes and encrypted credentials, and the tars hold every user's files and exports. Keep
manual copies just as private (`umask 077`). Restore: bring up an empty stack with the **same `.env`**,
stop `orchestrator` and `node`, run `mongorestore --oplogReplay --archive --gzip --drop`, untar the
volumes, start everything. Scans that were running continue from their scheduler checkpoints.

## 13. Observability

### 13.1 Metrics

`GET /api/metrics` (admin principal, typically an admin API key) returns Prometheus text format
(`text/plain; version=0.0.4`). Scrape it with
`Authorization: Bearer sk_scantor_…` every 30 s. Prometheus and Grafana are not part of the stack. This
table is the complete metric catalogue; other documents ([queue](queue.md) §6.11) name metrics from it.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `scantor_build_info` | gauge | `version` | always 1 |
| `scantor_scans` | gauge | `state` | scans by state |
| `scantor_scan_queue_messages` | gauge | `scanId`, `state` (`ready`, `unacked`, `delayed`) | per running scan, from the management API (refreshed every 15 s) |
| `scantor_ingest_messages_total` | counter | `kind` (`result`, `attempt`, `dead`), `outcome` (`applied`, `duplicate`, `dropped`, `rejected`, `failedRecorded`) | ingestor throughput and outcomes ([queue](queue.md) §6.2–§6.6) |
| `scantor_ingest_lag_messages` | gauge | – | ingest lag: ready count of `scantor.results.ingest` |
| `scantor_ingest_flush_seconds` | histogram | – | duration of one ingest batch flush ([queue](queue.md) §6.4) |
| `scantor_ingest_batch_size` | histogram | – | messages per ingest batch ([queue](queue.md) §6.4) |
| `scantor_ingest_whole_batch_failures_total` | counter | – | batches nacked and retried after a transient MongoDB failure ([queue](queue.md) §6.6) |
| `scantor_ingest_write_failed_total` | counter | – | documents that could not be written even by the follow-up write, acked and logged ([queue](queue.md) §6.6) |
| `scantor_dead_letters_total` | counter | `source` (`scan`, `results`), `reason` (the broker's `x-first-death-reason`) | messages handled by the dead-letter consumer ([queue](queue.md) §7) |
| `scantor_breaker_trips_total` | counter | – | scans paused by the failure-rate breaker ([queue](queue.md) §6.10) |
| `scantor_analyses_completed_total` | counter | `status` | terminal analyses written |
| `scantor_workers` | gauge | `state`, `role` | workers by state |
| `scantor_nodes` | gauge | `state` | nodes by state |
| `scantor_node_heartbeat_age_seconds` | gauge | `node` | seconds since the last status |
| `scantor_node_disk_free_bytes`, `scantor_node_workers_capacity` | gauge | `node` | capacity |
| `scantor_rabbitmq_alarm` | gauge | `type` (`memory`, `disk`) | 1 while active |
| `scantor_jobs` | gauge | `kind`, `state` | background jobs |
| `scantor_editors` | gauge | `state` | editor containers |
| `scantor_helpers_running` | gauge | – | workspace helpers in flight |
| `scantor_helper_duration_seconds` | histogram | `op`, `outcome` | workspace helper runs |
| `scantor_http_requests_total` | counter | `method`, `route` (route pattern, never the raw path), `status` | API traffic |
| `scantor_http_request_duration_seconds` | histogram | `method`, `route` | API latency |
| `scantor_registry_gc_last_success_timestamp_seconds` | gauge | – | registry GC (§14.1) |

The registry metrics (`registry:5001/metrics`) are reachable only inside the `scantor` network; a future
monitoring profile scrapes them. RabbitMQ runs without its Prometheus plugin (§4.4); the orchestrator's
`scantor_scan_queue_messages`, `scantor_ingest_lag_messages` and `scantor_rabbitmq_alarm` cover the broker.

### 13.2 Logs

- The orchestrator and the node daemon log JSON lines to stdout (`SCANTOR_LOG_FORMAT=json`; `text` for
  local reading) at `SCANTOR_LOG_LEVEL`. Fields: `time`, `level`, `msg`, `component` (`api`, `ingestor`,
  `reconciler`, `jobs`, `editor`, `helpers`, `node`, …), and correlation ids where they apply
  (`requestId`, `userId`, `scanId`, `workerId`, `nodeId`, `jobId`, `taskId`, `revisionId`). Secrets,
  tokens and config values are never logged.
- Master services log to Docker's `local` driver with rotation (`x-logging`). Read them with
  `docker compose -f docker-compose.prod.yml logs -f <service>`.
- Worker logs stay on their node (rotated) and are tailed on demand from the UI ([nodes](nodes.md) §7.3).
  Per-analysis log tails are stored on the analysis ([data model](data-model.md) §4.6).
- `/api/health` (public) reports the component status for load balancers and uptime checks.

## 14. Maintenance recipes

### 14.1 Registry garbage collection

Task deletion removes the manifests of the task's images through the registry API with the orchestrator
credential ([tasks](tasks.md)). Blobs are reclaimed by GC.

**Automatic** (reconciler, every `SCANTOR_REGISTRY_GC_INTERVAL`, `0` disables):

```
1. acquire lock "registryGc" (lease 30 s, renewed while running)
2. wait until no revisionBuild job has cursor.phase == "push" (poll every 5 s; give up this round after 30 min)
3. exec in container scantor-registry:
     registry garbage-collect --delete-untagged /etc/distribution/config.yml      (timeout 30 min)
4. release the lock; update scantor_registry_gc_last_success_timestamp_seconds; log freed bytes
revisionBuild push phase (handshake with step 1–2, on the "waiting for push gate" event, tasks §9.7):
  a. set cursor.phase = "push" (w: majority)
  b. if lock "registryGc" is held: set cursor.phase = "waitRegistry", sleep 10 s, go to a
  c. write "push\n" to the push gate (fd 3) of scantor task build; the binary pushes;
     on its result event set cursor.phase = "finalize"
```

`--delete-untagged` is safe for scantor's images. Revisions are pushed with a tag (`<revisionId>`), and
the children of a tagged OCI index (BuildKit attestation manifests) are kept (verified on
`registry:3.1.2`: 0 manifests eligible after pushing a BuildKit index).

**Manual** (`just registry-gc`): stop the only pusher, collect, start again:

```sh
docker compose -f docker-compose.prod.yml stop orchestrator
docker exec scantor-registry registry garbage-collect --delete-untagged /etc/distribution/config.yml
docker compose -f docker-compose.prod.yml start orchestrator
```

A build interrupted by the stop goes back to `queued` (the stopping orchestrator requeues its job) and is
rebuilt from its snapshot after the restart ([data model](data-model.md) §6.4).

### 14.2 Docker prune

| Where | What | How |
|---|---|---|
| master, automatic | BuildKit cache | after builds, prune to `SCANTOR_BUILD_CACHE_MAX_BYTES` ([tasks](tasks.md)) |
| master, automatic | draft images, stale test-run containers | orchestrator GC ([tasks](tasks.md)) |
| every node, automatic | unreferenced task and base images, removed containers | node daemon ([nodes](nodes.md) §8) |
| manual, safe | dangling images | `docker image prune -f` |
| manual, safe | stopped scantor-managed containers | `docker container prune -f --filter label=scantor.managed=true` |
| manual, **never** | `docker system prune --volumes`, `docker volume prune` | would delete workspaces, editor homes and databases |

### 14.3 Rotating infrastructure passwords after first init

MongoDB and RabbitMQ apply their root passwords only on first init. To rotate them:

```sh
# MongoDB
docker exec -it scantor-mongo mongosh -u "$SCANTOR_MONGO_USER" -p "$OLD" --authenticationDatabase admin \
  --eval 'db.getSiblingDB("admin").changeUserPassword("'"$SCANTOR_MONGO_USER"'", "'"$NEW"'")'
# RabbitMQ
docker exec scantor-rabbitmq rabbitmqctl change_password "$SCANTOR_RABBITMQ_USER" "$NEW"
# then set the new values in .env and recreate the consumers
docker compose -f docker-compose.prod.yml up -d orchestrator mongo-express
```

RustFS and mongo-express read their secrets at every start: change `.env` and run `up -d`.

### 14.4 Changing `SCANTOR_SECRET` (disaster recovery)

A new secret invalidates sessions, worker tokens, AMQP passwords of running scans, the registry signing
key and HTTP secret, the built-in node token, the tools and editor cookies, and every encrypted git
credential and config secret ([architecture](architecture.md) §9). Procedure:

1. Pause or cancel running scans.
2. Change the secret and `up -d`. The orchestrator rewrites the JWKS and the HTTP secret, and resets
   `scan-*` RabbitMQ users through the reconciler.
3. `docker compose restart registry node`.
4. Users re-enter git credentials and re-run scans that had secret config values, because those can no
   longer be decrypted.

API keys and remote node tokens survive, because they are stored as hashes.

### 14.5 Other recipes

| Task | Recipe |
|---|---|
| Inspect a stuck scan | `GET /api/scans/{id}/conditions`, `/inflight`, `/events`; RabbitMQ UI queue `scantor.scan.<id>` |
| Move the master to a new host | backup (§12) → restore on the new host with the same `.env` → change DNS. Remote nodes reconnect on their own. |
| Rename the compose project or the `mongo` service | not supported: the Traefik constraint and the replica-set member `mongo:27017` depend on them |
| Free disk on the master quickly | `just registry-gc`; delete old tasks; `docker builder prune --keep-storage <size>` |

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| builds fail at push with `401`/`connection refused` to the realm | the master's host daemon cannot reach `${SCANTOR_PUBLIC_URL}/api/registry/token` (no hairpin NAT) | add `127.0.0.1 <domain>` to the master's `/etc/hosts`, or bind Traefik on all addresses |
| builds fail at push to `localhost:5000` | `SCANTOR_BIND_ADDRESS` excludes loopback (§1) | use `127.0.0.1` or `0.0.0.0` |
| registry restarts in a loop logging "waiting …" | the orchestrator has not booted (MongoDB, RabbitMQ or RustFS unhealthy) | check `docker compose ps` and the orchestrator logs |
| empty broker after recreating `rabbitmq` | `hostname` changed | keep `hostname: rabbitmq` |
| orchestrator exits at boot listing variables | startup guard (§8.2) | run `just init`, or set `SCANTOR_ALLOW_INSECURE_DEFAULTS=true` for local Traefik tests |
| AMQP over :443 times out | the client connects by IP, so no SNI is sent | use the hostname |
| large S3 uploads fail after 60 s | Traefik read timeout | raise `SCANTOR_TRAEFIK_READ_TIMEOUT` |
| `mongo` unhealthy after a rename | replica-set member host | keep the service name `mongo`, or `rs.reconfig` |

## 16. Decisions made in this document

Decisions 1, 3, 4 and 7 are approved by the lead, and 5 follows a lead ruling. The rest, including the
fixed subdomains of 14, are flagged for lead review:

1. **Editor origin on a second container port (3001)**, served by a dedicated listener in the
   orchestrator process ([editor](editor.md) §8), instead of a second publication of port 3000. Traefik's
   editor router targets 3001.
2. **The orchestrator ensures** the network `scantor-egress` and the volumes `scantor-workspaces` and
   `scantor-editor-home` at boot. Compose does not create unused networks or volumes (verified).
3. **New volume `scantor-editor-home`** for per-user editor homes ([editor](editor.md)).
4. **`REGISTRY_HTTP_SECRET` is derived** (HKDF label `registry-http`) and written next to the JWKS. The
   registry wrapper waits for both files.
5. **Compose files carry no defaults** (`${VAR}` only); `just init` merges `.env.example` into `.env`;
   every stack recipe runs it first. The only exception (lead ruling) is the prod image prefix
   `${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}`, so an explicitly empty prefix is honoured.
6. **Only the orchestrator and Traefik use `env_file: .env`**; the built-in node gets an explicit list
   including `SCANTOR_SECRET`. The master maps `SCANTOR_BUILTIN_NODE_MAX_WORKERS` and
   `SCANTOR_BUILTIN_NODE_DIND` onto the daemon variables.
7. **Dev images are tagged `dev`** (`scantor:dev`, `scantor-editor:dev`, `scantor-base-*:dev`, and the
   dev orchestrator image `scantor-orchestrator-dev:dev`) and are built only by `docker buildx bake`
   (lead ruling). The dev and prod compose files never build; a Go change needs `just up`, not a
   host-built binary.
8. **mongo-express** stays in the default stack (decisions §8). Its cookie and session secrets share
   `SCANTOR_MONGO_EXPRESS_SECRET`.
9. **Analytics MongoDB user** `SCANTOR_MONGO_ANALYTICS_USER` / `_PASSWORD` is created only while
   something connects with it: the MongoDB TCP router (`SCANTOR_EXPOSE_MONGO=true`) or a read-only
   mongo-express (`SCANTOR_MONGO_EXPRESS_READONLY=true`, the shipped value). mongo-express's own
   `readOnly` option only hides its write controls, so a read-only mongo-express needs a read-only
   database user; its password is then a core secret of the startup guard (§8.2).
10. **Automatic registry GC** with the `registryGc` lock and a push-phase handshake (§14.1), interval
    `SCANTOR_REGISTRY_GC_INTERVAL`.
11. **Metric names** as in §13.1, the single catalogue (ingestor names and labels as in [queue](queue.md) §6.11).
12. **The DNS provider** is configurable (`SCANTOR_ACME_DNS_PROVIDER`; Cloudflare is the primary, tested provider). Provider credentials go
    into `.env` and reach Traefik through `env_file`.
13. **`SCANTOR_RABBITMQ_DISK_FREE_LIMIT`** ships with a development-friendly value in `.env.example`.
    Production operators should raise it to at least `5GiB`.
14. **Fixed Traefik subdomains** (`editor`, `registry`, `s3`, `amqp`, `mongo`, `rabbitmq`,
    `mongo-express`, `rustfs`, `traefik`) instead of per-router subdomain variables, so the admin-tool
    hosts always match [auth](auth.md) §11. A Traefik file provider on `./traefik/dynamic` carries
    optional TLS settings (default certificate, lead ruling).

## 17. Backbone change requests (written here as if applied)

- [architecture](architecture.md) §4.1 boot step 6: also write `http-secret`, ensure the network
  `scantor-egress` and the volumes `scantor-workspaces` and `scantor-editor-home`, and start the
  background pull of the editor image.
- [architecture](architecture.md) §9: add the HKDF label `registry-http` (`REGISTRY_HTTP_SECRET`).
- [architecture](architecture.md) §4.5 and §6.3: add the volume `scantor-editor-home`; the editor origin
  is container port 3001 ([editor](editor.md) §12).
- [api](api.md) §6: the orchestrator registry credential is allowed `pull`, `push` **and `delete`** on
  `tasks/*`. Task deletion deletes manifests through the registry API, and distribution requires the
  `delete` action for that.

## 18. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Multi-replica orchestrator / split components | Same image with `SCANTOR_COMPONENTS=ingestor,reconciler` as an extra service. Locks and leased jobs already make loops singleton-safe. Process-local state needs a shared store first ([architecture](architecture.md) §14): the in-flight store, which the reconciler reads but only `api` fills (so `api` and `reconciler` must run in one process until then), the metrics registry (`/api/metrics` shows the counters of its own process only), MCP internal capabilities, editor one-time codes and SSE streams. The editor listener and helper runner must stay on the host with the Docker socket. |
| Prometheus/Grafana containers | An opt-in compose profile `monitoring` scraping `/api/metrics` (admin key) and `registry:5001`, and RabbitMQ's Prometheus endpoint once it can listen only on the `scantor` network (never on `scantor-sandbox`, §4.4). |
| Registry S3 backend on RustFS | Registry env `REGISTRY_STORAGE=s3` + `REGISTRY_STORAGE_S3_*` (verified working), optionally `REDIRECTENDPOINT` to `SCANTOR_S3_PUBLIC_URL`; backups then cover one store. |
| Docker socket proxy for Traefik | Replace the read-only socket mount with a `tecnativa/docker-socket-proxy` sidecar on an internal network. |
| Multi-node MongoDB / RabbitMQ clusters | The keyFile would be derived from a secret instead of random; the RabbitMQ topology is already quorum-queue based. |
| Hot standby / point-in-time restore | MongoDB already runs as a replica set (`--oplog` dumps); add a second member. |
| Revision retention (prune old revision images) | The registry GC already exists; a retention job would delete manifests of revisions no scan references. |
| Quotas for workspace volumes | XFS project quotas or per-user volumes; helpers already measure workspace size. |
| Kubernetes deployment | Every component is a stateless container plus the stateful services above; nodes already connect outbound, so a Helm chart maps one-to-one. |
