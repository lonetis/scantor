# CLAUDE.md — scantor

scantor is a self-hosted platform that runs user-defined scanning tasks (Python, TypeScript, JavaScript,
Go) at large scale on many Docker hosts, including hosts behind firewalls. Users author tasks in a
browser editor, with the CLI or through an LLM agent over MCP, publish immutable revisions, start scans
that fan out into millions of analyses, and query and export the typed results.

This file is the index for agents developing this repository. `README.md` is user-facing only.

## Repository layout

| Path | Contents |
|---|---|
| `cmd/scantor/`, `internal/` | the single Go binary (module root `go.mod`): CLI, node daemon, runtime, task pipeline, workspace helpers, templates, conformance harness, shared packages |
| `orchestrator/` | Nuxt 4 + Nuxt UI 4 app: `app/` (UI), `server/` (`api/` routes, `routes/` `/mcp`, `middleware/`, `plugins/`, `services/`, `utils/`), `shared/` (types, zod schemas), `test/` (vitest) |
| `connectors/` | per-language connector libraries (`python`, `js` = `@scantor/connector` for TS and JS, `go`); each Dockerfile builds a base image |
| `scaffolds/` | task starters per language (rendered by `scantor init`; Go `go.mod`/`go.sum` stored as `*.tmpl`) |
| `tasks/` | example tasks; together they cover every language and every template |
| `schemas/` | canonical JSON: manifest, describe output, `languages.json`, `managed-labels.json`, protocol, AMQP messages, templates (+ fixtures) |
| `editor/` | `scantor-editor` image (code-server); its `toolchain` stage is also the devcontainer |
| `tests/` | dockerized Playwright suites, shared corpora, `FEATURES.md`, generated `TESTS.md` |
| `docs/`, `docs/guide/` | internal specifications; user guides (embedded into the binary and the orchestrator image, served over MCP) |
| `skills/`, `.claude-plugin/`, `.mcp.json` | agent skills shipped as a Claude Code plugin, and the MCP client config |
| `traefik/dynamic/` | Traefik file-provider directory (empty by default) |
| `.devcontainer/`, `.github/workflows/` | devcontainer; CI (`images.yml`, `release.yml`, `test.yml`) |
| root files | `Dockerfile` (scantor image), `docker-bake.hcl` (every image build), `docker-compose.{dev,prod,tests}.yml`, `justfile`, `scantor.sh` (CLI docker shim), `embed.go`, `.env.example` |

## Terminology

The glossary in [docs/architecture.md](docs/architecture.md) §2 is binding in code, API, UI and docs,
including its "Not" column; `tests/scripts/check-terms.mjs` enforces a subset for the UI, guides and
README. The most important terms:

| Term | Meaning |
|---|---|
| master / orchestrator | the central deployment / its Nuxt app (UI, REST `/api/*`, `/mcp`, editor origin, ingestor, reconciler) |
| node (built-in, remote) | a Docker host running a node daemon (`scantor node`); never "agent" or "runner" |
| task | a folder: `scantor.yaml` (manifest), `Dockerfile` (`FROM ${SCANTOR_BASE}`), entry file with types and `schedule`/`run` |
| revision | an immutable numbered build of a task (`echo@3`); never "version" or "release" |
| template | a reusable schedule implemented once in Go (`single`, `list`, `range`, `repeat`, `tranco`, `crux`, `cidr`) |
| scan / analysis | one execution of a revision / one unit of work `<scanId>-<seq>` ending in a result or an error |
| task config / scan config / analysis config | behaviour per scan / input of `schedule` / input of one `run` |
| scan settings | platform knobs: `workers`, `processes`, `timeoutMs`, `maxAttempts`, `backoff`, `resources`, … |
| worker / process | a container running a revision for one scan (scheduler or runner) / one connector process inside it |
| runtime / connector | the Go process injected into every task container / the per-language library the task code imports |

## Architecture in ten lines

