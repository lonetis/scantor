# Editor and workspace helpers

This document specifies the browser editor and the workspace helpers. On the editor side it covers the
`scantor-editor` image (code-server, the toolchain stage shared with the devcontainer, extensions,
machine settings, connectors at the well-known paths), the per-user editor container and its lifecycle
(spawn on demand, idle stop, reaper), the per-user `editor` API key, and the separate editor origin with
its proxy (one-time-code cookie handoff, HTTP and WebSocket proxying over a unix socket, header
stripping, `frame-ancestors`). On the helper side it covers the workspace helper containers
(`scantor workspace …`) through which the orchestrator performs **every** workspace file operation:
their exact Docker profile, their stdin/stdout protocol and every operation. Workspace semantics (single
source of truth, dirty detection, git import rules) are summarised in [architecture](architecture.md)
§11.1. The task pack format and the task pipeline are in [tasks](tasks.md), the REST routes in
[api](api.md), and the deployment of volumes and ports in [deployment](deployment.md).

## 1. Overview

```
 browser (dashboard origin SCANTOR_PUBLIC_URL)            browser (editor origin SCANTOR_EDITOR_URL)
   │ POST /api/editor/session ──► {url: <editor>/_auth?code=…}   │ GET /_auth?code ─► Set-Cookie scantor_editor
   │                                                              │ GET/WS /…  (cookie)
   ▼                                                              ▼
 orchestrator :3000 (dashboard listener)              orchestrator :3001 (editor listener, editor host only)
   editor manager: start/stop, API key, reaper          proxy: cookie → userId → safe connect
        │ Docker API                                        │ /run/scantor/editor-sockets/<userId>/code.sock
        ▼                                                   ▼
 container scantor-editor-<userId>  (scantor-editor image, uid 1000, network scantor-sandbox, no Docker socket)
   code-server --socket /run/scantor-editor/code.sock      ◄── volume scantor-editor-sockets, subpath <userId>
   /home/coder            ◄── volume scantor-editor-home, subpath <userId>
   /home/coder/workspace  ◄── volume scantor-workspaces,  subpath <userId>   (one folder per task)
   env SCANTOR_URL=http://orchestrator:3000  SCANTOR_TOKEN=<editor key>  SCANTOR_DEV_MODE=remote

 orchestrator ──► throwaway helper scantor-h-<uuid> (scantor image, subpath <userId>, --network none) ◄─ stdin/stdout ─►
```