1. One static Go binary is the CLI, the node daemon, the runtime (`scantor runtime`), the task pipeline (`scantor task pack | check-static | build`) and the workspace helpers.
2. The orchestrator is one Node process; `SCANTOR_COMPONENTS` selects `api`, `ingestor`, `reconciler`. Infra: MongoDB (rs0), RabbitMQ, RustFS (S3), registry, optional Traefik.
3. Handlers only record intent; the level-triggered reconciler converges (topology, placement, assignments, completion); leased jobs do long work (builds, test runs, deletes, retries, exports).
4. Nodes connect outbound only: they long-poll their desired workers and reconcile local containers; every consumer injects the runtime binary into task containers (never baked into images).
5. Workers run the task image; the runtime speaks NDJSON over fd 3/4 with connector processes. Templates and all retry, timeout, upload and error logic live once in Go.
6. The scheduler streams `schedule` output into a per-scan quorum queue (confirms, backpressure, checkpoints); runners consume with prefetch 1 per process and retry through delayed delivery.
7. The ingestor writes analyses with guarded upserts keyed `<scanId>-<seq>`; the recount is authoritative and completion is one conditional update.
8. The orchestrator never touches workspace content; throwaway helper containers do. Every internal key derives from `SCANTOR_SECRET` (HKDF).
9. MCP tools are generated from the OpenAPI document (`x-mcp`) and executed through the REST routes.
10. Details, flows and decisions: [docs/architecture.md](docs/architecture.md).

## Running things

Every recipe runs its tools in containers; the host needs only Docker, `just` and git. `just --list`
shows all recipes ([docs/development.md](docs/development.md) §4).

| Recipe | Does |
|---|---|
| `just init` | create or complete `.env` from `.env.example` (random secrets) and the cache volumes |
| `just up` / `just down` | build every dev image from source and start `docker-compose.dev.yml` / stop it (volumes kept) |
| `just logs [service…]`, `just ps`, `just restart [service…]` | follow logs, list services and scantor containers, restart |
| `just cli <args>`, `just dev-run <dir>` | the CLI of `scantor:dev` through `scantor.sh` (`SCANTOR_URL`, `SCANTOR_TOKEN` from the shell) |
| `just build`, `just build-images [targets]` | native binary into `bin/` (never used by the stack); bake targets with tag `dev` |
| `just test` | unit suites, then the dockerized Playwright suite |
| `just test-unit`, `just test-go [pkgs]`, `just test-orchestrator [filter]`, `just test-connectors`, `just test-conformance` | unit layers |
| `just test-e2e [args]`, `just test-api`, `just test-ui` | Playwright suite (args go to `playwright test`) |
| `just test-exec [args]` | re-run Playwright in the runner kept alive with `SCANTOR_TEST_KEEP_ALIVE=true` |
| `just test-go-integration`, `just test-orchestrator-integration` | Docker-backed integration tests |
| `just lint`, `just typecheck`, `just fmt` | linters (incl. terminology, `.env.example`, compose), type checks, formatters |
| `just docs [--check]` | regenerate `docs/guide/cli.md` and guide snippet includes |
| `just test-index [--check]` | regenerate `tests/TESTS.md` |
| `just prune`, `just purge` | wipe the dev platform / also caches and dev images |

Run the narrowest suite first (`just test-go ./internal/taskpipe/...`, `just test-orchestrator test/services/query`).

## Conventions

- **Configuration only through environment variables**, documented (with defaults) only in
  `.env.example`; docs name variables but never state defaults. The orchestrator reads the environment
  only in `server/utils/config.ts`; each Go component has exactly one `LoadConfig` built on
  `internal/envconf`, and only `internal/cli` passes `os.Getenv`/`os.LookupEnv` in. Compose passes
  `${VAR}` without defaults. Dev secrets end in `-insecure-dev`.
- **camelCase JSON** everywhere (TS, Go, Python wire, Mongo); ids are uuid v4 except analysis ids.
- **Ownership** through `server/utils/authz.ts` only: `requireUser`/`requireAdmin`, `loadOwned`,
  `loadOwnedScan`, `ownerFilter` (`callerFilter` for the caller-only credential and upload lists),
  `resolveTask`. Order 401 → 404 → 403; another user's resource is 404 `notFound`, never 403. `userId` comes
  from the principal, never the body; request objects never go into Mongo filters.
- **Routes**: one file per method (`server/api/scans/[scanId]/pause.post.ts`), bracket names equal
  OpenAPI parameter names. The first statement is `defineRouteMeta` with a static object of plain
  literals only (no negative numbers, template literals or strings with both quote kinds;
  `test/api/route-meta.test.ts`). `operationId` camelCase verb-first; `x-scantor-scope`; `x-mcp` (at
  most 30 tools); `x-admin-only` iff scope `admin`; `x-read-only` for side-effect-free POSTs. Thin
  handlers: validate with `validateBody/Query/Params`, throw only `apiError(code)`, long work becomes a
  job. Checklist: [docs/development.md](docs/development.md) §9.1.
- **No language switch** anywhere: language knowledge lives in `schemas/languages.json` and the base
  image ENV contract.
- **Managed labels**: every container and network scantor creates gets `ManagedLabels()` (Go
  `internal/container`) / `managedLabels()` (TS `server/utils/labels.ts`), both from
  `schemas/managed-labels.json`; containers are recognised by labels and name prefix. Docker access only
  through `moby/moby/client` wrapped by `internal/container` (`github.com/docker/docker` is forbidden).
- **Containers-only recipes**: recipes call only `docker`, `git` and POSIX tools on the host; tool
  images are pinned at the top of the `justfile`; containers they create carry `scantor.dev=true` or
  `scantor.test=true`.
- **One `<Dockerfile>.dockerignore` per image** outside the root (`orchestrator/`, `editor/`,
  `connectors/<base>/`); the root `.dockerignore` serves only the root `Dockerfile`. All images are
  defined in `docker-bake.hcl`.
- **Nitro plugin numbering** in `orchestrator/server/plugins/`: `00.boot` (foundation boot steps),
  `10.components`, `20`–`89` domain plugins that only register (no I/O at load), `99.start`.
- **No version numbers in files**: builds inject them; dependency pins live in
  [docs/development.md](docs/development.md) §11 and change in the same commit as a bump.
- **Commits**: Conventional Commits with an emoji, `<type>(<scope>): <emoji> <description>`
  (`feat` ✨, `fix` 🐛, `docs` 📝, `style` 🎨, `refactor` ♻️, `perf` ⚡️, `test` ✅, `build` 🏗️, `ci` 👷,
  `chore` 🧹, `revert` ⏪), imperative and lowercase, scopes from [docs/development.md](docs/development.md)
  §12. Commits by an AI agent end with a `Co-authored-by: <agent> <noreply@…>` trailer. Separate tasks,
  separate commits.

## Documentation

Read the doc of the area you touch before changing it. On conflicts the backbone (architecture, data
model, api) wins and the other doc is fixed.

| Doc | Read it when |
|---|---|
| [docs/architecture.md](docs/architecture.md) | always first: glossary, components, containers, networks, flows, key decisions |
| [docs/data-model.md](docs/data-model.md) | touching MongoDB collections, indexes, state machines or the S3 layout |
| [docs/api.md](docs/api.md) | adding or changing a REST route, representation, error code or the node/runtime APIs |
| [docs/auth.md](docs/auth.md) | sessions, API keys, principals, scopes, ownership helpers, machine credentials |
| [docs/security.md](docs/security.md) | anything security-relevant: threat model, mitigation ids, the authorization matrix |
| [docs/tasks.md](docs/tasks.md) | task folders, manifest, connector APIs, schemas, Dockerfile policy, task pipeline, test runs, scaffolds |
| [docs/protocol.md](docs/protocol.md) | the runtime ↔ connector protocol and the conformance harness |
| [docs/runtime.md](docs/runtime.md) | the injected runtime: modes, bootstrap, AMQP, process pool, retries, uploads, local mode |
| [docs/templates.md](docs/templates.md) | template internals: resolve, estimate, streaming, data sources |
| [docs/queue.md](docs/queue.md) | RabbitMQ topology, message formats, the ingestor, recount, completion, stall detection |
| [docs/nodes.md](docs/nodes.md) | the node daemon, worker container spec, placement, egress rules, node security |
| [docs/editor.md](docs/editor.md) | the browser editor, its origin and proxy, workspace helpers, git import |
| [docs/mcp.md](docs/mcp.md) | the MCP server: OAuth, tool generation and curation, untrusted data, guides |
| [docs/ui.md](docs/ui.md) | UI pages, components, forms, polling, CSP |
| [docs/deployment.md](docs/deployment.md) | compose services, Traefik, secrets, production setup, backups, metrics, maintenance |
| [docs/development.md](docs/development.md) | dev environment, recipes, code organization, change checklists, versions, releases |
| [docs/testing.md](docs/testing.md) | test layers, the dockerized suite, fixtures, FEATURES.md, static checks, CI |
| [docs/guide/README.md](docs/guide/README.md) | index of the user guides |
| [docs/guide/authoring-python.md](docs/guide/authoring-python.md), [-typescript](docs/guide/authoring-typescript.md), [-javascript](docs/guide/authoring-javascript.md), [-go](docs/guide/authoring-go.md) | the user-facing task API per language (one per row of `languages.json`) |
| [docs/guide/templates.md](docs/guide/templates.md), [docs/guide/manifest.md](docs/guide/manifest.md) | user view of templates and `scantor.yaml` |
| [docs/guide/errors-and-retries.md](docs/guide/errors-and-retries.md) | user view of errors, retries, conditions and error codes |
| [docs/guide/cli.md](docs/guide/cli.md) | generated CLI reference (`just docs`; never edit by hand) |
| [docs/guide/mcp.md](docs/guide/mcp.md) | connecting agents; its marked section is the MCP server instructions (≤ 8 KiB) |
| [docs/guide/remote-nodes.md](docs/guide/remote-nodes.md) | operator view of remote nodes |