- The orchestrator process **never mounts or reads** `scantor-workspaces` or `scantor-editor-home`.
  Editors (the user's own process) and helpers (the scantor binary in a sandbox) are the only consumers.
- code-server has **no network listener**. It listens only on a unix socket in a per-user directory of
  the volume `scantor-editor-sockets`, which the orchestrator mounts whole.
- The editor is **owner-only**. Admins never open another user's editor; they read files through the
  API (which uses helpers).

## 2. The `scantor-editor` image

### 2.1 Stages

`editor/Dockerfile` (build context: the repo root) has two public stages plus internal build stages:

| Stage | Base | Contents | Used by |
|---|---|---|---|
| `toolchain` | `debian:trixie-slim` | Go 1.27.3 (`/usr/local/go`, copied from `golang:1.27.3-trixie`), Node 26 (copied from `node:26.12.1-trixie-slim`), Python 3.14 (copied from `python:3.14-slim-trixie`), uv 0.13.4 (`ghcr.io/astral-sh/uv:0.13.4`), just 1.59.0 (release tarball, checksum-pinned), basedpyright 1.40.2 (npm global), gopls v0.24.0, delve v1.27.2, git, curl, ca-certificates, bash, jq, less, procps, openssh-client, the runtime libraries the copied toolchains need (`libatomic1` for Node and code-server; `libffi8`, `libgdbm6t64`, `libncursesw6`, `libreadline8t64`, `netbase` for Python), and the connectors at the well-known paths below (owned by uid 1000) | `.devcontainer/` (with the docker-in-docker feature; postCreate links the repo connectors to the well-known paths, [development](development.md) §2) and the `editor` stage |
| `editor` | `toolchain` | code-server 4.141.0 (`/usr/lib/code-server` copied from `codercom/code-server:4.141.0`, symlink `/usr/bin/code-server`), user `coder` 1000:1000, `scantor` CLI, schemas, baked extensions, machine settings, entrypoint; the connectors are inherited from `toolchain` | the per-user editor container |

Internal stages build what `toolchain` and `editor` copy: `go-tools` (gopls, dlv), `scantor` (the
`scantor` binary with the bake `VERSION`/`COMMIT`/`IMAGE_PREFIX` ldflags, its own Go build so the image
depends on no other image build), `js-connector` (the `npm pack` of `connectors/js` with `dist/` and its
nested production `node_modules`, `scantorVersion` stamped as in `scantor-base-js`), `js-root`
(`connectors/js/check-tools`: typescript and @types/node for the root `/node_modules`), `go-connector`
(`connectors/go` without its image build files) and `go-modcache` (a module cache with the Go
connector's and the Go scaffold's dependencies, copied to `/opt/scantor/gomodcache`; the entrypoint seeds
the persistent `GOMODCACHE` from it, §2.4, so gopls and builds of scaffolded tasks need no network). The Python connector is installed system-wide with
`uv pip install --system` under the base image's constraints. The build context filter is
`editor/Dockerfile.dockerignore`, an allowlist.

Paths in the `editor` stage. These are the same well-known paths as in the base images, so imports
resolve exactly as at runtime ([tasks](tasks.md)):

| Path | Content |
|---|---|
| `/usr/local/lib/python3.14/site-packages/scantor/…` | Python connector plus its pinned dependencies (installed with the same `PIP_CONSTRAINT` file as `scantor-base-python`) |
| `/node_modules/@scantor/connector` | JS/TS connector (compiled `dist/`, re-exports `z`) with its dependencies nested; `/node_modules/typescript` and `/node_modules/@types/node` beside it, as in `scantor-base-js`. Node resolution walks up from `/home/coder/workspace/<task>` to `/node_modules`. |
| `/opt/scantor/connectors/go` | Go connector module, the target of the scaffolds' `replace` directive |
| `/opt/scantor/gomodcache` | the Go connector's and the Go scaffold's module dependencies, copied into `GOMODCACHE` at every start (§2.4) |
| `/usr/local/bin/scantor` | the `scantor` binary of the same version (CLI) |
| `/opt/scantor/schemas/` | `task-manifest.schema.json` and the other schemas (YAML IntelliSense without network access) |
| `/opt/code-server/extensions` | baked extensions (read-only at runtime) |
| `/opt/scantor/editor/machine-settings.json` | machine settings, copied on every start (§2.3) |
| `/usr/local/bin/scantor-editor-entrypoint` | entrypoint (§2.4) |

Image environment:

- `HOME=/home/coder`
- `PATH` = Go, Node, Python and `/home/coder/go/bin` + `/home/coder/.local/bin` + defaults
- `GOPATH=/home/coder/go`, `GOMODCACHE=/home/coder/go/pkg/mod` and `GOTOOLCHAIN=local` (the rootfs is
  read-only, so module downloads go to the persistent home; no automatic toolchain downloads)
- `PIP_CONSTRAINT` as in the base image, `NPM_CONFIG_UPDATE_NOTIFIER=false`
- `WORKDIR /home/coder/workspace`, `USER 1000:1000`

The image is about 2.5 GB. CI builds it for linux/amd64 and linux/arm64 together with the base images of
the same version, so editor IntelliSense and runtime behaviour use identical connector versions.

### 2.2 Extensions

Extensions are installed at build time from Open VSX, pinned, into `/opt/code-server/extensions`:
`code-server --extensions-dir /opt/code-server/extensions --install-extension <id>@<version>`. The list
lives in `editor/extensions.txt`.

| Extension | Version | Purpose |
|---|---|---|
| `ms-python.debugpy` | 2026.6.0 | member of the `ms-python.python` pack, pinned before it so the pack resolves to this version |
| `ms-python.vscode-python-envs` | 1.40.0 | member of the `ms-python.python` pack, pinned likewise |
| `ms-python.python` | 2026.4.0 | interpreter selection, debugging. Pylance is not on Open VSX and is skipped. |
| `detachhead.basedpyright` | 1.40.2 | Python IntelliSense and type checking (the Pylance replacement) |
| `charliermarsh.ruff` | 2026.88.0 | Python lint and format |
| `golang.go` | 0.58.0 | Go (uses `gopls` and `dlv` from the image) |
| `redhat.vscode-yaml` | 2.0.0 (latest stable; 2.1.x builds are pre-releases) | `scantor.yaml` schema (modeline and machine setting) |
| `dbaeumer.vscode-eslint` | 3.0.34 | ESLint for TypeScript/JavaScript tasks (listed for them in `schemas/languages.json`) |

The build fails when the installed set (`--list-extensions --show-versions`) differs from
`editor/extensions.txt`, so an extension dependency can never pull in an unpinned version. TypeScript and
JavaScript IntelliSense is built into VS Code. Users cannot install more extensions in v1,
because the extensions directory is read-only (see future extensions).

### 2.3 Machine settings

Machine settings override user settings in code-server. The entrypoint writes them to
`~/.local/share/code-server/Machine/settings.json` on **every** start, so users cannot weaken them
permanently:

```json
{
  "task.allowAutomaticTasks": "off",
  "security.workspace.trust.enabled": true,
  "telemetry.telemetryLevel": "off",
  "redhat.telemetry.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "workbench.startupEditor": "none",
  "workbench.enableExperiments": false,
  "files.exclude": { ".scantor-staging": true },
  "files.watcherExclude": { "**/node_modules/**": true, "**/.venv/**": true, "**/.scantor/**": true },
  "python.defaultInterpreterPath": "/usr/local/bin/python3",
  "python.languageServer": "None",
  "basedpyright.analysis.typeCheckingMode": "standard",
  "go.toolsManagement.autoUpdate": false,
  "go.toolsManagement.checkForUpdates": "off",
  "yaml.schemas": { "/opt/scantor/schemas/task-manifest.schema.json": "scantor.yaml" },
  "terminal.integrated.defaultProfile.linux": "bash"
}
```

Workspace trust stays **on**; the `--disable-workspace-trust` flag is never passed. Folders a user opens
start in restricted mode until the user trusts them. Together with `task.allowAutomaticTasks: off`, this
means a git-imported `.vscode/tasks.json` (`runOn: folderOpen`) never runs automatically.

### 2.4 Entrypoint and code-server flags

```sh
#!/bin/sh
# /usr/local/bin/scantor-editor-entrypoint
set -eu
umask 022
data="$HOME/.local/share/code-server"
mkdir -p "$data/Machine" "$data/User"
cp /opt/scantor/editor/machine-settings.json "$data/Machine/settings.json"
[ -f "$HOME/.bashrc" ]  || cp /etc/skel/.bashrc  "$HOME/.bashrc"
[ -f "$HOME/.profile" ] || cp /etc/skel/.profile "$HOME/.profile"
# seed the persistent module cache with the Go connector's dependencies; files already there are kept
if ! { mkdir -p "$GOMODCACHE" && cp -R --update=none /opt/scantor/gomodcache/. "$GOMODCACHE/"; }; then
  echo "scantor-editor: could not seed $GOMODCACHE; Go modules are downloaded on first use" >&2
fi
exec /usr/bin/code-server "$@"
```

The official image's `fixuid` entrypoint is not used. fixuid is a setuid helper; it does not work with
`no-new-privileges` or a read-only rootfs, and it is not needed because the container always runs as
1000:1000. Verified: code-server 4.141.0 runs as 1000:1000 with `--read-only`, `--cap-drop ALL`,
`no-new-privileges` and `--init`, serving on a 0600 unix socket on a volume subpath.

The orchestrator passes these arguments (`Cmd`):

| Flag | Value | Why |
|---|---|---|
| `--socket` | `/run/scantor-editor/code.sock` | unix socket only (`--bind-addr` is ignored) |
| `--socket-mode` | `600` | only uid 1000 inside the container and root in the orchestrator can connect |
| `--auth` | `none` | the proxy authenticates (§8) |
| `--disable-proxy` | – | no `/proxy/<port>` and `/absproxy` routes (they would expose user ports on the editor origin) |
| `--disable-telemetry`, `--disable-update-check`, `--disable-getting-started-override` | – | no outbound calls, no noise |
| `--user-data-dir` | `/home/coder/.local/share/code-server` | persistent per user (home volume) |
| `--extensions-dir` | `/opt/code-server/extensions` | baked, read-only |
| `--app-name` | `scantor (<user email>)` | the window title shows whose editor it is (§10, login CSRF) |
| positional | `/home/coder/workspace` | default folder when the URL has no `?folder=` |

The image's default `CMD` is the same set without `--app-name`, so a manually started container also
serves only the unix socket; the orchestrator always passes its own `Cmd`.

## 3. Uid, volumes and directories

- Every editor and every workspace helper (except `init` and `purge`) runs as **1000:1000**. Users are
  isolated by **volume subpaths**, not by uid: a container only ever sees its own user's directories.
  Symlinks inside a subpath resolve inside the container's own mount namespace, so they cannot reach
  other users' directories (verified).
- Docker requires a volume subpath to exist before mounting it. The orchestrator creates the per-user
  directories through the `init` helper (§9.4): `scantor-workspaces/<userId>` and
  `scantor-editor-home/<userId>`, owned by 1000:1000, mode 0700. It also creates
  `scantor-editor-sockets/<userId>` directly (owned by 1000:1000, mode 0700), because the orchestrator
  mounts that volume whole at `/run/scantor/editor-sockets`.
- Layout inside a workspace: `<userId>/<taskName>/…` (one folder per task, the task name being a slug),
  plus the reserved `<userId>/.scantor-staging/` (§9.6).

## 4. The editor container

Engine API body of `POST /containers/create?name=scantor-editor-<userId>`:

```json
{
  "Image": "ghcr.io/lonetis/scantor-editor:1.4.0",
  "User": "1000:1000",
  "Cmd": ["--socket", "/run/scantor-editor/code.sock", "--socket-mode", "600", "--auth", "none",
          "--disable-proxy", "--disable-telemetry", "--disable-update-check", "--disable-getting-started-override",
          "--user-data-dir", "/home/coder/.local/share/code-server", "--extensions-dir", "/opt/code-server/extensions",
          "--app-name", "scantor (louis@example.com)", "/home/coder/workspace"],
  "Env": [
    "SCANTOR_URL=http://orchestrator:3000",
    "SCANTOR_TOKEN=sk_scantor_editor_…",
    "SCANTOR_DEV_MODE=remote",
    "SCANTOR_WORKSPACE=/home/coder/workspace"
  ],
  "Hostname": "editor",
  "Labels": {
    "traefik.enable": "false",
    "com.docker.compose.project": "scantor-managed",
    "com.docker.compose.service": "",
    "scantor.managed": "true",
    "scantor.kind": "editor",
    "scantor.user": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11"
  },
  "StopTimeout": 10,
  "HostConfig": {
    "Init": true,
    "RestartPolicy": { "Name": "no" },
    "NetworkMode": "scantor-sandbox",
    "CapDrop": ["ALL"],
    "SecurityOpt": ["no-new-privileges:true"],
    "ReadonlyRootfs": true,
    "PidsLimit": 1024,
    "Memory": 2147483648,
    "MemorySwap": 2147483648,
    "NanoCpus": 2000000000,
    "Tmpfs": { "/tmp": "rw,nosuid,nodev,size=536870912" },
    "LogConfig": { "Type": "local", "Config": { "max-size": "10m", "max-file": "2" } },
    "Mounts": [
      { "Type": "volume", "Source": "scantor-editor-home",    "Target": "/home/coder",           "VolumeOptions": { "Subpath": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11" } },
      { "Type": "volume", "Source": "scantor-workspaces",     "Target": "/home/coder/workspace", "VolumeOptions": { "Subpath": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11" } },
      { "Type": "volume", "Source": "scantor-editor-sockets", "Target": "/run/scantor-editor",   "VolumeOptions": { "Subpath": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11" } }
    ]
  },
  "NetworkingConfig": { "EndpointsConfig": { "scantor-sandbox": {} } }
}
```

| Field | Value | Notes |
|---|---|---|
| name | `scantor-editor-<userId>` | at most one per user |
| image | `${SCANTOR_IMAGE_PREFIX}scantor-editor:${SCANTOR_IMAGE_TAG}`, stored in `editors.image` | A running editor keeps its image until it stops; the next start uses the current one. |
| `User` | `1000:1000` | §3 |
| `Env` | exactly the four variables of §5 | Nothing else: no infrastructure credentials, no Docker socket, no `SCANTOR_SECRET`. |
| network | `scantor-sandbox` | Reaches `orchestrator:3000` (the dashboard listener, with the editor API key) and the internet (pip, npm, go modules, git). The host's egress deny list applies ([nodes](nodes.md) §9). |
| mounts | home, workspace, socket directory (all subpath `<userId>`) | No other volume, no bind mount, **no Docker socket** |
| hardening | `CapDrop ALL`, `no-new-privileges`, read-only rootfs, `Init`, `PidsLimit` `SCANTOR_EDITOR_PIDS_LIMIT` | Writable places: the home and workspace volumes, `/tmp` (tmpfs, `SCANTOR_EDITOR_TMPFS_SIZE`) and the socket directory |
| resources | `Memory` = `MemorySwap` = `SCANTOR_EDITOR_MEMORY_LIMIT`, `NanoCpus` = `SCANTOR_EDITOR_CPUS` × 10⁹ | |
| restart | `no` | Editors start on demand only, never after a host reboot. |

The editor runs on the master's host Docker daemon and is created by the orchestrator (dockerode, with
the TypeScript `managedLabels()`), not by a node daemon.