## When you change X, update Y

- **User-visible behaviour** (feature, CLI, UI, setup) → `README.md` and the affected `docs/guide/*.md`.
- **Structure, component, convention or design decision** → this file and the affected `docs/*.md`, in
  the same commit.
- **Behaviour** → `tests/FEATURES.md` lines, tagged tests (`@<AREA>-<NNN>`, e.g. `@SCAN-012`) and `just test-index`.
- **Environment variable** → `.env.example` first (section, default, description, how to obtain a
  secret), then the single config loader, then compose passthrough ([docs/development.md](docs/development.md) §9.5).
- **CLI command or flag, example task included in a guide** → `just docs` (`--check` runs in CI).
- **API route** → [docs/api.md](docs/api.md), a factory in `tests/authz/requests.ts`; if `x-mcp`, also
  [docs/mcp.md](docs/mcp.md), `tests/mcp/tools.spec.ts`, the instructions in `docs/guide/mcp.md` and
  `skills/` (the drift test checks every tool and command they name).
- **Example task** → its entry in `tests/e2e/examples.ts`. **Language or template** → the checklists in
  [docs/development.md](docs/development.md) §9.2 and §9.3.

## Gotchas

- Go changes reach the dev stack only through `just up` (bake rebuilds `scantor:dev`, the dev orchestrator image and the editor); host-built binaries are never mounted.
- A native CLI against the dev stack's local images needs `SCANTOR_IMAGE_PREFIX=` (empty) and `SCANTOR_IMAGE_TAG=dev`; otherwise it references GHCR base images.
- Nitro hot reload follows inodes: tools that replace files (the Edit/Write tools, `sed -i`) leave `nuxt dev` on the old server code without a log line. `touch` another server file to trigger the rebuild.
- `nuxt typecheck` (and `npm run typecheck`) rewrites `orchestrator/.nuxt`, which the dev orchestrator mounts, so `nuxt dev` does a full reload. It does not type-check the vitest files in `orchestrator/test/`.
- `nuxt dev` blocks unknown Host headers with 403 "Blocked request": new hostnames must go into `vite.server.allowedHosts` in `nuxt.config.ts`.
- Nitro serves public assets (`/_nuxt/*`) before any server middleware: headers every response needs belong in the `request` hook (`server/plugins/security-headers.ts`), not in middleware or `routeRules`.
- Import ajv as `ajv/dist/2020.js`: ajv has no exports map, and the production build fails with `ERR_MODULE_NOT_FOUND` while `nuxt dev` works.
- MCP tool calls reach the REST routes through the private loopback listener (`server/utils/loopback.ts`) with single-use capabilities; never route them to port 3000 or `localFetch`.
- Components stop at SIGTERM, while Nitro still drains the open requests (`99.start.ts`): a request that waits (long-poll, `wait`) must also end on `shutdownSignal()` (`server/utils/boot.ts`), or it holds the drain inside the 30 s stop grace; a loop that judges silence (node offline detection) must not run once the signal aborted.
- The task pipeline prunes the host's whole BuildKit cache to `SCANTOR_BUILD_CACHE_MAX_BYTES`; the dev compose sets 0 and a native CLI prunes only when it is set. Never set it on a shared dev machine.
- The dev built-in node allows only `SCANTOR_BUILTIN_NODE_MAX_WORKERS` workers (a scheduler counts), and placement reserves `cpus × processes`; parallel scans wait with `workersPending`.
- Hint counters only increase (progress can briefly exceed 100 % after a cancel); the recount is authoritative. Do not "fix" the hints.
- API `wait` is integer seconds (`?wait=60`); MCP clamps it to 50.
- Orchestrator integration tests share one RabbitMQ and the broker test sweeps unknown `scan-*` users, so the files run serially.
- Docker Desktop: containers cannot reach ports published on the VM's loopback even with `--network host` (some Go integration tests run only on Linux/CI); macOS AirPlay also holds port 5000, so check the registry at `127.0.0.1:5000`.
- `scantor-egress` has inter-container traffic disabled: containers on it cannot reach each other (no test servers there).
- A remote node against the dev stack needs the public endpoints on `host.docker.internal`, a DinD with `--dns` and `--insecure-registry` ([docs/development.md](docs/development.md) §5); restore `.env` afterwards.