## 5. Environment and the CLI inside the editor

| Variable | Value | Meaning |
|---|---|---|
| `SCANTOR_URL` | the value of `SCANTOR_INTERNAL_URL` (the in-network orchestrator URL) | the CLI talks to the dashboard listener over `scantor-sandbox` |
| `SCANTOR_TOKEN` | the user's current `editor` API key (§7) | the CLI's credential |
| `SCANTOR_DEV_MODE` | `remote` | `scantor dev run` runs a platform **test run** (`POST /api/tasks/{task}/test-runs`, streamed over SSE) instead of building locally, because there is no Docker in the editor. `scantor dev debug` exits 3 ("debugging needs local Docker"), and so does `scantor validate` ("validate needs local Docker"; the scaffold's "scantor: validate" task therefore only works outside the editor). |
| `SCANTOR_WORKSPACE` | `/home/coder/workspace` | Inside this tree, the CLI derives the task from the first path segment below it. `scantor push` then **only publishes** (`publishRevision`) instead of uploading, because the workspace already is the source of truth. |

CLI behaviour is specified with the task pipeline in [tasks](tasks.md). The CLI takes credentials only
from `SCANTOR_URL` and `SCANTOR_TOKEN`; `SCANTOR_DEV_MODE` and `SCANTOR_WORKSPACE` only select its mode
([architecture](architecture.md) §10). Every variable the CLI reads is listed in the CLI section of
`.env.example`.

## 6. Lifecycle

### 6.1 States

The `editors` document ([data model](data-model.md) §4.15, state machine §6.10):
`stopped → starting → running → stopping → stopped`; a failed start passes through `stopping` while its
cleanup runs (`starting → stopping → stopped`, with `error`), so a concurrent stop or a reaper in another
process never tears down twice.
`startedAt` is set on entering `starting` and binds editor cookies (§8.4). `apiKeyExpiresAt` records the
expiry of the current editor key (backbone change request, §12).

### 6.2 Start (spawn on demand)

`POST /api/editor/session` (and only that route) starts an editor. The response returns at once with
`editor.state` `starting` or `running`; the start continues in the background (editor manager, `api`
component):

```
startEditor(user):
  doc := findOneAndUpdate({_id: userId, state: "stopped"} (upsert when missing),
                          {$set: {state: "starting", startedAt: now, image, error: null}})
  if no transition (already starting/running) → return the current doc
  if count(editors in {starting, running}) > SCANTOR_EDITOR_MAX_RUNNING → revert to stopped, 429 tooManyRequests
  1. helper init --user <userId>                      (§9.4; cached per user per process)
  2. sockets dir /run/scantor/editor-sockets/<userId>: mkdir 0700 if missing; lstat must be a real directory
     (not a symlink); chown 1000:1000; unlink a stale code.sock
  3. delete the user's existing editor keys (configId "editor"); mint a new one (§7)
     → set apiKeyId, apiKeyExpiresAt
  4. DELETE /containers/scantor-editor-<userId>?force=true   (404 is fine; idempotent restart)
  5. ensure the image exists locally (pull when SCANTOR_IMAGE_PREFIX is not empty)
  6. create (§4) and start
  7. readiness: safe-connect (§8.5) + GET /healthz → 200; poll every 250 ms for up to SCANTOR_EDITOR_START_TIMEOUT
  8. $set {state: "running", containerId, containerName, lastActivityAt: now}
  on any failure: $set {state: "stopping", error: <message>} (claims the cleanup), stop cleanup (§6.3),
                  then $set {state: "stopped", stoppedAt: now}
```

### 6.3 Stop

```
stopEditor(user, reason):          // reason: user | idle | keyExpired | banned | userDeleted | startFailed | orphan
  findOneAndUpdate({_id, state ∈ {starting, running}}, {$set: {state: "stopping"}})
  POST /containers/scantor-editor-<userId>/stop?t=10 ; DELETE …?force=true
  delete every apikey {referenceId: userId, configId: "editor"}
  unlink the socket file; close the user's proxy agent and all open WebSockets (§8)
  $set {state: "stopped", stoppedAt: now, containerId: null, containerName: null, apiKeyId: null, apiKeyExpiresAt: null}
```

Stop triggers:

| Trigger | Path |
|---|---|
| `DELETE /api/editor` (`stopEditor`) | API, immediately |
| ban (`banUser`) | API, immediately (cookies of the user are rejected at once anyway, §8.4) |
| user deletion (`userPurge` job) | before deleting the workspace and home (`purge`, §9.4) |
| idle, key expiry, stuck states, orphans | reaper (§6.4) |

### 6.4 Idle detection and reaper

The editor proxy records activity in memory and in MongoDB:

- `editors.lastActivityAt = now` on every proxied HTTP request (written at most once per 60 s per user);
- every 60 s while the user has at least one open proxied WebSocket.

An open browser tab keeps its WebSocket, so it keeps the editor alive. Closing the tab lets it idle out.

The reaper runs in the `reconciler` component every 60 s under the `reconciler` lock:

| Condition | Action |
|---|---|
| `running` and `lastActivityAt < now − SCANTOR_EDITOR_IDLE_TIMEOUT` | stop (`idle`) |
| `running` and `apiKeyExpiresAt < now + 5 min` | stop (`keyExpired`). The user reopens and gets a fresh key. |
| `starting` for longer than `SCANTOR_EDITOR_START_TIMEOUT` + 30 s, or `stopping` for longer than 2 min | stop again (cleanup) |
| `running` but the container is not running or `/healthz` fails three times in a row | stop (`orphan`) |
| a container with `scantor.kind=editor` whose user has no editor in `starting`/`running` | remove the container |
| an apikey with `configId: "editor"` whose user has no editor in `starting`/`running` | delete it |

At orchestrator boot the same sweep runs once before the API serves editor sessions.

## 7. The editor API key

| Property | Value |
|---|---|
| storage | better-auth `apikey`, `configId: "editor"`, `referenceId: userId`, name `editor`, prefix `sk_scantor_editor_` ([auth](auth.md) §8.1), hashed |
| lifetime | minted at every editor start, `expiresIn` = `SCANTOR_EDITOR_API_KEY_TTL`; deleted at every stop, ban and user deletion. At most one exists per user. |
| visibility | `listApiKeys?configId=editor` shows it to its owner. It cannot be created through the API. |
| privileges | the owner's user principal with these restrictions, enforced by the auth middleware ([auth](auth.md)): **never admin** (admin-only operations answer 403 `adminRequired`, even for admins), not accepted by `createEditorSession` (403 `forbidden`), `createApiKey` or other session-only routes, and rejected on `/api/auth/*` like every API key ([auth](auth.md) §5.2). On `/mcp` it is accepted at level `write` only, so agents inside the editor can use MCP ([mcp](mcp.md) §3.7). |
| exposure | It is in the editor's environment, so any code the user runs in the editor (terminal, extensions, trusted workspace tasks) can read it. That is equivalent to the user's own access to their own resources, and the restrictions above cap it. |

## 8. The editor origin and proxy

### 8.1 Listener and Host check

The editor origin is served by a **dedicated HTTP listener inside the orchestrator process on container
port 3001**. A Nitro plugin starts it with `node:http` `createServer` plus an `upgrade` handler. Compose
publishes it as `${SCANTOR_BIND_ADDRESS}:${SCANTOR_EDITOR_PORT}:3001`, and Traefik routes
`editor.<domain>` to it ([deployment](deployment.md)). It runs where the `api` component runs.

| Listener | Accepts `Host` | Serves |
|---|---|---|
| dashboard (3000, Nitro) | anything except the editor host, which gets 421 Misdirected Request | UI, `/api`, `/mcp`; never editor routes |
| editor (3001) | only the host (and port) of `SCANTOR_EDITOR_URL`; everything else gets 421 | `/_auth` and the proxy; nothing else (no `/api`, no assets) |

- The orchestrator refuses to start when `SCANTOR_EDITOR_URL` and `SCANTOR_PUBLIC_URL` have the same
  origin ([deployment](deployment.md) §8.2).
- The `Host` header is used as sent. Traefik preserves it, and `X-Forwarded-Host` is never trusted.
- Listener settings: `requestTimeout: 0` (uploads into the editor), `headersTimeout: 60000`. In
  development the plugin retries `listen` on `EADDRINUSE` for 10 s, because Nitro reloads.

### 8.2 Routes on the editor origin

| Route | Auth | Behaviour |
|---|---|---|
| `GET /_auth?code=<code>` | one-time code | Redeem the code (§8.3). Set the cookie and answer 302 to `/?folder=/home/coder/workspace[/<task>]`, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Invalid or expired code: 401 page. More than 30 failures per minute per client IP: 429. |
| everything else, HTTP | `scantor_editor` cookie | Editor `running`: proxy (§8.6). `starting`: a small HTML "Starting your editor…" page with `<meta http-equiv="refresh" content="2">` (503, `Retry-After: 2`). `stopped`/`stopping`: a 410 page linking to `SCANTOR_PUBLIC_URL`. Missing or invalid cookie: a 401 page linking to `SCANTOR_PUBLIC_URL`. |
| everything else, WebSocket upgrade | cookie + `Origin` check | §8.7 |

code-server is served at the **root** of the editor origin. There is no path prefix, so there is no
prefix stripping and no trailing-slash redirect, and code-server's relative URLs work as is.

### 8.3 One-time-code handoff

```
dashboard (session or default API key)          orchestrator                         editor origin
 POST /api/editor/session {open?: "echo"} ──►  ensure editor (starting/running)
                                               code := "sec_" + base64url(32 random bytes)
                                               codes[code] = {userId, open, expiresAt: now+60s}
                          ◄── {url: "<SCANTOR_EDITOR_URL>/_auth?code=<code>", expiresAt, editor}
 navigate (new tab) or <iframe src=url> ─────────────────────────────────────────►  GET /_auth?code
                                               consume codes[code] (single use)
                                               cookie := sign(userId, editors.startedAt, now+12h)
                                               ◄── 302 /?folder=…  Set-Cookie: scantor_editor=…
```

- Codes (`sec_` + base64url of 32 random bytes, [auth](auth.md) §12) live in an in-memory map of the
  `api` component. They are single use, expire after 60 s, and are swept every minute.
- `open` is a task name (validated slug, must exist for the user) or absent. It selects the folder:
  `/home/coder/workspace/<task>` or `/home/coder/workspace`. Opening the task folder gives each language
  server the right project root (`pyproject.toml`, `go.mod`, `tsconfig.json`).

### 8.4 The `scantor_editor` cookie

Value: `v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>`, where
`mac = base64url(HMAC-SHA256(key("editor-cookie"), "v1.<userId>.<editorStartedAtMs>.<expiresAtMs>"))`
([architecture](architecture.md) §9).

Attributes: `HttpOnly; Path=/; SameSite=Lax; Max-Age=43200` (12 h), plus `Secure` when
`SCANTOR_EDITOR_URL` is https. There is no `Domain` attribute (host-only).

On every request and upgrade the cookie is valid only if:

1. it parses and the MAC matches (constant-time compare);
2. `expiresAt > now`;
3. the user exists and is not banned (cached ≤ 30 s, the same cache as the auth middleware);
4. the user's editor is `starting` or `running` with `startedAt == editorStartedAtMs` (cached ≤ 5 s).
   Stopping or restarting an editor therefore invalidates all its cookies.

The editor origin accepts **no other credential**: no dashboard session, no API key, no
`Authorization` header.

### 8.5 Safe socket connect

The user controls the contents of their socket directory. They could replace `code.sock` with a symlink,
for example to `/var/run/docker.sock` or to another user's socket, both of which exist in the
orchestrator's mount namespace. A plain `connect(path)` follows symlinks and cannot be checked without a
race. The proxy therefore connects through a file descriptor that pins the inode:

```ts
const O_PATH = 0o10000000;                                  // Linux, same value on amd64 and arm64
function connectEditorSocket(userId: string): net.Socket {
  const path = `/run/scantor/editor-sockets/${userId}/code.sock`;   // userId: validated uuid; the parent
  const fd = fs.openSync(path, O_PATH | fs.constants.O_NOFOLLOW);   // directory is not user-writable
  const st = fs.fstatSync(fd);
  if (!st.isSocket() || st.uid !== 1000) { fs.closeSync(fd); throw new EditorUnavailable(); }
  const sock = net.createConnection({ path: `/proc/self/fd/${fd}` });   // connects to exactly that inode
  const close = () => { try { fs.closeSync(fd); } catch {} };
  sock.once("connect", close); sock.once("error", close);
  return sock;
}
```

With `O_PATH | O_NOFOLLOW`, a symlink is opened as the link itself, so `fstat` reports
`S_IFLNK` and the connection is refused. Connecting through `/proc/self/fd/<n>` reaches the pinned socket
inode (verified in `node:26-alpine` on arm64: a real socket connects, a planted symlink to the Docker
socket is rejected). The per-user directory itself sits in the volume root, which no editor can write to.
The orchestrator runs as root in its container, so it may connect to the 0600 socket.

### 8.6 HTTP proxy

Each user has an `http.Agent` (keep-alive, `maxSockets` 16) whose `createConnection` is
`connectEditorSocket(userId)`. The agent is destroyed when the editor stops.

| Direction | Rule |
|---|---|
| request line | method and path+query unchanged (code-server is at the root) |
| request headers removed | `cookie`, `authorization`, `proxy-authorization`, `x-api-key`, every `x-scantor-*`, `forwarded`, `x-forwarded-*`, `x-real-ip`, and hop-by-hop headers (`connection`, `keep-alive`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`) |
| request headers kept | everything else, including `host` (unchanged: code-server compares `Origin` with `Host`), `origin`, `user-agent`, `accept*`, `content-*`, `if-*`, `range` |
| bodies | streamed both ways (`pipe`), never buffered; no size cap beyond the editor's own |
| response headers removed | `set-cookie` (nothing on the editor origin may set cookies except `/_auth`; this also keeps code-server or extensions from shadowing `scantor_editor`) and hop-by-hop headers |
| response headers added | §8.8 |
| errors | connect failure → 502 page (and the reaper's health check notices); client abort → destroy upstream |

### 8.7 WebSocket relay

On the listener's `upgrade` event:

```
1. Host must be the editor host                      else "HTTP/1.1 421" + close
2. cookie valid (§8.4)                               else "HTTP/1.1 401" + close
3. Origin header == origin of SCANTOR_EDITOR_URL     else "HTTP/1.1 403" + close   (cross-site WS hijacking)
4. editor running; open WebSockets of the user < 32  else 503 / 429 + close
5. up := connectEditorSocket(userId)
6. write to up: "<METHOD> <path+query> HTTP/1.1\r\n" + filtered headers (§8.6 rules, keeping
   connection: Upgrade, upgrade: websocket, sec-websocket-*, origin, host) + "\r\n" + head
7. up.pipe(client); client.pipe(up)                  byte-level relay (code-server's own status line and
                                                     frames pass through unchanged)
8. close, end (FIN) or error on either side flushes the last bytes and closes both sides (code-server
   does not close its side after the browser's FIN, so half-close is not supported); decrement the open
   count; record activity
```

The byte-level relay was verified with code-server behind a raw Node proxy in Chromium (research). The
Host is preserved, so code-server's own origin check passes.

### 8.8 Response headers on the editor origin

Every response from the editor listener (proxied, `/_auth`, error pages) gets:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `frame-ancestors 'self' <origin of SCANTOR_PUBLIC_URL>`, added as an **additional** header. code-server's own CSP header is kept unchanged; browsers enforce both. `'self'` is required because code-server frames its own origin (web worker extension host, webviews) and `frame-ancestors` checks every ancestor; it lets only the editor origin frame itself. The listener's own pages (401, 410, 503, …) are static HTML without scripts and carry a second restrictive policy (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`). |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `same-origin` (`no-referrer` on `/_auth`) |
| `Strict-Transport-Security` | `max-age=31536000` when `SCANTOR_EDITOR_URL` is https |
| `Cache-Control` | `no-store` on `/_auth` and error pages |

### 8.9 Embedding, cookies and localhost

- The dashboard embeds the editor in an iframe (`allow="clipboard-read; clipboard-write"`) and always
  offers "Open in new tab" ([ui](ui.md)). With Traefik, `editor.<domain>` and `<domain>` are
  **same-site**, so the cookie set inside the iframe is a first-party cookie. If an operator puts the
  editor on a different registrable domain, browsers block the cookie in the iframe and only the new tab
  works.
- Without Traefik (`http://localhost:3000` and `http://localhost:3001`), cookies are **not port-scoped**.
  The dashboard session cookie is also sent to port 3001, and `scantor_editor` to port 3000. This is
  harmless:
  - the editor listener never accepts the session cookie and strips it before proxying;
  - the dashboard never accepts `scantor_editor` as a credential;
  - the dashboard's `Origin` check rejects mutations whose `Origin` is the editor origin
    ([api](api.md) §1.2);
  - cross-origin reads are blocked by CORS.
- Same-site requests from the editor origin to the dashboard carry the dashboard's Lax cookie only on
  localhost. With Traefik the session cookie is host-only on `<domain>` and never reaches
  `editor.<domain>`.

### 8.10 What a malicious workspace can and cannot do

| Attempt | Result |
|---|---|
| JS in a webview or a served workspace file calls the dashboard API | different origin: no session cookie with Traefik; on localhost the Origin check blocks mutations and CORS blocks reads |
| read `scantor_editor` | HttpOnly |
| reach another user's editor | the cookie maps to exactly one user; sockets are only reachable through the proxy; no TCP listener exists |
| reach the Docker socket or another user's socket through a symlink | §8.5 |
| set cookies on the editor origin | `Set-Cookie` is stripped |
| frame the editor on a third-party site | `frame-ancestors 'self' <dashboard origin>` |
| use the editor API key | possible from inside the user's own editor, with that user's non-admin rights (§7) |

## 9. Workspace helpers

### 9.1 Principles

- The orchestrator process never opens, reads, writes, extracts or packs workspace content, uploaded
  archives or git repositories. Every such operation is one run of `scantor workspace <op>` in a
  throwaway container ([architecture](architecture.md) D13).
- A helper sees **one** user's workspace subpath (or no volume at all), has no network (git operations:
  `scantor-egress` only), and holds no secret except, for git operations, the user's own git token.
- Data moves only over stdin/stdout. No files are shared with the orchestrator.
- Every operation is idempotent or atomic. A crash or timeout never leaves a half-replaced task folder
  (§9.6).

### 9.2 Container profile

Equivalent `docker run` (the runner uses the Engine API: create with `OpenStdin`, `StdinOnce`,
`AttachStdin/Stdout/Stderr`, `Tty: false`; attach; start; write stdin and close it; read the
demultiplexed stdout and stderr; wait; remove):

```sh
docker run -i --name scantor-h-<uuid> \
  --label traefik.enable=false --label com.docker.compose.project=scantor-managed --label com.docker.compose.service= \
  --label scantor.managed=true --label scantor.kind=helper --label scantor.user=<userId> --label scantor.op=<op> \
  --user 1000:1000 --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit ${SCANTOR_HELPER_PIDS_LIMIT} --memory ${SCANTOR_HELPER_MEMORY_LIMIT} \
  --memory-swap ${SCANTOR_HELPER_MEMORY_LIMIT} --cpus 1 \
  --network none \
  --log-driver none \
  --mount type=volume,src=scantor-workspaces,dst=/workspace,volume-subpath=<userId> \
  -e HOME=/tmp \
  --entrypoint /usr/local/bin/scantor \
  ${SCANTOR_IMAGE_PREFIX}scantor:${SCANTOR_IMAGE_TAG} workspace <op> [flags]
```

| Aspect | Value | Exceptions |
|---|---|---|
| image | `${SCANTOR_IMAGE_PREFIX}scantor:${SCANTOR_IMAGE_TAG}` (static binary + git) | – |
| user | `1000:1000` | `init`, `purge`: `0:0` with `--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER` |
| network | `none` | `git-clone`, `git-pull`: `scantor-egress` |
| mounts | `scantor-workspaces` subpath `<userId>` at `/workspace` | `list --archive`, `read --archive`: no mount. `init`, `purge`: whole `scantor-workspaces` at `/volumes/workspaces` and whole `scantor-editor-home` at `/volumes/editor-home`. |
| limits | `SCANTOR_HELPER_MEMORY_LIMIT`, `SCANTOR_HELPER_PIDS_LIMIT`, 1 CPU, wall clock `SCANTOR_HELPER_TIMEOUT` (the runner kills and removes on expiry) | – |
| logging | driver `none`; the output is read through attach | – |
| removal | always removed explicitly after `wait`, or after the timeout kill. `AutoRemove` is not used (it races with `wait`). The boot sweep removes leftover `scantor.kind=helper` containers. | – |

Limits are passed as flags, never through the environment: `--max-files` (`SCANTOR_TASK_MAX_FILES`),
`--max-bytes` (`SCANTOR_TASK_MAX_BYTES`), `--max-workspace-bytes` (`SCANTOR_WORKSPACE_MAX_BYTES`) and,
for `extract`, `--max-pack-bytes` (`SCANTOR_TASK_MAX_PACK_BYTES`).

### 9.3 I/O protocol

| Stream | Content |
|---|---|
| stdin | operation input: a tar.gz (`extract`, `list --archive`, `read --archive`), a JSON document (`write-files`), or closed at once |
| stdout | operation output: exactly **one JSON document** for every operation, except `snapshot` without `--hash-only`, which writes the tar.gz pack |
| stderr | NDJSON events: `{"type":"log","level":"info","msg":"…"}` (level `info` or `warn`); for `snapshot`, a final `{"type":"summary","packSha256":"…","packBytes":n,"fileCount":n,"bytes":n}`; on failure, a final `{"type":"error","error":{"code":"…","message":"…","path":"…","details":{…}}}` |
| exit code | 0 success · 1 user error (the error line explains it; flag and argument errors are `invalidArgument` with exit 1, never cobra's usage text) · 2 internal error · other values (signals, OOM 137) = internal |

The runner caps stdout JSON at 8 MiB and stderr at 1 MiB. It never logs stdout or stdin content, and it
redacts the git credential from any message.

Error codes and their API mapping:

| Helper `error.code` | API error |
|---|---|
| `invalidPath` | 422 `invalidPath` (`details.path`) |
| `invalidArgument` | 400 `badRequest` |
| `tooManyFiles`, `tooLarge`, `workspaceFull` | 413 `payloadTooLarge` (`details: {limit, actual?}`) |
| `notFound` | 404 `notFound` |
| `exists` | 409 `alreadyExists` |
| `manifestInvalid` | 422 `manifestInvalid` (`details.errors: BuildError[]`) |
| `workspaceDirty` | 409 `workspaceDirty` |
| `gitFailed` (also git timeouts) | 422 `gitFailed` (credentials redacted) |
| `gitDiverged` | 409 `gitDiverged` |
| `internal`, timeout of a non-git operation, unparseable failure | 500 `internal` (logged with the stderr tail) |

### 9.4 Operations

All task-scoped operations take `--task <name>` (a slug; the folder `/workspace/<name>`). "Summary" means
`{packSha256, fileCount, bytes}` of the task folder, computed with the same `pack` code as
`scantor task pack` ([tasks](tasks.md)). The orchestrator copies every summary into the task's
`workspace` cache ([data model](data-model.md) §4.1).

| Op | Flags | stdin | stdout | Effect |
|---|---|---|---|---|
| `init` | `--user <userId>` | – | `{"created": ["workspaces/<id>", "editor-home/<id>"]}` | Creates `<id>` in both volumes if missing (1000:1000, 0700) and `<id>/.scantor-staging` in the workspace. An existing entry must be a real directory; owner and mode are fixed. Reads no content. |
| `purge` | `--user <userId>` | – | `{"removed": [...]}` | Removes `<id>` from both volumes (Go `os.RemoveAll`, which never follows symlinks). Reads no content. |
| `list` | `--task`, `--path` (default `""`), `--recursive` (default true), `--max-entries 5000` | – | `{"entries": [{path, type: "file"\|"dir"\|"symlink", size, mode}], "truncated": bool}` | Sorted by path, `lstat` only (symlinks are listed, never followed). |
| `list --archive` | `--path`, `--recursive`, `--max-entries` | tar.gz (a revision snapshot streamed from S3) | same | for `listTaskFiles?revision=` |
| `read` | `--task`, `--path`, `--max-bytes 1048576` | – | `{path, size, sha256, encoding: "utf8"\|"base64", content, truncated}` | `sha256` covers the whole file. The content is cut at `--max-bytes`. `utf8` when the file is valid UTF-8 without NUL, else `base64`. A symlink or directory gives `invalidPath`. |
| `read --archive` | `--path`, `--max-bytes` | tar.gz | same | for `readTaskFile?revision=` |
| `write-files` | `--task`, `--create` (allow creating the task folder) | `{"files": {"<path>": "<utf-8>" \| {"base64": "…"}}}` (≤ 200 files; the validated API body) | `{"written": [paths], "workspace": summary}` | Path rules (§9.5). Parents are created (0755). Each file is written to a temp file in the same directory, then renamed (0644). Caps are checked before writing. |
| `delete-files` | `--task`, `--path`, `--recursive` | – | `{"deleted": [paths], "workspace": summary \| null}` | Never deletes through a symlinked parent; deleting a symlink removes the link. `--path ""` with `--recursive` removes the whole task folder (task deletion; `workspace: null`); deleting a missing task folder this way succeeds with `deleted: []`, so a retried `taskDelete` job is idempotent. `deleted` lists at most 5000 paths, the deleted directory first. |
| `scaffold` | `--task`, `--language`, `--template`, `--description` | – | `{"workspace": summary}` | Renders the embedded scaffold ([tasks](tasks.md)) into the folder, which must not exist or be empty (`exists`). |
| `extract` | `--staging <id>`, `--max-pack-bytes` | a tar.gz (the upload stream) or a zip archive (detected by its magic bytes; buffered in memory up to `--max-pack-bytes`) | `{"staging": "<id>", "manifest": {…normalised…}, "summary": {packSha256, fileCount, bytes}}` | Extracts into `/workspace/.scantor-staging/<id>/tree` with the archive rules of §9.5, validates `scantor.yaml` (strict schema) and reports the manifest. `manifestInvalid` when it is missing or invalid. |
| `git-clone` | `--url`, `--ref`, `--path`, `--staging <id>`, `--allow-private` | – | `{"commit": "<sha>", "candidates": [{path, name, language, valid, errors, summary}]}` | Shallow fetch into staging, then every `scantor.yaml` under `--path` is found and validated (§9.7). |
| `git-pull` | `--task`, `--url`, `--ref`, `--path`, `--base-commit`, `--staging <id>`, `--allow-private` | – | `{"commit", "previousCommit", "fastForward": bool, "changed": bool, "candidate": {path, name, language, valid, errors, summary}, "current": summary \| null}` | Fetches the ref into staging, checks ancestry and reports the current workspace summary (§9.7). |
| `commit` | `--staging <id>`, `--from <relpath>` (default: the staging root), `--task`, `--expect <sha256\|absent\|any>` | – | `{"task", "changed": bool, "previousPackSha256": string \| null, "workspace": summary}` | Atomic replace of the task folder from staging (§9.6). Without `--from` the staging directory is then removed; with `--from` the rest of the staging tree is kept for further commits of the same checkout, and the orchestrator ends with `discard` (git import with several candidates, git pull). |
| `discard` | `--staging <id>` | – | `{}` | Removes the staging directory. |
| `snapshot` | `--task`, `--hash-only` | – | the tar.gz pack, or the summary JSON with `--hash-only` | Deterministic pack of the task folder. Symlinks are stored as symlinks and never dereferenced; `.git/` and `.scantor/` are excluded ([tasks](tasks.md)). The consumer verifies `packSha256` against its own hash of the stream. |

### 9.5 Path rules and caps

Every path in requests, archives and file maps must satisfy all of these:

- relative and `/`-separated; valid UTF-8; no NUL, no backslash, no leading `/`;
- no empty, `.` or `..` segments;
- each segment ≤ 255 bytes, whole path ≤ 1024 bytes, depth ≤ 32;
- not inside `.scantor-staging`.

Writes never pass through a symlink: every existing component is checked with `lstat`, and a symlink
gives `invalidPath`.

Archive rules (`extract`, and the source tree of `commit`):

| Rule | Detail |
|---|---|
| entry types | regular files and directories only. Symlinks, hardlinks, character and block devices, FIFOs and contiguous files are rejected (`invalidPath`). PAX and GNU long-name headers are consumed. |
| duplicates | a path that appears twice is rejected (`invalidPath`) |
| ownership and modes | tar uid/gid are ignored (files are owned by 1000:1000); files get 0644, or 0755 when any executable bit is set; directories get 0755 |
| top-level directory | if `scantor.yaml` is not at the root but every entry is under one directory that contains it (GitHub tarball style), that directory is stripped |
| caps, counted while streaming | compressed bytes ≤ `--max-pack-bytes` (the API also caps the stream), entries (files, directories and symlinks, the unit the pack counts for `SCANTOR_TASK_MAX_FILES`) ≤ `--max-files`, uncompressed bytes ≤ `--max-bytes` (gzip-bomb safe), and the whole user workspace after the operation ≤ `--max-workspace-bytes` |
| hard excludes | `.git/` and `.scantor/` are dropped at any depth, as the pack does ([tasks](tasks.md) §9.2) |
| git sources | `.git/` is never copied into a task folder; a symlink in the selected subtree is `invalidPath` ("symlinks are not supported in imported tasks") |

Task folders created by upload or import therefore contain only regular files and directories. Users
can still create symlinks in their editor; snapshots keep them and BuildKit resolves them inside the
context ([tasks](tasks.md)).

### 9.6 Staging and atomic commit

```
/workspace/
  echo/                         task folders (one per task name)
  .scantor-staging/<id>/tree/   extract / git-clone / git-pull output
  .scantor-staging/<id>/old/    the previous task folder during commit
  .scantor-staging/.tmp-<id>/   scratch space of one helper run (the pack spool, up to the task's size;
                                a helper's /tmp is a 64 MiB tmpfs), removed when the run ends
```

`commit` (under the user's exclusive lock, §9.8):

```
src := staging/<id>/tree[/<from>]; validate src (archive rules, caps)
cur := exists(/workspace/<task>) ? pack(/workspace/<task>).sha256 : "absent"
new := pack(src).sha256
if --expect ∉ {any, cur} and cur != new → error workspaceDirty {details: {current: cur, expected}}
if cur == new → changed = false (nothing moves)
else:  rename /workspace/<task> → staging/<id>/old   (skipped when absent)
       rename src → /workspace/<task>                 (same filesystem: atomic)
       remove staging/<id>
```

- The orchestrator decides on conflicts **before** `commit` and passes the current workspace hash it based
  that decision on as `--expect`, so an edit that lands between the decision and the commit still fails
  with `workspaceDirty`:
  - upload: the current hash comes from `snapshot --hash-only` (`absent` when the task folder does not
    exist). There is no conflict when the folder is absent or the current hash equals the uploaded hash,
    `latestRevision.packSha256` or `tasks.workspace.lastSyncSha256`; otherwise the API answers 409
    `workspaceDirty` and runs `discard` ([tasks](tasks.md) §13, [api](api.md) §5.3). With `force=true` the
    expected value is `any`.
  - git import: `absent` (a new task folder).
  - git pull: `current.packSha256` reported by `git-pull` (`absent` when `current` is null), or `any` with
    `force=true` (§9.7).
- A workspace identical to the new content is never a conflict (`cur == new` above).
- After a successful upload, git import or git pull `commit`, the orchestrator sets
  `tasks.workspace.lastSyncSha256` to the committed hash. Editor and file-route writes never set it.
- Every helper run first deletes staging directories older than 1 h, so staging left behind by crashed
  requests disappears on its own.
- Open editors see the folder replaced (file watchers), which is the expected behaviour.

### 9.7 Git operations

Both git operations run on `scantor-egress` with this environment and these options. Every git command
runs inside the staging tree with `GIT_CEILING_DIRECTORIES` set to its parent, so git never finds a
repository above it. During fetch and checkout the staging directory is measured every 250 ms, and git is
stopped with `workspaceFull` once it exceeds the room left below `--max-workspace-bytes` (the exact cap
check after checkout remains).

| Item | Value |
|---|---|
| environment | `HOME=/tmp`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https`; with a credential: `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://<host>/.extraheader`, `GIT_CONFIG_VALUE_0=Authorization: Basic <base64(username:token)>` |
| `-c` options | `protocol.file.allow=never`, `http.followRedirects=false`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`, `http.curloptResolve=<host>:443:<ip>` (pins the validated address, so DNS rebinding cannot switch hosts) |
| URL rules | `https://` only; no userinfo; no leading `-`; the host resolves only to public addresses (not loopback, private, link-local, CGNAT or ULA) unless `--allow-private` (`SCANTOR_GIT_ALLOW_PRIVATE=true`). The orchestrator applies the same rules before starting the helper. |
| credential | Only a credential whose `host` equals the URL host exactly is passed (`host[:port]` exactly as in the URL; a credential for another host fails the run with `invalidArgument`). It is decrypted by the orchestrator just before the run ([data model](data-model.md) §4.9). |
| custom CA | When `SCANTOR_CA_CERT` is set on the orchestrator, it is passed to git helpers as `SCANTOR_CA_CERT`. The helper writes the system bundle followed by these certificates to `/tmp/ca-bundle.pem` and sets `GIT_SSL_CAINFO` to it, so the custom CAs are added to the system roots and never replace them (private git servers; the test stack's fixtures server). TLS verification is never disabled. |

`git-clone`:

```
git init staging/<id>/tree && git -C … remote add origin -- <url>
git -C … fetch --depth 1 --no-tags origin <ref>        // a branch, tag, full commit sha or HEAD
git -C … checkout --detach FETCH_HEAD                  // no submodules
commit := git rev-parse HEAD
candidates := every scantor.yaml under tree/<path> (depth ≤ 6, skipping .git and node_modules),
              each validated against the manifest schema and summarised
```

`git-pull`:

```
git init … && fetch --filter=tree:0 --no-tags origin <ref>   // the commit graph without trees or blobs
fastForward := git merge-base --is-ancestor <base-commit> FETCH_HEAD    (false when base is unknown)
checkout --detach FETCH_HEAD (trees and blobs fetched lazily); candidate := tree/<path>
current := summary of /workspace/<task> (or null)
```

The orchestrator then decides ([api](api.md) §4.8):

| Situation | Result |
|---|---|
| `!fastForward` and not `force` | `discard`, 409 `gitDiverged` ("remote history is not a fast-forward") |
| `current.packSha256 != task.source.git.packSha256` and not `force` | `discard`, 409 `gitDiverged` ("local changes since the last import/pull") |
| `!changed` | `discard`, 200 with `changed: false` |
| otherwise | `commit --from <path> --expect <current.packSha256, or absent when current is null>` (`--expect any` with `force`); then `source.git.{commit, packSha256, pulledAt}` and `workspace.lastSyncSha256` are set to the new commit and pack hash |

### 9.8 Concurrency and locking

- A global semaphore of `SCANTOR_HELPER_CONCURRENCY` helpers. A request waits up to 30 s for a slot,
  then fails with 503 `unavailable`.
- A per-user read/write lock in the `api` component:
  - exclusive: `write-files`, `delete-files`, `commit`, `scaffold`, `init`, `purge`;
  - shared: `list`, `read`, `snapshot`, `extract`, `git-clone`, `git-pull`, `discard`.

  Editors write concurrently with helpers. A snapshot taken while the user is saving captures whatever
  is on disk, and the pack hash makes such races visible.
- `init` runs once per user per orchestrator process (cached), before the first helper of that user and
  before every editor start.

### 9.9 API operations and their helpers

| API operation | Helper sequence |
|---|---|
| `createTask` | `init` → `scaffold` |
| `uploadTask` | `extract` (stdin = request body) → the orchestrator finds or creates the task by `manifest.name` → `snapshot --hash-only` of the task folder (skipped for a new task) → conflict decision (§9.6) → `commit --expect <current hash \| absent \| any>` and `lastSyncSha256` := uploaded hash, or `discard` and 409 `workspaceDirty` → publish unless `publish=false` (as `publishRevision` below) |
| `importGitTask` | `git-clone` → one valid candidate, or the candidates in `select`: `commit --from <path> --expect absent` per task, then `source.git` and `lastSyncSha256` := the candidate's pack hash → `discard`. Several candidates without `select`: `discard`, return the candidates. |
| `pullGitTask` | `git-pull` → decision (§9.7) → `commit` or `discard` |
| `listTaskFiles`, `readTaskFile` | `list` / `read`; with `revision`: `list --archive` / `read --archive`, stdin streamed from `snapshots/<taskId>/<packSha256>.tar.gz` |
| `writeTaskFiles`, `deleteTaskFile` | `write-files` / `delete-files` |
| `getTaskWorkspace` | `snapshot --hash-only` |
| `downloadTaskWorkspace` | `snapshot` (stdout streamed to the client as `application/gzip`) |
| `publishRevision` (also the publish step of `uploadTask`) | `snapshot` at request time → S3 `snapshots/<taskId>/<packSha256>.tar.gz`, before the revision is inserted; the `revisionBuild` job later streams that S3 object into `scantor task build` and never reads the live workspace ([tasks](tasks.md) §10) |
| `testTask` (`testRun` job) | `snapshot` of the live workspace at job time → `scantor task build` ([tasks](tasks.md) §11.1) |
| `deleteTask` (`taskDelete` job) | `delete-files --path "" --recursive` |
| `deleteUser` (`userPurge` job) | stop the editor (§6.3) → `purge` |
| editor start | `init` |

## 10. Security summary

| Threat | Mitigation |
|---|---|
| another tenant (editor terminal, master worker) connects to a victim's code-server | code-server has no TCP listener; the socket is reachable only through the orchestrator proxy with the owner's cookie |
| workspace JS uses the dashboard session | separate origin; the session cookie is host-only; `Origin` checks; CORS |
| the proxy forwards credentials into the container | `cookie`, `authorization` and `x-api-key` are stripped; only `scantor_editor` is accepted, and it is never forwarded |
| socket symlink swap (Docker socket, other users) | `O_PATH \| O_NOFOLLOW`, `fstat` (socket, uid 1000), connect through `/proc/self/fd` (§8.5) |
| a malicious repo auto-runs code on folder open | workspace trust on, `task.allowAutomaticTasks: off`, no `--disable-workspace-trust` |
| editor key exfiltration | the key is the user's own and never admin; rotated at every start; deleted at stop; lifetime bounded by `SCANTOR_EDITOR_API_KEY_TTL` |
| clickjacking of the editor | `frame-ancestors` = the dashboard origin plus `'self'` (code-server's own nested frames) |
| login CSRF (a victim redeems the attacker's code) | codes are single use and valid for 60 s; the window title shows the owner (`--app-name`); opening the editor from the dashboard always issues a new cookie. Accepted residual risk. |
| tar slip, symlink, hardlink, device entries, zip bombs | helper archive rules (§9.5) inside a sandbox with only the user's subpath and no network |
| git clone-time RCE (CVE-2024-32002 class), SSRF | git runs only in helpers; no submodules, hooks disabled, https only, no redirects, private addresses rejected and pinned; `scantor-egress` has inter-container traffic disabled; the egress deny list applies |
| cross-user file access | volume subpaths; `init`/`purge` touch only a validated uuid directory and never read content |
| privilege escalation in the editor | read-only rootfs, `CapDrop ALL`, `no-new-privileges`, no Docker socket, no fixuid |
| disk exhaustion through the editor | not hard-limited in v1 (Docker volumes have no quotas). Helper operations refuse to grow a workspace beyond `SCANTOR_WORKSPACE_MAX_BYTES`, and `getTaskWorkspace` reports sizes. See future extensions. |

## 11. Decisions made in this document

Decisions 1, 3, 4, 5, 6 and 7 are approved by the lead. The rest are flagged for lead review:

1. **Dedicated editor listener on container port 3001** instead of Host-dispatch inside Nitro on port
   3000. The reason: Nitro 2 / h3 v1 resolves WebSocket upgrades by route path only, its
   `proxyRequest` buffers bodies and drops headers, and a catch-all route would shadow the Nuxt
   renderer. The dedicated listener gives a byte-level relay (the research-verified pattern) and makes
   "nothing but the editor on the editor origin" structural. Host checks remain on both listeners. This
   deviates from decisions.md §5 ("the orchestrator container's port published a second time").
2. **Safe socket connect** through `O_PATH | O_NOFOLLOW` + `/proc/self/fd` (verified), plus a uid check.
3. **Fixed uid:gid 1000:1000** for editors and helpers; isolation by subpath; the official fixuid
   entrypoint is bypassed, so `no-new-privileges` and a read-only rootfs work (verified).
4. **New volume `scantor-editor-home`** (subpath `<userId>`) for settings, shell history and caches;
   created at boot by the orchestrator.
5. **Read-only rootfs and baked, read-only extensions**; no user-installed extensions in v1.
6. **The editor API key is never admin**, is rejected by session-only routes and `createEditorSession`,
   has a TTL of `SCANTOR_EDITOR_API_KEY_TTL`, and the reaper stops the editor at expiry.
7. **Cookie** `v1.<userId>.<startedAtMs>.<expiresAtMs>.<mac>`, 12 h, bound to `editors.startedAt`.
8. **Idle** = no proxied request and no open WebSocket for `SCANTOR_EDITOR_IDLE_TIMEOUT`.
   `--idle-timeout-seconds` is not used; the orchestrator owns the lifecycle.
9. **Helper protocol:** one JSON document on stdout (the tar.gz for `snapshot`), NDJSON on stderr, exit
   codes 0/1/2, and the error code mapping of §9.3. Limits are passed as flags.
10. **New helper operations** `commit`, `discard`, `init`, `purge`, `list --archive` and
    `read --archive`, plus a staging area `.scantor-staging/` with an atomic rename-based replace. Two
    phases (`extract`/`git-*` → `commit`) let the orchestrator decide on conflicts between them.
11. **Imported and uploaded task folders contain no symlinks**; git imports with symlinks are rejected
    with a clear message.
12. **`Set-Cookie` from code-server is stripped** on the editor origin.
13. **`SCANTOR_EDITOR_MAX_RUNNING`** caps concurrent editors (429 `tooManyRequests`).
14. **Git pull** uses a fresh `--filter=tree:0` fetch plus `merge-base --is-ancestor`, instead of a
    `.git` directory in the workspace. Workspaces never contain the imported repository's `.git`.

## 12. Backbone change requests (written here as if applied)

- [architecture](architecture.md) §4.1 (editor manager), §6.3 and [api](api.md) §9: the editor origin is
  the orchestrator's dedicated listener on container port **3001** (`SCANTOR_EDITOR_PORT → 3001`; the
  Traefik editor router targets 3001). The dashboard listener answers 421 for the editor host. Host
  dispatch therefore happens per listener, not inside Nitro.
- [architecture](architecture.md) §4.2: the workspace helper operations are `init | purge | list | read |
  write-files | delete-files | scaffold | extract | git-clone | git-pull | commit | discard | snapshot`
  (`list` and `read` with `--archive`).
- [architecture](architecture.md) §4.5 and §7: add the volume `scantor-editor-home` (editors: subpath
  `<userId>` at `/home/coder`; `init`/`purge` helpers: whole). `init`/`purge` helpers run as root with
  `CHOWN`, `DAC_OVERRIDE` and `FOWNER` and the whole `scantor-workspaces` and `scantor-editor-home`
  volumes. They never read content.
- [architecture](architecture.md) §4.1 boot step 6: ensure the network `scantor-egress` and the volumes
  `scantor-workspaces` and `scantor-editor-home` (compose does not create them).
- [data model](data-model.md) §4.15: add `apiKeyExpiresAt` (Date | null, *internal*); `startedAt` is set
  on entering `starting` and binds editor cookies.
- [api](api.md) §4.18 `createEditorSession`: 429 `tooManyRequests` when `SCANTOR_EDITOR_MAX_RUNNING`
  editors are running; `open` is a task name; `editor.state` may be `starting`.
- [api](api.md) §4.7: `listTaskFiles`/`readTaskFile` with `revision` read the S3 snapshot through
  `list --archive`/`read --archive` helpers (never in-process).

## 13. Future extensions

| Extension | How the design accommodates it |
|---|---|
| User-installed extensions | Add a per-user extensions directory in `scantor-editor-home`, seeded from the baked set at start. The home volume already persists per user. |
| Workspace and home quotas | Per-user volumes or XFS project quotas on the `<userId>` directories. Helpers already measure sizes; the reaper could stop editors above a quota. |
| Shared or team workspaces | Volume subpaths are keyed by the owner id; a future `ownerRef` (organisation) maps to a subpath of its own, and the cookie and editor document would carry the owner reference. |
| Multi-replica orchestrator | Move one-time codes and editor activity to MongoDB. Editor proxies must run on the host that mounts `scantor-editor-sockets`; route the editor origin to that replica. |
| Other editor types (JupyterLab, plain terminal) | The proxy speaks HTTP and WebSocket over a unix socket and is application-agnostic; an `editors.kind` field would select image and flags. |
| Collaborative or admin read-only view | A separate read-only container mounting the subpath `:ro`, with its own cookie scope. The editor itself stays owner-only. |
| Browser-side debugging | Debug adapters run inside the editor; a future `testRun` debug mode could expose a debug port to the editor over `scantor-sandbox`. |
| In-tree relative symlinks in uploads | The archive rules could accept symlinks whose lexical target stays inside the task folder; packs already store symlinks. |
| git over SSH, submodules | Separate opt-in helper flags. The git environment is built in one place (§9.7). |
| Helper execution on separate builder nodes | Helpers are stateless commands with stdin/stdout I/O; any host that mounts the volume could run them. |
