# Testing

This document defines how scantor is tested: the test layers and where each lives, how every suite is
run through `just` recipes (always in containers), the Go, orchestrator and connector unit tests, the
connector conformance harness, the scaffold matrix, and the dockerized Playwright suite that boots a fresh
master (with Traefik, self-signed TLS and a second simulated remote node) inside a privileged
Docker-in-Docker runner. It specifies the runner's phases, the Playwright projects, fixtures and helpers,
every suite (API, UI, e2e scans, MCP agent loop, the generated authorization matrix, security corpora and
chaos cases), the isolation and flake-avoidance rules, the `tests/FEATURES.md` and `tests/TESTS.md`
conventions and the CI workflow. Behaviour under test is defined by the other documents, chiefly
[architecture](architecture.md), [api](api.md) and [data model](data-model.md).

## 1. Test layers

| Layer | Location | Runs in | Needs a stack | Recipe |
|---|---|---|---|---|
| Go unit tests | `**/*_test.go` (root module) | `golang:1.27.3-trixie` container | no | `just test-go` |
| Go integration tests (`//go:build integration`) | same packages | `golang:1.27.3-trixie` + host Docker socket | Docker only | `just test-go-integration` |
| Orchestrator unit tests (vitest) | `orchestrator/test/**/*.test.ts` (paths mirror `server/`, for example `orchestrator/test/utils/labels.test.ts` for `server/utils/labels.ts`; shared code under `orchestrator/test/shared/`, UI utilities under `orchestrator/test/ui/`) | `node:26.12.1-trixie-slim` container | no | `just test-orchestrator` |
| Orchestrator integration tests (vitest, opt-in) | `orchestrator/test/services/**/*.integration.test.ts` | a root `node:26.12.1-trixie-slim` container with the Docker socket (§4.2) | throwaway MongoDB, RabbitMQ, RustFS, registry and code-server containers, started by the recipe and the harness | `just test-orchestrator-integration`; skipped by `just test-orchestrator` |
| Connector unit tests | `connectors/python/tests`, `connectors/js/test`, `connectors/go/*_test.go` | each base image's `test` stage | no | `just test-connectors [base]` |
| Conformance harness | `internal/conformance` + fixture tasks | each base image (through the task pipeline) | Docker only | `just test-conformance [language]` |
| Static checks (terminology, compose, `.env.example`, test index) and their unit tests | `tests/scripts/*.mjs`, `tests/scripts/*.test.mjs` (`node:test`) | node container (the test index: the Playwright image) | no | `just lint` (includes `just lint-compose`), `just test-index --check` |
| Dockerized Playwright suite (API, UI, e2e, MCP, authz, security, scaffold matrix, chaos) | `tests/` | privileged DinD runner (`docker-compose.tests.yml`) | fresh master + remote node inside the runner | `just test-e2e`, `just test-api`, `just test-ui` |

`just test` runs `test-unit` (Go, orchestrator, connectors, conformance) followed by `test-e2e`. Every
recipe is idempotent, creates its own containers with `--rm`, and leaves no containers, networks or
volumes behind except named caches (§3).

## 2. Repository layout of `tests/`

```
tests/
├── package.json                 @playwright/test 1.64.1 (exact), @modelcontextprotocol/client ^2.3.1,
│                                amqplib ^2.2.0, ajv ^8.20.0, yaml ^2.9.1, tar-stream ^3.2.2,
│                                typescript ~6.0.3, @types/node; eslint, prettier (exact)
├── package-lock.json
├── tsconfig.json                strict, ES2023, moduleResolution bundler, verbatimModuleSyntax;
│                                path alias #shared → ../orchestrator/shared
├── eslint.config.mjs, .prettierignore
├── playwright.config.ts
├── global-setup.ts
├── fixtures.ts                  test.extend: the only `test`/`expect` export specs import
├── helpers/                     env, limiter, unique, api-client, openapi, users, webauthn, mcp, tasks, scans,
│                                docker, amqp, keys, tar, ui, cli, fixtures-server (debug: with debug.spec.ts)
├── api/*.spec.ts                REST API behaviour per tag
├── ui/*.spec.ts                 browser tests
├── e2e/*.spec.ts                real scans, examples in every language, remote node, CLI, debug, scaffold matrix
├── mcp/*.spec.ts                MCP catalog, OAuth, API keys, agent loop, guides, docs/skills drift
├── authz/*.spec.ts              OpenAPI lint + generated cross-tenant authorization matrix
│   ├── seed.setup.ts            setup project: seeds tenants A and B (security §7), writes .auth/authz.json
│   ├── seed.teardown.ts         teardown project: deletes them
│   └── requests.ts              parameter map and request factory per operationId (bodies, query) for the matrix
├── security/*.spec.ts           corpora-driven and white-box security tests (§8.6)
├── chaos/chaos.spec.ts          serial fault-injection cases
├── corpora/                     shared data tables (also read by Go and vitest unit tests)
│   ├── dockerfile-policy/<case>/{Dockerfile,expect.json}
│   ├── tar-slip/cases.json
│   ├── paths/cases.json         path rules for upload, write-files and file APIs
│   ├── query-injection/cases.json
│   ├── keys-vectors.json        HKDF test vectors shared by Go and TypeScript
│   └── hostile-labels/Dockerfile
├── fixtures/tasks/<name>/       test-only Python tasks (schema-zoo, netprobe, nondeterministic, big-result,
│                                crashy, no-hello, hostile-label, hostile-output)
├── docker/
│   ├── Dockerfile               runner image (+ Dockerfile.dockerignore)
│   ├── daemon.json              inner dockerd config
│   ├── entrypoint.sh            phases (§7.4)
│   ├── playwright.sh            `playwright test` with the stack's environment (entrypoint and `just test-exec`)
│   ├── stack.tests.yml          compose override layered over docker-compose.prod.yml
│   ├── stack.env                non-secret test settings for the inner stack
│   ├── join-remote-node.mjs     creates the remote node record and starts its daemon inside the remote node
│   ├── traefik/tls.yml          file-provider config that makes the test CA wildcard certificate Traefik's default
│   └── fixtures/                fixtures server image: Dockerfile, main.go (templatestest data sources, git
│                                smart-HTTP, control API), build-repos.sh, repo-task/ (the repositories' task)
├── scripts/
│   ├── test-index.mjs           generates the TESTS.md index; --check mode (only inside a Linux container)
│   ├── test-index.test.mjs      node:test unit tests of test-index.mjs (`just lint`)
│   ├── check-terms.mjs          terminology lint for UI strings and guides
│   ├── lint-compose.mjs         compose rules (§11), run by `just lint-compose`
│   └── lint-env.mjs             `.env.example` rules (§11)
├── FEATURES.md
└── TESTS.md
```

## 3. Running tests

| Recipe | What it does |
|---|---|
| `just test *args` | `test-unit`, then `test-e2e *args` |
| `just test-unit` | `test-go`, `test-orchestrator`, `test-connectors`, `test-conformance` |
| `just test-go *args` | `go test -race -count=1 ./... *args` in a Go container (module and build caches in volumes `scantor-dev-gomod`, `scantor-dev-gobuild`) |
| `just test-go-integration *args` | `go test -timeout 30m -tags integration ./...` (the conformance suite of every connector outlasts the default 10 minutes per package on CI) with the host Docker socket and the host network (tests publish service ports on the host's loopback); tests create containers named `scantor-test-*` with label `scantor.test=true` and remove them in `t.Cleanup`; the images they use (`scantor:dev`, the `scantor-base-*:dev` images, `rabbitmq:4.4-management`, `registry:3.1.2`) must exist locally |
| `just test-orchestrator *args` | `npm ci` (volume `scantor-dev-npm`) and `vitest run` in a Node container |
| `just test-orchestrator-integration *args` | starts throwaway MongoDB (replica set, keyFile, `--noscripting`), RabbitMQ and RustFS on a network `scantor-test-orchestrator-it`, then runs `vitest run` over the `*.integration.test.ts` files (or the given paths) as root in a `node` container with the Docker socket, the three editor stand-in volumes and `SCANTOR_TEST_INTEGRATION=true` plus the connection variables; removes every object with that prefix afterwards (§4.2) |
| `just test-connectors [base]` | builds `--target test` of `connectors/<base>/Dockerfile` (all bases by default) and runs it with `--network none` |
| `just test-conformance [language]` | runs the conformance harness for one language (default: every row of `schemas/languages.json`) |
| `just test-e2e *args` | `just init` (so `.env` has the "Tests" variables), `docker buildx bake --load test-runner` (the runner image, [development](development.md) §10), then `docker compose -f docker-compose.tests.yml run --rm --name scantor-test-runner test-runner *args` (args go to `playwright test`) and `compose down` (the project network; the cache volumes stay); refuses to start while a runner exists |
| `just test-api *args` / `just test-ui *args` | `test-e2e --project=api *args` / `--project=ui` |
| `just test-up` | starts the runner in the background with `SCANTOR_TEST_KEEP_ALIVE=true` (Playwright only lists the suite, `--list`), follows its log and returns once the fresh stack is up (`/run/scantor-test/ready`); a no-op when a ready runner exists |
| `just test-exec *args` | runs `scantor-test-playwright *args` (`playwright test` with the stack's environment, reports handed to the host user) inside the kept-alive runner, without rebuilding or restarting the stack; each run `exec-<time>-<pid>` writes its traces to `test-results/<run>/` (unless `--output` is given), its HTML report to `playwright-report/<run>/` and `results.json` to `test-results/<run>/` (`PLAYWRIGHT_HTML_OUTPUT_DIR`, `PLAYWRIGHT_JSON_OUTPUT_FILE`), because Playwright empties its output directory when a run starts and replaces both reports when it ends, so concurrent runs would delete each other's traces and reports |
| `just test-down` | `docker stop` of the runner (its trap tears the inner stack down first, up to 5 minutes), then `compose down`; the cache volumes stay |
| `just test-index [--check]` | regenerates the generated part of `tests/TESTS.md` (or fails when it is stale) |
| `just test-clean` | `test-down`, then removes the runner's node_modules volume and the inner-Docker cache volume |

Examples: `just test-e2e --project=security`, `just test-ui ui/scans.spec.ts -g "pause"`,
`just test-e2e --grep @scaffold`.

Test-only environment variables (documented with defaults in `.env.example`, section "Tests"):
`SCANTOR_TEST_WORKERS`, `SCANTOR_TEST_KEEP_ALIVE`, `SCANTOR_TEST_SKIP_BUILD`, `SCANTOR_TEST_IMAGES_DIR`,
`SCANTOR_TEST_HOST_UID`, `SCANTOR_TEST_HOST_GID`, the gates of the orchestrator integration tests
`SCANTOR_TEST_INTEGRATION`, `SCANTOR_TEST_SCANTOR_IMAGE` and `SCANTOR_TEST_SCANTOR_BINARY` (§4.2), plus the
standard `CI`. `just test-e2e` exports the host
uid/gid from `id -u`/`id -g` (the shell wins over `.env` in compose interpolation) so reports are not
root-owned.

Workflow rule (from agentor): run the suite once, save the output, then re-run only the failing files with
`just test-exec <file>` against a stack started with `just test-up` (or `SCANTOR_TEST_KEEP_ALIVE=true just
test-e2e`, which keeps the stack after the suite); do not loop the whole suite. Re-runs of the `chaos`
project pass `--no-deps`, otherwise Playwright runs every other project first, and start only while no other
run uses the kept-alive stack: its cases stop, restart, pause and partition shared services (the orchestrator,
RabbitMQ, MongoDB, `remote-1`), which breaks concurrent tests. A full `just test-e2e` orders this through the
project dependencies (§7.5).

## 4. Unit tests

### 4.1 Go

- Table-driven tests next to the code (`_test.go`, same package). Test data in `testdata/` or in the
  shared `tests/corpora/` tables (read by relative path, for example `../../tests/corpora/dockerfile-policy`).
- Must-have unit suites:

| Package | Covers |
|---|---|
| `internal/taskpipe` | Dockerfile policy over the whole `tests/corpora/dockerfile-policy` corpus; forbidden `LABEL` keys (the managed key set of `schemas/managed-labels.json`); deterministic pack (same tree → same `packSha256`, `.dockerignore` semantics, hard excludes); structured errors `{phase, file, line, message}` |
| `internal/container` | `ManagedLabels` against `schemas/managed-labels.json` (every kind, including `network` and the helper label `scantor.op`); hardening profile |
| `internal/workspace` | extract/write-files path rules over `tests/corpora/tar-slip` and `tests/corpora/paths`; caps; snapshot never dereferences symlinks |
| `internal/templates/<name>` | every case of `schemas/templates/<name>.fixtures.json`; determinism (same resolved config → same stream and tail hash); estimate |
| `internal/runtime` | retry classification and backoff (jitter uniform in [delay/2, delay]), clock-offset-corrected delivery times, resume skip/verify (hash mismatch → "schedule() is not deterministic"), size limits, process-slot resizing; with a scripted fake connector and fake AMQP: outcome classification, recycling, termination of the process group, credit accounting ([protocol](protocol.md) §12) |
| `internal/api` | transport policy table (plaintext only to loopback, RFC 1918, CGNAT `100.64.0.0/10` and ULA `fc00::/7`, after resolving the host), `SCANTOR_CA_CERT` trust |
| `internal/redact` | redaction of headers, token shapes and URLs ([security](security.md) MC-10) |
| `internal/protocol` | codec round trips against `schemas/protocol/*.json` |
| `internal/manifest`, `internal/languages` | strict manifest schema (fallback defaults of [data model](data-model.md) §4.5.1); languages table loading |
| `internal/keys` | HKDF derivations against the shared vectors in `tests/corpora/keys-vectors.json`, read by relative path (the orchestrator's vitest suite checks the same file) |
| root package (`embed.go`) | non-empty embedded scaffold for every language in `languages.json` (guards the `go.mod.tmpl` rule) |
| `internal/cli` | output formats (`-o json`), exit codes 0/1/2/3, `localhost` → `host.docker.internal` rewrite when containerized; every command group against an `httptest` fake orchestrator (request shapes, waits, downloads) |
| `internal/node` | assignment validation ([nodes](nodes.md) §6.10), the container spec per DinD mode, reconcile and worker recognition ([security](security.md) LBL-5), the per-pull credential (MC-8), image GC, `egress-apply` backend detection (nft/legacy) with a fake command runner, and the daemon against a fake Docker engine and an `httptest` fake orchestrator |

- Integration tests (`//go:build integration`) need Docker and name what they create with the test flag
  `-name-prefix` (default `scantor-test-`):
  - `internal/container`: runtime injection (`CopyToContainer`), managed labels overriding the labels of a
    hostile image the test builds, the worker hardening profile, and extraction of the linux runtime
    binary from a local scantor image;
  - `internal/taskpipe`: `task build` of `tasks/echo` on the Python base image (real BuildKit build and
    check, describe and local run), inherited forbidden labels (LBL-3), ONBUILD images (BLD-7), the build
    timeout and image size cap, and the push gate against `registry:3.1.2`; the base image comes from
    `-base-image-prefix`/`-base-image-tag`, and `-runtime=auto|real|stub` selects the injected runtime;
  - `internal/conformance`: the conformance suite of every language, the examples described and run in
    local mode, local-mode outcomes (files, retries, timeouts, crash, limit, total timeout) and check
    mode (`-image-prefix`/`-image-tag` select the base images);
  - `internal/runtime/worker`: the runtime in the test process (not in a task container) against a
    throwaway `rabbitmq:4.4-management`, with the fake connector: results, delayed retries, consumer cancel, the
    `ACCESS_REFUSED` kill switch, and scheduler backpressure with real nacks;
  - `internal/node`: the worker lifecycle on the real engine (labels, HostConfig, live resize, crash
    backoff, log upload, adoption, recreation, removal; needs the containerd image store, otherwise it
    skips) and `egress-apply` applied inside a scratch container's network namespace, never on the
    host firewall.

  Tests skip with a reason when the images they need are not present locally.

### 4.2 Orchestrator (vitest)

Pure server, shared and UI-utility logic (UI behaviour is covered by Playwright; `test/ui/` covers only
pure `app/utils` code such as the status tables, JSON pointers and schema-subset detection;
`test/setup.ts` silences the loggers): query allowlist over
`tests/corpora/query-injection/cases.json`; placement (a pure function: filters, stable spread, scheduler
preference); `scanActions` and state-transition tables; masking of `writeOnly` paths (`*` wildcards);
pagination cursors; env parsing (durations, byte sizes, booleans, lists; invalid security-relevant values
abort); the startup guard's full truth table ([security](security.md) CFG-2); HKDF vectors; error envelope
mapping; CSV formula escaping; log redaction; `managedLabels()` against `schemas/managed-labels.json` (the
file Go reads too); the ingestor's document builder; the editor proxy (a fake upstream on a unix socket
receives no cookie or authorization header) and the editor container spec; the pipeline driver's build
timeout and image-size cap with a fake `scantor task build` subprocess; the git URL pre-check (private
hosts are rejected unless allowed, which the test stack does allow); the CIMD metadata fetch path with an
injected fetcher (the real SSRF-hardened fetcher refuses the test stack's private addresses).

Integration tests are `*.integration.test.ts` files next to the unit tests. They skip themselves unless
their gate holds, so `just test-orchestrator` (no Docker socket, non-root) runs only unit tests. `just
test-orchestrator-integration` satisfies every gate at once: one root container named
`scantor-test-orchestrator-it` on its own network, with the Docker socket, the editor stand-in volumes, the
connection variables of throwaway services, and `SCANTOR_TEST_SCANTOR_IMAGE=scantor:dev` with
`SCANTOR_TEST_SCANTOR_BINARY` naming that image's static binary (the recipe bakes `scantor` and copies the
binary into a volume mounted read-only). The recipe passes a fixed environment, so values in `.env` never
reach the tests; the variables matter only when vitest runs outside it:

| Harness | Tests | Gate and setup |
|---|---|---|
| connection variables | `scans/broker.integration.test.ts` (topology, broker-enforced permissions, lifecycle, retry-failed backpressure, stall detection, delete job, user purge), `ingestor/ingestor.integration.test.ts` (ingestor flow and identity, dead letters, isolation mode, queries on real MongoDB) | `SCANTOR_TEST_INTEGRATION=true` plus the usual `SCANTOR_MONGO_*`, `SCANTOR_AMQP_INTERNAL_URL`, `SCANTOR_RABBITMQ_*` and `SCANTOR_S3_*` variables pointing at throwaway MongoDB (replica set, `--noscripting`), RabbitMQ 4.4 and RustFS; each run creates and removes its own database, vhost or bucket |
| containerised (`test/services/nodes/integration.ts`) | `nodes/node-api.integration.test.ts`, `runtime/runtime-api.integration.test.ts`, `registry/registry.integration.test.ts` | Linux, inside a container on a user-defined network with the Docker socket mounted (for example `node:26.12.1-trixie-slim` with Linux `node_modules` in a volume; the exact command is in the harness header). Containers are named after the runner container and never pulled: `mongo:9.0.4`, `rustfs/rustfs:1.0.3`, `registry:3.1.2` must exist locally (the recipe pulls missing images first). The registry runs in the Docker host's network namespace with a loopback forwarder for the token realm, because Docker Desktop sends non-loopback realm requests through its HTTP proxy |
| real code-server | `editor/code-server.integration.test.ts` (hardened editor container, safe socket connect, `/_auth` handoff, HTTP and WebSocket relay, symlinked sockets refused, stop) | as root in a container with the Docker socket and three throwaway volumes at `/run/scantor/editor-sockets`, `/volumes/editor-home` and `/volumes/workspaces`; `codercom/code-server:4.141.0` present locally, never pulled (command in the file header) |
| scantor image or binary | `helpers/helpers.integration.test.ts` (workspace helper operations with the production container profile), `pipeline/task-build.integration.test.ts` (a draft `scantor task build`) | `SCANTOR_TEST_SCANTOR_IMAGE=<prefix>scantor:<tag>` (a prefix ends in `/`; the recipe uses `scantor:dev`), plus `SCANTOR_TEST_SCANTOR_BINARY` (a scantor binary for the platform the tests run on; the recipe copies the image's) for the build test; they create and remove their own volumes, networks and images (the build test builds a stand-in base image when `<prefix>scantor-base-python:<tag>` is missing) |

### 4.3 Connectors

Each `connectors/<base>/Dockerfile` has a `test` stage = the base image + pinned dev tools + the
connector's tests. `just test-connectors` builds and runs it with `--network none`:

| Base | Runner | Also runs |
|---|---|---|
| `python` | `pytest -q` (pytest ≥ 9.1, pytest-asyncio ≥ 1.4) | `ruff check`, `ruff format --check`, `basedpyright` over the connector and its typing tests |
| `js` | `node --test` (Node 26 native TS type stripping of `src/*.ts` through the export condition `scantor-source`) | `tsc --noEmit` (TypeScript ~6.0.3) over the connector and the checked-JS typing tests |
| `go` | `go test -race ./...` (pre-seeded `GOMODCACHE`, `GOFLAGS=-mod=mod`) | `go vet` |

The `python` and `js` test stages also copy the language's example tasks, scaffold and authoring guide
from the repository: they describe and run every example and rendered scaffold entry with the installed
connector against a schema-validating fake runtime, and check that the guide's
`<!-- scantor:include <path> -->` blocks equal the included files.

Typing tests are small task files that must type-check (and `// @ts-expect-error` / `# pyright: ignore`
negative cases that must fail), proving the typed definition APIs of [tasks](tasks.md).

## 5. Conformance harness

One Go harness (`internal/conformance`) verifies every connector against the connector protocol
([protocol](protocol.md)) with the same cases. It is exposed as the hidden command
`scantor conformance --language <language>`:

```
for each fixture task in internal/conformance/testdata/<language>/<fixture>/   (real task folders)
  scantor task build (no push) against the language's base image (reference rule of architecture §4.2)
  for each case that uses the fixture:
    create container (--network none, worker hardening), CopyToContainer the scantor binary,
    run `scantor conformance exec --case <case> --fixture <fixture> --entry <entry> --language <language>`
      inside: it spawns SCANTOR_CONNECTOR_CMD and drives fd 3/4
    compare the NDJSON transcript with the case's expectations
```

Fixtures, case ids (H1–P4) and expectations are specified in [protocol](protocol.md) §12; the case groups
below map onto them. Groups (each language provides the same set): `hello` (version negotiation N and N−1), `describe`
(schemas equal to the expected JSON, `writeOnly`, `x-scantor` annotations, input vs output mode, unknown
keys rejected), `echo` (run), `throws` (taskError, `Fatal`, `Retry` with delay in wire milliseconds),
`files` (`ctx.files.put` with bytes and path, nested and array FileRefs), `schedule-stream` (generator,
credit-based flow control), `template-proxy` (every template in `schemas/templates/` returns the canonical
schemas and streams the fixture output), `invalid-config` (validation error), `crash` (process exit),
`logs` (stdout/stderr never corrupt fd 4), `shutdown`. `just test-conformance` runs it for every row of
`schemas/languages.json` through the CLI image with the host Docker socket; CI uses the same recipe.

## 6. Scaffold matrix

For every language in `schemas/languages.json` × every template in `schemas/templates/` plus `custom`:

```
scantor init --language <l> --template <t> --name m-<l>-<t> <dir>   → files written, publishable as-is
scantor validate <dir>                                               → exit 0 (static, build, describe, check)
scantor dev run <dir> --limit 2 [--scan-config <json>] -o json       → exit 0, ≥ 1 succeeded analysis
```

- Runs as `e2e/scaffold-matrix.spec.ts` (tag `@scaffold`) inside the DinD runner, calling the CLI from the
  `scantor:dev` image through the shim pattern (no bind mounts for builds). One test per combination; the
  matrix is derived from the two files at runtime, so new languages and templates are covered without
  editing the spec.
- Data-source templates point at the fixtures server through `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL`
  in the CLI container's environment (local mode honours them; see §14 decision 4). Scan configs passed
  with `--scan-config`: `list` `{"items": ["a", "b", "c"]}` (local mode supports no uploads), `range`
  `{"end": 4}`, `repeat` `{"times": 2}`; `single`, `cidr` (TEST-NET-1 `/29`), `tranco` and `crux` use
  their defaults ([templates](templates.md) §9).
- The same spec asserts that each scaffold contains `.devcontainer/devcontainer.json`,
  `.vscode/{launch,tasks,settings}.json`, `.dockerignore`, `.gitignore`, `AGENTS.md` and a manifest that
  validates against `schemas/task-manifest.schema.json`.

## 7. Dockerized Playwright suite

### 7.1 Compose file

```yaml
name: scantor-tests

services:
  test-runner:
    image: scantor-test-runner:dev
    init: true
    privileged: true
    container_name: scantor-test-runner
    shm_size: 2gb
    stop_grace_period: 5m
    volumes:
      - test-runner-docker:/var/lib/docker
      - test-runner-node-modules:/work/tests/node_modules
      - ./:/src:ro
      - ./tests:/work/tests
      - ./orchestrator/shared:/work/orchestrator/shared:ro
    environment:
      - SCANTOR_TEST_WORKERS=${SCANTOR_TEST_WORKERS}
      - SCANTOR_TEST_KEEP_ALIVE=${SCANTOR_TEST_KEEP_ALIVE}
      - SCANTOR_TEST_SKIP_BUILD=${SCANTOR_TEST_SKIP_BUILD}
      - SCANTOR_TEST_IMAGES_DIR=${SCANTOR_TEST_IMAGES_DIR}
      - SCANTOR_TEST_HOST_UID=${SCANTOR_TEST_HOST_UID}
      - SCANTOR_TEST_HOST_GID=${SCANTOR_TEST_HOST_GID}
      - CI=${CI}

volumes:
  test-runner-docker:
    name: scantor-test-runner-docker
  test-runner-node-modules:
    name: scantor-test-runner-node-modules
```

- This file is the definition of `docker-compose.tests.yml` ([deployment](deployment.md) §6.3 defers to
  it). Like every compose file it has no defaults ([deployment](deployment.md) §2): values come from
  `.env`, which `just init` completes from the "Tests" section of `.env.example` (`CI` included); a value
  exported in the shell wins over `.env` (GitHub Actions sets `CI=true`).
- The service has no `build:`. The runner image is the bake target `test-runner`
  ([development](development.md) §10), which `just test-e2e` builds before `compose run`, so every image is
  defined only in `docker-bake.hcl` (§14 decision 8).
- No ports: the runner is fully isolated and can run next to a developer's `just up` stack.
- `/var/lib/docker` is a named volume (overlay2 needs a real filesystem; it doubles as the image and
  BuildKit cache across runs). `node_modules` lives in its own volume, never the host's; `npm ci` empties the
  mount point instead of removing it.
- `orchestrator/shared` is mounted next to `tests/`, so the `#shared` alias resolves at run time too: specs
  may import the enum and error-code lists of `#shared/utils/*`, not only types.
- `init: true` (tini as PID 1) forwards `docker stop` and Ctrl+C to the entrypoint, whose trap needs up to
  `stop_grace_period` to tear the inner stack down.

### 7.2 Runner image (`tests/docker/Dockerfile`)

`FROM mcr.microsoft.com/playwright:v1.64.1-noble` (the tag must equal the exact `@playwright/test`
version) plus Docker Engine 29.9.2 with the buildx and compose plugins from Docker's apt repository
(pinned), `dnsmasq`, `iptables`, `openssl`, `libnss3-tools`, `jq`, `curl`, `git`, `uidmap`, and the
`scantor` CLI built from the checkout in a `golang:1.27.3-trixie` stage (empty image prefix, so it refers
to the locally built images). Its build context is the repository root (as for every bake target),
filtered by `tests/docker/Dockerfile.dockerignore`, so the `COPY` paths are `tests/docker/daemon.json`,
`tests/docker/entrypoint.sh` (as `/usr/local/bin/scantor-test-entrypoint`), `tests/docker/playwright.sh`
(as `/usr/local/bin/scantor-test-playwright`), `tests/docker/stack.tests.yml`, `tests/docker/stack.env`,
`tests/docker/traefik/` and `tests/docker/join-remote-node.mjs` (the last four into `/opt/scantor-test/`).
`ENTRYPOINT ["/usr/local/bin/scantor-test-entrypoint"]`, `WORKDIR /work/tests`.

`daemon.json`: `{"storage-driver": "overlay2", "bip": "172.17.0.1/16", "default-address-pools": [{"base":
"10.10.0.0/16", "size": 24}], "dns": ["172.17.0.1"], "log-driver": "json-file", "log-opts": {"max-size":
"10m", "max-file": "3"}}`. The address pool keeps the inner networks clear of the subnet the runner itself
is attached to (the outer Docker allocates from 172.17–31 and 192.168).

### 7.3 Inner stack

```
 test-runner container (privileged, own netns, no published ports)
 ├── dnsmasq  127.0.0.1 + 172.17.0.1   *.scantor.localhost → 172.17.0.1 ; rest → outer Docker DNS
 ├── dockerd  (bip 172.17.0.1/16, pools 10.10.0.0/16, dns 172.17.0.1, data on scantor-test-runner-docker)
 │    └── compose project "scantor" = docker-compose.prod.yml + tests/docker/stack.tests.yml (profile traefik)
 │         traefik :443/:80 published on 0.0.0.0 of the runner ─┐  default cert = test CA wildcard
 │         orchestrator · mongo · rabbitmq · rustfs · registry · mongo-express · node (built-in, pool shared)
 │         fixtures   (tranco/crux on :8089 as fixtures.scantor.localhost; git behind Traefik as git.scantor.localhost)
 │         remote-node  docker:29.9-dind on its own network scantor-remote (own dockerd: bip 10.20.0.1/24,
 │                      pools 10.21.0.0/16, dns 172.17.0.1, trusts the test CA)       ┐ simulated remote node
 │              └── scantor-node  scantor:dev `scantor node`, started with createNode's   ┘ "remote-1", pool "remote"
 │                                join command (+ SCANTOR_CA_CERT); workers next to it
 │              workers on the remote dockerd reach the master only via https://*.scantor.localhost
 └── playwright (Node 24 from the image) → https://scantor.localhost (Chromium resolves *.localhost to 127.0.0.1)
```

- Hostnames: `SCANTOR_DOMAIN=scantor.localhost`; dashboard `https://scantor.localhost`, editor
  `https://editor.scantor.localhost`, S3 `https://s3.scantor.localhost`, registry
  `registry.scantor.localhost`, AMQPS through Traefik HostSNI ([deployment](deployment.md)). Every
  `*.scantor.localhost` name resolves to `172.17.0.1` (the runner's docker0 address) for the runner's
  processes and for every inner container, because the inner dockerd and its embedded DNS forward to
  dnsmasq on that address; Traefik publishes `443`/`80` on `0.0.0.0` of the runner
  (`SCANTOR_TRAEFIK_BIND_ADDRESS=0.0.0.0`), so the same URL works from the browser, from Node, from master
  workers and from workers inside the remote node's own dockerd. The inner dockerd itself resolves the
  registry token realm (`SCANTOR_PUBLIC_URL`) the same way, which exercises the hairpin requirement of
  [deployment](deployment.md) §15 for every push and pull. Every other host port keeps the shipped
  loopback `SCANTOR_BIND_ADDRESS`/`SCANTOR_ADMIN_BIND_ADDRESS` ([security](security.md) CFG-3, BLD-11): the
  inner dockerd still pushes to and pulls from the registry over loopback, and every other client goes
  through Traefik.
- TLS: the entrypoint creates a throwaway CA and a wildcard certificate for `scantor.localhost` and
  `*.scantor.localhost` in `/run/scantor-test/traefik/dynamic/`, next to `tls.yml` (copied from
  `tests/docker/traefik/tls.yml`, a `tls.stores.default.defaultCertificate` entry). The production
  compose file mounts `./traefik/dynamic` at `/etc/traefik/dynamic` for Traefik's file provider
  (`--providers.file.directory=/etc/traefik/dynamic`, empty in production, [deployment](deployment.md));
  the stack's project directory (below) makes that mount resolve to the test directory, so Traefik serves
  the test certificate as its default without any override. The CA is trusted by the runner's system store
  (`update-ca-certificates`, used by curl and the inner dockerd for registry and realm requests), by Node
  (`NODE_EXTRA_CA_CERTS`), by Chromium (imported into the NSS database with `certutil`), by the remote
  node's dockerd, and by nodes and workers through `SCANTOR_CA_CERT`. No TLS verification is disabled
  anywhere; `ignoreHTTPSErrors` is off.
- The inner stack is the real `docker-compose.prod.yml` with `SCANTOR_IMAGE_PREFIX=` (empty, honoured by
  its `${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}` references) and `SCANTOR_IMAGE_TAG=dev` (both from
  `stack.env`, below), started with `--pull never` after the absent third-party images were pulled
  (§7.4 phase 8), so the production compose file is tested. Its project directory is
  `/run/scantor-test` (`--project-directory`), so the compose file's relative paths (`env_file: .env`,
  `./traefik/dynamic`) resolve to the generated test files and never to the developer's `/src/.env`.
  `stack.tests.yml` only adds the fixtures server and the remote node and uses no relative paths (the
  remote node mounts the CA from its absolute runner path). `stack.env` holds non-secret settings chosen for
  speed and determinism; every key must exist in `.env.example` (the entrypoint and `lint-env.mjs` check it):

| Setting | Test value | Why |
|---|---|---|
| `COMPOSE_PROFILES` | `traefik` | the production Traefik mode (also seen by the startup guard) |
| `SCANTOR_IMAGE_PREFIX` | empty | locally built images: honoured by the compose file's `${SCANTOR_IMAGE_PREFIX-…}` references and by the orchestrator's image references ([architecture](architecture.md) §4.2) |
| `SCANTOR_IMAGE_TAG` | `dev` | the `:dev` images built or loaded in phase 6 |
| `SCANTOR_DOMAIN` and the URL set of [deployment](deployment.md) §7.7 | `scantor.localhost`; `SCANTOR_PUBLIC_URL` / `SCANTOR_EDITOR_URL` = `https://scantor.localhost` / `https://editor.scantor.localhost`, S3 `https://s3.scantor.localhost`, AMQP `amqps://amqp.scantor.localhost:443`, registry `registry.scantor.localhost`, RustFS console `https://rustfs.scantor.localhost`; `SCANTOR_TRAEFIK_CERT_RESOLVER` empty | one HTTPS origin (passkeys need it), the public endpoint profile for the remote node |
| `SCANTOR_TRUST_PROXY` | `true` | as in production behind Traefik |
| `SCANTOR_TRAEFIK_BIND_ADDRESS` | `0.0.0.0` | Traefik reachable at 127.0.0.1 and the docker0 address inside the runner (`SCANTOR_BIND_ADDRESS` keeps its loopback value) |
| `SCANTOR_ADMIN_EMAIL` | `admin@scantor.test` (password random, generated by the entrypoint) | headless first admin |
| `SCANTOR_TRANCO_URL` / `SCANTOR_CRUX_URL` | `http://fixtures.scantor.localhost:8089/tranco` / `…/crux` | no internet data sources |
| `SCANTOR_GIT_ALLOW_PRIVATE` | `true` | git import from the fixtures server |
| `SCANTOR_AUTH_RATE_LIMIT_SCALE` | `10000` | the whole suite signs in from one IP, and better-auth's per-IP limiter is a fixed window that resets only after a quiet minute, so under continuous sign-ins any finite budget eventually answers 429; `security/rate-limits.spec.ts` checks the real limits on a throwaway orchestrator (scale 1) |
| `SCANTOR_NODE_OFFLINE_AFTER` | `20s` | partition chaos case finishes quickly |
| `SCANTOR_SCAN_QUEUE_MAX_READY` | `500` | every scan exercises scheduler backpressure |
| `SCANTOR_SCAN_CONFIRM_THRESHOLD` | `1000` | confirmation flow testable with small scans |
| `SCANTOR_BREAKER_MIN_ATTEMPTS` | `20` | breaker trips within a small scan |
| `SCANTOR_SCAN_STALL_AFTER` | `30s` | stall detection testable |
| `SCANTOR_USER_STORAGE_QUOTA_BYTES` | `512MiB` | the storage quota is testable with one large file (at most `SCANTOR_MAX_FILE_BYTES`); every tenant has it, and no other spec stores more than a few KiB of files |
| `SCANTOR_BUILTIN_NODE_MAX_WORKERS` | `16` | parallel e2e scans fit on the built-in node (the prod compose file maps it onto the daemon's `SCANTOR_NODE_MAX_WORKERS`, [deployment](deployment.md) §4.2) |
| `SCANTOR_EDITOR_IDLE_TIMEOUT` | `3m` | idle stop testable |
| `SCANTOR_NODE_MIN_FREE_DISK` | `1GiB` | placement keeps working on a small CI disk or a nearly full laptop |

- The remote node is a single `docker:29.9-dind` container on its own network `scantor-remote`: the node
  daemon runs **inside** it, started by `join-remote-node.mjs` with the exact `dockerRun` command of
  `createNode` plus `-e SCANTOR_CA_CERT`. A daemon outside the DinD with `DOCKER_HOST` pointing at it would
  fail its self-inspection ([nodes](nodes.md) §2), which disables the egress helper. The DinD's own dockerd
  uses `--dns 172.17.0.1` (containers of a DinD on a user-defined network cannot use the embedded DNS) and
  address ranges that cannot collide with the runner's, appends the test CA to its system bundle (the
  token realm) and to `/etc/docker/certs.d/<registry host>/ca.crt`, and keeps everything in the volume
  `scantor-remote-node-docker`, which `compose down -v` removes. Partition tests disconnect the container
  from `scantor-remote`.

### 7.4 Entrypoint phases (`tests/docker/entrypoint.sh`)

`#!/usr/bin/env bash`, `set -euo pipefail`, helpers `log`/`err`. The cleanup function runs from a
`trap … EXIT` installed **first** (INT and TERM exit with 130/143 and so run it), so Ctrl+C, `docker stop`,
failures and normal exits all tear down. Playwright and the keep-alive wait run in the background with
`wait`, so a signal reaches the trap at once.

| Phase | Action | Failure handling |
|---|---|---|
| 0. trap | `trap cleanup EXIT`; `cleanup` = phase 9 | – |
| 1. cgroup v2 nesting | move processes into `/sys/fs/cgroup/init`, enable all controllers in `cgroup.subtree_control` (official dind trick, retried) | warn and continue |
| 1a. IPv6 on new interfaces | `net.ipv6.conf.default.disable_ipv6=1` (only when the kernel has IPv6): the bridges and veths the inner dockerd adds to the runner's network namespace get no link-local addresses, whose appearance Chromium reports as `net::ERR_NETWORK_CHANGED` (§9); `lo` and `eth0` keep their settings, inner containers have network namespaces of their own | warn and continue |
| 2. DNS | save upstream nameservers to `/etc/resolv.conf.upstream`; dnsmasq with `listen-address=127.0.0.1,172.17.0.1`, `bind-dynamic`, `address=/scantor.localhost/172.17.0.1`, `resolv-file=/etc/resolv.conf.upstream` (never together with `no-resolv`), `filter-AAAA`, `no-poll`; point `/etc/resolv.conf` at 127.0.0.1; verify `getent hosts scantor.localhost` and an upstream name | exit 1 |
| 3. CA and certificates | create the throwaway CA (P-256, 30 days) and the wildcard certificate in `/run/scantor-test/ca/` and `/run/scantor-test/traefik/dynamic/` (with `tls.yml`); install trust: system store (`update-ca-certificates`), NSS (`certutil`, Chromium), Node (`NODE_EXTRA_CA_CERTS`). Before dockerd, because Go loads the system roots once per process and the inner dockerd needs the CA for the registry token realm | exit 1 |
| 4. dockerd | remove stale pid/socket files; start `dockerd` with `daemon.json`; wait ≤ 30 s for `docker info` | exit 1 with the dockerd log tail |
| 5. stale state | run the stack removal of phase 9 once (an aborted run's stack would otherwise restart from the cache volume with `restart: unless-stopped`); never `docker network prune`/`volume prune` (breaks BuildKit) | log and continue |
| 6. images | `SCANTOR_TEST_IMAGES_DIR` set → `docker load` every `*.tar`; `SCANTOR_TEST_SKIP_BUILD=true` → use the images in the cache volume; otherwise `docker buildx bake --load test` from `/src` (`IMAGE_PREFIX=`, `IMAGE_TAG=dev`, `VERSION=dev`, `COMMIT` from git), retried 4× (cold pulls in DinD hit TLS timeouts). Then every tag of `bake --print test` must exist | exit 1 |
| 7. the stack's `.env` | write `/run/scantor-test/.env`: `/src/.env.example`, overridden by `stack.env` (so compose interpolation and the orchestrator's `env_file` see the empty `SCANTOR_IMAGE_PREFIX` and `SCANTOR_IMAGE_TAG=dev`, never the shipped GHCR values), with every other `-insecure-dev` value replaced by 48 random hex characters (the `just init` merge of [deployment](deployment.md) §8.3), a random `SCANTOR_ADMIN_PASSWORD` and the CA PEM as `SCANTOR_CA_CERT` (double-quoted, `\n`-escaped); a `stack.env` key missing from `.env.example` fails | exit 1 |
| 8. stack | pull every image that `compose config --images` names and that is absent locally, with `docker pull` retried 4× like the build; after phase 6 only the pinned third-party images (including the remote node's `docker:29.9-dind`) can be absent (once per cache volume locally, on every CI run). Then `docker compose -p scantor --project-directory /run/scantor-test -f /src/docker-compose.prod.yml -f /opt/scantor-test/stack.tests.yml up -d --pull never` (profiles from `COMPOSE_PROFILES` in the project `.env`) | exit 1 |
| 8a. wait | poll `https://scantor.localhost/api/health` until `status: ok` and every component `ok` (≤ 300 s) | dump `compose ps` and `compose logs --tail 200`, exit 1 |
| 8b. remote node | `node join-remote-node.mjs`: sign in as the seeded admin (one sign-in), `createNode {name: "remote-1", pool: "remote", labels: {zone: "remote"}}`, `docker save scantor:dev \| docker exec -i scantor-remote-node docker load`, run the `dockerRun` of the response inside the remote node with `-e SCANTOR_CA_CERT`, wait ≤ 120 s until the node is `online`, write `{id, name, pool, labels, token}` to `/run/scantor-test/remote-node.json` (0600) | the node daemon's log tail, exit 1 |
| 8c. playwright | `npm ci` into the node_modules volume when `package-lock.json` changed (stamp `node_modules/.scantor-package-lock.json`); remove `tests/.auth`; write `SCANTOR_PUBLIC_URL`, `SCANTOR_EDITOR_URL`, `SCANTOR_ADMIN_EMAIL`, `SCANTOR_ADMIN_PASSWORD`, `SCANTOR_SECRET`, `SCANTOR_AUTH_RATE_LIMIT_SCALE`, `NODE_EXTRA_CA_CERTS`, `SCANTOR_TEST_WORKERS`, the host uid/gid and `CI` to `/etc/profile.d/scantor-test.sh`; run `scantor-test-playwright "$@"` (`tests/docker/playwright.sh`: sources that file, runs `npx playwright test` in `/work/tests`, hands `playwright-report/`, `test-results/` and `.auth/` to `SCANTOR_TEST_HOST_UID:GID`); keep its exit code | – |
| 8d. keep alive | `SCANTOR_TEST_KEEP_ALIVE=true` → touch `/run/scantor-test/ready`, print how to use `just test-exec` and `just test-down`, and block until interrupted | – |
| 9. cleanup | `compose down -v --remove-orphans` (same project flags as phase 8, when the `.env` exists); remove every container with label `scantor.managed=true`, `scantor.test=true` or `com.docker.compose.project=scantor` (workers, helpers, editors, test-run and build containers, test-created orchestrators); remove app-created networks (`scantor-egress`, label `scantor.kind=network`) and the project's networks; remove the project's volumes and the boot-created volumes `scantor-workspaces` and `scantor-editor-home`; remove task and draft images (`*/tasks/*`) and images labelled `scantor.test=true`; keep platform images and build cache; stop dockerd cleanly (the cache volume stays consistent); hand the reports to the host user; exit with the Playwright exit code (or the failing phase's) | best effort, logs every failure |

### 7.5 Playwright configuration

```ts
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: env.ci,
  retries: env.ci ? 1 : 0,
  failOnFlakyTests: env.ci,                    // a retry gives a second trace, but flakiness still fails CI
  workers: env.testWorkers,                    // SCANTOR_TEST_WORKERS; helpers/env.ts fails when it is unset
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Origin: env.publicUrl },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // on CI only the retry is recorded: encoding a 1080p video of every test starves a 2-CPU runner (§12)
    video: { mode: env.ci ? 'on-first-retry' : 'retain-on-failure', size: { width: 1920, height: 1080 } },
  },
  projects: [
    { name: 'api', testMatch: 'api/**/*.spec.ts' },
    { name: 'authz-setup', testMatch: 'authz/seed.setup.ts', teardown: 'authz-teardown' },
    { name: 'authz-teardown', testMatch: 'authz/seed.teardown.ts' },
    { name: 'authz', testMatch: 'authz/**/*.spec.ts', dependencies: ['authz-setup'] },
    { name: 'security', testMatch: 'security/**/*.spec.ts' },
    { name: 'mcp', testMatch: 'mcp/**/*.spec.ts', timeout: 300_000 },
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts', timeout: 600_000 },
    { name: 'ui', testMatch: 'ui/**/*.spec.ts',             // the browser sends its own Origin: a forced one
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, extraHTTPHeaders: {} } },
    { name: 'chaos', testMatch: 'chaos/**/*.spec.ts', timeout: 900_000, fullyParallel: false,
      dependencies: ['api', 'authz', 'security', 'mcp', 'e2e', 'ui'] },
  ],
})
```

`chaos` starts only after every other project has finished, and its single spec file is serial, so
fault injection never disturbs other tests. The `ui` project drops the `Origin` header the other projects
send: Playwright would add it to every browser request, including the editor's WebSocket upgrade, whose
origin check would then fail. The `authz` seed runs once as a setup project, so the matrix's
generated tests can run in parallel on every worker.

### 7.6 Global setup

Fails loudly (every error is thrown; nothing is swallowed):

1. Read the environment (`helpers/env.ts` is the only place reading `process.env` in tests) and check
   `helpers/keys.ts` against `corpora/keys-vectors.json`.
2. Poll `GET /api/health` (≤ 120 s) until `status: ok`.
3. Remove stale limiter lock files (`.auth/limiter/`, §9); the timestamp logs stay, so back-to-back `just
   test-exec` runs share the sign-in budget. Sign in as `SCANTOR_ADMIN_EMAIL`/`SCANTOR_ADMIN_PASSWORD`
   through `POST /api/auth/sign-in/email` with an API request context (one limiter slot); save
   `.auth/admin.json` (storage state). Browser pages reuse storage states (same origin, cookie only), so no
   UI login happens in setup.
4. Fetch `/api/docs/openapi.json` and save it to `.auth/openapi.json` (used by the generic client and the
   authz matrix).
5. Verify the built-in node (`builtin`) and `remote-1` are `online` (`listNodes`).

### 7.7 Fixtures (`fixtures.ts`)

Specs import `test` and `expect` only from `fixtures.ts`. Worker-scoped fixtures are created once per
Playwright worker; test-scoped ones per test and torn down even when the test fails. Teardown errors fail
the test (404 counts as success).

| Fixture | Scope | Provides | Teardown |
|---|---|---|---|
| `env` | worker | URLs, admin credentials, secret, paths | – |
| `openapi` | worker | parsed OpenAPI document, operation index by `operationId` | – |
| `adminApi` | worker | `ApiClient` as the seeded admin (session from global setup) | dispose |
| `role` | option | `'user'` (default) or `'admin'` for `page`/`api`/`mcp` | – |
| `pageUser`, `mcpScopes` | option | `page` as the tenant (default) or as `freshUser` (`'fresh'`); the scopes `mcp` requests (default `offline_access scantor:read scantor:write`) | – |
| `user` | worker | the worker's **tenant** (`Tenant`: `id`, `email`, `name`, `password`, `role`, `storageState`, `apiKey`): a user created by admin (`createUser`, unique email `w<workerIndex>-<unique>@scantor.test`, random password), signed in once through the limiter (storage state `.auth/user-<workerIndex>-<pid>.json`: concurrent `just test-exec` runs share worker indexes), plus one `default` API key created with that session | `deleteUser` (202, `userPurge` job) at worker teardown |
| `api` | test | `ApiClient` with the tenant's session (admin's when `role: 'admin'`) | dispose |
| `apiKeyApi` | test | `ApiClient` with the tenant's API key (`Authorization: Bearer sk_scantor_…`) | dispose |
| `otherUser`, `otherApi` | worker (lazy) | a second tenant for cross-user checks | `deleteUser` |
| `freshUser`, `freshApi` | test (lazy) | a dedicated user and session for tests that change account-level state: password, passkeys, sessions, API key or OAuth app revocation, ban, role and limits, the editor | `deleteUser` |
| `anonApi` | test | `ApiClient` without credentials | dispose |
| `page` | test | browser page with the tenant's storage state (admin's when `role: 'admin'`, `freshUser`'s with option `pageUser: 'fresh'`) | Playwright |
| `oauthClient` | worker (lazy) | the worker's OAuth client, registered once through dynamic client registration and the limiter | – |
| `mcp` | test (lazy) | `McpConnection` (`client`, `provider`, `accessToken`) through the real OAuth flow as the tenant (admin with `role: 'admin'`), with `oauthClient` (`helpers/mcp.ts`); option `mcpScopes` | close |
| `mcpKey` | test (lazy) | MCP client authenticated with the tenant's API key ([mcp](mcp.md) §3.7) | close |
| `webauthn` | test (lazy) | CDP virtual authenticator on `page` (`ctap2`, resident key, user verification) | remove authenticator |
| `docker` | worker | inner-Docker helper (`helpers/docker.ts`): `inspect`, `exec`, `kill`, `restart`, `pause`/`unpause`, `networkDisconnect/Connect`, `logs`, `containersByLabel`, `remote` (`docker` in the remote node), `mongosh` (read-only as `scantor_query`, or root), `mongoCount`, `rabbitmqQueues` | – |
| `tasks` | test | `tasks.upload(dir, {name?, expectState?})` (packs a folder with a unique manifest name, `uploadTask?wait=120`, waits for the build, expects `ready` unless `expectState`), `tasks.fixture(name)`, `tasks.example(dir)`, `tasks.track(name)` for tasks created another way (CLI, MCP, git import) | `deleteTask` for every task it created or tracks (retrying `taskInUse` while a scan is still being deleted) |
| `scans` | test | `scans.start(body)` (small settings unless the body sets them), `scans.wait(id, {state, timeoutMs})`, `scans.counts(id)`, `scans.track(id)` | `cancelScan` when not terminal, then `deleteScan` and its job, for every scan it started or tracks (depends on `tasks`, so it runs before the `tasks` teardown) |

Tenants are per worker because better-auth limits sign-ins per client IP and the whole suite shares one
IP (§9). Unique names (`unique()`) keep tests of the same tenant apart; the `tasks` and `scans` fixtures
delete what they created, and `deleteUser` at worker teardown removes everything else of the tenant
(scans, tasks, revisions, files, keys, [data model](data-model.md) §5). Task names that a test cannot
choose (git imports of the fixture repositories, `git-*`) repeat within a worker: such tests use
`freshUser` or wait for the deletion of the previous task.

### 7.8 Helpers

| Helper | Contract |
|---|---|
| `helpers/env.ts` | `env` (`TestEnv`: `publicUrl`, `editorUrl`, `domain`, `mcpUrl`, `admin`, `secret`, `testWorkers`, `authRateLimitScale`, `ci`, `caCertFile`, `paths` of the tests, the repository (`/src` in the runner), the stack files (`/run/scantor-test`), `.auth/`); `workerIndex()`; `childEnv(extra, {inherit})` for child processes. The only module reading `process.env`; a missing variable throws |
| `helpers/limiter.ts` | `reserve(path)`: a cross-worker sliding-window limiter (a lock file plus a timestamp log per path under `.auth/limiter/`) that blocks until a slot is free; at most 8 per rolling 60 s for `/sign-in/email` and for `/oauth2/register`, 16 for `/passkey/verify-authentication` (below the limits of [auth](auth.md) §2.7, with a margin for window-boundary effects and the runner's own sign-in), each multiplied by the stack's `SCANTOR_AUTH_RATE_LIMIT_SCALE`; `resetLocks()` |
| `helpers/unique.ts` | `unique(prefix)`: `${prefix}-${workerIndex}-${Date.now().toString(36)}-${rand4}`, lowercase slug ≤ 64 (also exported by `fixtures.ts`) |
| `helpers/openapi.ts` | `OpenApiIndex`: operations by `operationId` (method, path template, parameters, request body, responses, `x-*` extensions) and `validateResponse(operationId, status, body)` (ajv 2020-12, OpenAPI 3.0-style `nullable` converted to type arrays, formats not asserted) |
| `helpers/api-client.ts` | `ApiClient(request, openapi)`: generic `call(operationId, {path, query, body, headers, maxRedirects (0), validate})` resolved through the OpenAPI index returning `{status, headers, body, raw}` (body `{}` when not JSON; a Buffer body is sent as is); never throws on a status: `ok(response)` returns the body of a 2xx or throws `ApiError`; thin typed wrappers for frequent operations using type-only imports from `#shared/types`; 2xx JSON bodies are validated against the operation's response schema, so documentation drift fails tests |
| `helpers/users.ts` | `newApiContext({storageState, headers})` (public origin, `Origin` header, a 150 s request timeout, because `wait` long-polls and slow jobs outlive Playwright's 30 s default), `createUser(adminApi, {prefix, role, …})`, `deleteUser`, `signIn(context, email, password)` (returns the response, also for wrong passwords), `signedInContext(email, password)`, `browserSignIn(page, user, redirect?)`; every sign-in first calls `reserve('/sign-in/email')` |
| `helpers/webauthn.ts` | `installVirtualAuthenticator(page)` → `{listCredentials, setUserVerified, dispose}`; passkey sign-ins reserve `/passkey/verify-authentication` |
| `helpers/mcp.ts` | `TestOAuthProvider`, `registerClient(context)` (DCR, reserves `/oauth2/register`), `approveAuthorization(session, url, {accept, scope})` (the consent page's `POST /api/auth/oauth2/consent` with the signed query and the scope), `connectMcp(session, {scopes, consentScope, client?})` (401 challenge → discovery → the given client, else one registration → consent → token → connect), `connectMcpWithKey(key)`, `callJson`, `callError`, `resultText`; redirect URI `http://127.0.0.1:53682/callback` (nothing listens; the code is read from the redirect) |
| `helpers/tasks.ts` | `packTask(dir, {name})` (deterministic tar.gz, manifest `name` rewritten with `yaml`), `copyTask(dir, name)` (a renamed copy for the CLI; `removeDir`), `uploadAndPublish`, `publishAndWait`, `waitForRevision`, `deleteTask`, `fixtureTaskDir(name)`, `exampleTaskDir(name)` |
| `helpers/scans.ts` | `SMALL_SETTINGS` (1 runner × 1 process, 0.25 CPU, 256 MiB), `startScan`, `waitForScanState(api, id, states, timeoutMs)` (long-polls `getScan?wait=50`; throws with the scan's `state`, `stateReason`, `conditions`, scheduling, progress and workers when it settles in another terminal state or times out), `startScanAndWait`, `scanCounts` (`aggregateAnalyses [{$group: {_id: "$status", n: {$sum: 1}}}]`, exact, never the `stats` hints), `cancelAndDeleteScan` |
| `helpers/docker.ts` | `docker(args)` through `execFile` only (never a shell string), `innerDocker` (the `docker` fixture), `CONTAINERS` (the stack's container names), `REMOTE_NODE_NETWORK`, `stackEnv()` (the stack's generated `.env`) |
| `helpers/amqp.ts` | `connectAsScan(scanId)` (user `scan-<scanId>`, password via `helpers/keys.ts`), `connectAsAdmin()`, `connectAs(user, password)` over `amqps://amqp.<domain>:443/scantor` (Traefik, the test CA); `publish(session, exchange, routingKey, body, properties)` on a confirm channel (`user_id` defaults to the session's user), for security and chaos cases |
| `helpers/keys.ts` | `Keys`/`stackKeys()`: HKDF derivations of [architecture](architecture.md) §9 from the stack's `SCANTOR_SECRET` for white-box tests (`amqpPassword`, `registryPushPassword`, `workerToken` with the worker documents from `listScanWorkers`, `mongoQueryPassword`, `builtinNodeToken`, `toolsCookie`, `editorCookie`); `verifyVectors()` checks them against `corpora/keys-vectors.json` (global setup) |
| `helpers/tar.ts` | `loadTarCorpus()`, `buildCaseArchive(case)`, `buildTarGz(entries)`: hostile archives (traversal, absolute, symlink, hardlink, device, FIFO, backslash, too many files, gzip bomb, PAX records) from `corpora/tar-slip/cases.json`; zip cases and `nameBase64` names are refused (the Go and vitest suites cover them) |
| `helpers/ui.ts` | `gotoWithRetry` (retries only on `net::ERR_NETWORK_CHANGED`), `expectToast(page, text)` (an open item of the "Notifications" region), `openTab(page, name)` |
| `helpers/cli.ts` | `scantor(args, {token, cwd, env, image, input})`: the runner's own `scantor` binary (built from the checkout into the runner image) against the stack and the inner dockerd, or with `image: true` the `scantor:dev` image through the shim pattern (working directory mounted at the same path, the inner Docker socket); always with `SCANTOR_URL`, the empty image prefix and tag `dev`, the test CA and the fixture data sources (`FIXTURE_DATA_SOURCES`); returns `{exitCode, stdout, stderr, json}` (`json` = parsed JSON or NDJSON output) |
| `helpers/fixtures-server.ts` | `FIXTURES_URL`, `GIT_URL`, `GIT_REPOS` (`single`, `multi`, `private`, `diverge`), `PRIVATE_GIT_CREDENTIAL`, `copyGitRepo(request, from)` and `moveGitMain(request, url, branch)` for per-test pull scenarios (§7.9), `fixturesRequests(since)` (the server's request log since a time, through `docker logs --since`) |
| `helpers/debug.ts` | (added with `e2e/debug.spec.ts`) minimal attach clients that resume a debuggee waiting for its debugger: DAP for debugpy (`initialize`, `attach`, `configurationDone`), the Chrome DevTools protocol for Node (`Runtime.runIfWaitingForDebugger`), delve's JSON-RPC API v2 (`RPCServer.Command {name: "continue"}`) |

### 7.9 Fixture tasks and fixtures server

- `tests/fixtures/tasks/` (Python; small and fast to build; each has a `.dockerignore`): `schema-zoo` (one
  task-config field per construct of the supported JSON Schema subset ([tasks](tasks.md) §6.4): bounded
  strings and numbers, enum, nullable, array with `uniqueItems`, map, nested object, a discriminated union,
  a `SecretStr` (`writeOnly`) and an upload field; the result echoes the config with the secret's SHA-256
  and carries a FileRef; TypeScript and Go variants to compare describe output are still to be added),
  `netprobe` (TCP connect attempts to the `host:port` targets of its task config, returns reachability; mode
  `env` returns the names of its environment variables), `nondeterministic` (custom schedule yielding random
  items slowly), `big-result` (exceeds `SCANTOR_MAX_RESULT_BYTES`), `crashy` (modes `exit` (code 3),
  `memory` (allocates beyond its limit), `hang` (past the timeout), `ok`), `no-hello` (an `ENV
  SCANTOR_CONNECTOR_CMD` whose process never sends `hello`: the revision fails at describe), `hostile-label`
  (Dockerfile with forbidden `LABEL`s, literal and ARG-expanded: the revision fails at static), `hostile-output`
  (results, logs and an error with HTML/script strings, ANSI sequences and a `javascript:` link; files
  `x.html`, `x.svg`, `x.png` and a name with CR/LF and quotes).
- Fixtures server (`tests/docker/fixtures/`, image `scantor-test-fixtures:dev`, a Go program on Alpine with
  git): one plain-HTTP port 8089, published on the runner (`http://fixtures.scantor.localhost:8089`) and
  routed by Traefik as `https://git.scantor.localhost` (the test CA's certificate):
  - `/tranco` and `/crux`: the fakes of `internal/templates/templatestest` (`NewHandler(DefaultDataSet(now))`),
    exactly the upstream endpoints of [templates](templates.md) §9.5–§9.6 with small deterministic lists
    relative to the server's start (`/api/lists/date/latest`, `/daily_list_id`, `/api/lists/id/<id>`,
    `/download/<id>/<n>` with CRLF CSVs; `data/global/<YYYYMM>.csv.gz`, `data/country/<cc>/<YYYYMM>.csv.gz`,
    `HEAD` probes), plus `GET /healthz`;
  - `/<name>.git/…`: read-only git smart-HTTP (`git http-backend` through Go's CGI handler; uploads only)
    over bare repositories built at image build time (`build-repos.sh`, fixed authors and dates): `single`
    (one task, `git-single`), `multi` (`alpha/` and `beta/`: candidate selection), `private` (Basic auth
    `scantor-test` / `fixtures-token`, a git credential's username and token) and `diverge` (`main`, a
    fast-forward branch `advanced` and an unrelated history `rewritten`);
  - `POST /control/repos {"from": "<name>"}` → 201 `{"name"}` copies a repository for one test (copies of
    `private` stay private); `POST /control/repos/<name>/main {"branch"}` → 204 points its `main` at a branch,
    so pull tests (fast-forward, `gitDiverged`) never share state.
  - every request is logged to stdout as one JSON line (`method`, `host`, `path` without the query, `status`,
    `userAgent`, `ms`), so specs can assert what schedulers and test runs fetched and with which User-Agent
    (TPL-008).

## 8. Suites

Every test carries the FEATURES.md ids it covers as tags (`{ tag: ['@SCAN-012'] }`, §10).

### 8.1 API (`api/`)

One spec per tag of [api](api.md) §4: `health`, `info`, `account`, `api-keys`, `users`, `credentials`,
`tasks`, `task-files`, `git` (import with candidates, private repository with a credential, pull with
divergence; URLs with userinfo, `ext::`, `file://` or a leading `-` rejected, redirects not followed, the
imported folder contains no `.git` and no token, error messages redacted; the private-host rule is a
vitest case because the test stack sets `SCANTOR_GIT_ALLOW_PRIVATE=true`), `uploads`, `revisions`,
`test-runs`, `catalog`, `scans` (every lifecycle
transition, idempotent repeats return 200, forbidden ones 409 `invalidState` with `allowed`; retry-failed
only with `scheduling.state` `done`/`failed` and no active retry, `409 nothingToRetry`), `analyses`
(list, `afterSeq`, `fields`, query, aggregate), `exports` (JSONL/CSV, formula escaping, presigned download
headers), `files`, `jobs`, `nodes` (create, rotate, revoke, built-in node 409 `builtInNode`), `metrics`,
`editor` (session URL, start and stop, `editor` key on `createEditorSession` → 403), `tools`
(`createToolsSession` 302 with the cookie; through the tool hosts, a missing, expired (minted with
`helpers/keys.ts`) or non-admin cookie, a user banned within 30 s, or a call through a non-tool host →
401, and a browser request (`Accept: text/html`) without a valid cookie → 302 to
`/api/tools/session?target=<target>`; a valid admin cookie → 200), `wait` (every `wait` operation,
`Scantor-Wait` header, the per-user cap → 429), `errors` (envelope, `X-Request-Id`, 413, 415, unknown keys
→ `validationFailed`, deny-by-default 404/405, the dashboard listener answers 421 for the editor host),
plus the machine APIs: `node-api` (hello, instance lease with same-engine takeover and conflict 409,
version window 426, assignments long-poll returns early on a new rev, status and logs for workers of
another node ignored, wrong-prefix credentials 401; the 426 case skips itself on the test stack, whose
non-release version `dev` has no version window, and `orchestrator/test/utils/version.test.ts` covers the
window), `runtime-api` (bootstrap shape per role, runner
forbidden on scheduler routes, stale epoch 409, token of a stopped worker 401, presign keeps path-like
names inside the scan prefix and a larger PUT than signed fails) and `registry-token` (GET and POST flows,
scopes intersected, a token for node N1 omits a repository assigned only to N2, catalog only for the
orchestrator credential, revoked node 401).

### 8.2 UI (`ui/`)

| Spec | Covers |
|---|---|
| `auth.spec.ts` | login (password, wrong password, redirect parameter), logout, route guard, banned message |
| `passkeys.spec.ts` | on `freshUser`: add passkey on the account page, sign in with passkey (virtual authenticator), last-credential guard |
| `setup.spec.ts` | setup page against a throwaway zero-user orchestrator (§8.6): token from the log, password and passkey paths, token removed from the URL |
| `consent.spec.ts` | consent page ([mcp](mcp.md) §3.3): client name with "unverified" badge, redirect origin, account email; access level radio ("Read and write" preselected, "Read only" grants only `scantor:read`, "Admin" absent for users and never preselected for admins, unrequested levels disabled); deny |
| `navigation.spec.ts` | sidebar items per role, collapse and theme persisted, mobile drawer, Scans badge |
| `overview.spec.ts` | overview page: first-run empty state, active scans, needs attention, recent scans and tasks, platform health for admins |
| `tasks.spec.ts` | list filters, wizard (scaffold, git with candidates, upload with `workspaceDirty`), task tabs, unpublished badge, publish → live build log, git pull with divergence, delete with `taskInUse` |
| `revisions.spec.ts` | build log phases, errors of a failed revision, describe view (schema tables, raw JSON) |
| `test-run.spec.ts` | schema-driven forms, SSE log and analyses, cancel, files, schema-changed banner |
| `schema-form.spec.ts` | every widget of [ui](ui.md) §6.2 on `schema-zoo`, JSON fallback, "Edit as JSON" round trip, server `configInvalid` mapping |
| `templates.spec.ts` | templates catalog: cards, schema tables, estimates (`cidr` gives "8 analyses (exact)") |
| `scans.spec.ts` | new scan form (estimate, confirmation above the threshold, privileged warning), detail controls per state (retry-failed counts failed and lost analyses), scale and restart modals; the privileged badge on tasks, revisions and scans, and `canRunPrivileged` in the admin user list ([security](security.md) PRIV-5) |
| `scan-results.spec.ts` | results filters, projection, load more, analysis slideover (attempts, logs, file chips), query console (rejected query shows the path), exports; `hostile-output` results, logs, errors and file names render inert as text (no element injected, no script run, ANSI stripped, data links only for `http(s):` with `rel="noopener noreferrer"`, [security](security.md) HDR-5) |
| `scan-health.spec.ts` | conditions rendering (`crashLoop` from a task whose connector is OOM-killed at import, before its handshake (`crashy` `exit` ends the connector after its handshake, which the runtime records as a `crash` analysis error and respawns), `workersPending` from an impossible node selector, `breakerTripped` with resume) |
| `admin-nodes.spec.ts` | add node shows the token once with join commands, rotate and revoke, built-in node restrictions, node detail |
| `admin-users.spec.ts` | create, edit, ban (the "cancel all their scans" box is pre-checked), unban, delete with job progress, self-protection |
| `account.spec.ts` / `access.spec.ts` / `credentials.spec.ts` | profile, password, sessions (on `freshUser`); API key shown once with export, alias and API-key MCP snippets, OAuth MCP command, OAuth app revoke; credentials CRUD |
| `editor.spec.ts` | on `freshUser`: editor starts, iframe loads the code-server workbench from the editor origin, new-tab session, stop |
| `admin-tools.spec.ts` | tool links set the tools cookie and reach each GUI through forwardAuth; non-admin gets nothing |
| `a11y.spec.ts` | on every page: every `button` has an accessible name; canonical names of [ui](ui.md) §11 exist |
| `headers.spec.ts` | the required headers of [ui](ui.md) §13 on every page and on `/api/*` (`Cache-Control: no-store`), `frame-ancestors 'none'` on `/login`, `/setup` and `/oauth/consent`, the editor host's headers; no CSP violation in the console on any page (this decides the inline-script option of [ui](ui.md) §13); no request leaves the dashboard, S3 and editor origins |

### 8.3 E2E scans (`e2e/`)

| Spec | Covers |
|---|---|
| `examples.spec.ts` | every example under `tasks/` (discovered via `tasks/*/scantor.yaml`) is uploaded, published and scanned per a table in `e2e/examples.ts` (`{dir, scan, expect: {state, counts, resultMatch}}`); the spec fails when an example has no entry. Together the examples cover every language (python, typescript, javascript, go) and every template |
| `templates.spec.ts` | template resolution and provenance (`scheduling.resolved`), `expectedTotal`, resume uses the stored resolution |
| `scheduler.spec.ts` | native and custom schedules, checkpoint and resume with epoch + 1, schedule limits, scheduler restarts and `schedulingFailed` |
| `retries.spec.ts` | `taskError` retried with backoff then succeeds, `Fatal` fails without retry, `Retry` delay honoured, timeout, attempts history (≤ 10) |
| `files.spec.ts` | `ctx.files.put` → FileRefs in nested results, presigned download with forced headers, quota |
| `workers.spec.ts` | worker containers: crash loops (a task whose module exits at import inside workers), OOM (`crashy` `memory`), drain and removal, image pull failures, process recycling |
| `placement.spec.ts` | desired workers, capacity reservations, the user worker cap, `workersPending` reasons, `worker.placed`/`worker.pending` events |
| `lifecycle.spec.ts` | pause/resume, scale workers and processes live (`processes.applied`), cancel (the scan's RabbitMQ user and queue are gone afterwards), retry-failed (new round, exact counts; failed analyses and `lost` ones with a config are reset, `cancelled` ones are not), restart clone, delete → tombstone |
| `breaker.spec.ts` | 100 %-failing scan auto-pauses with `breakerTripped`; resume clears it |
| `privileged.spec.ts` | publishing a manifest with `defaults.privileged: true` fails with a static error for a user without `canRunPrivileged`; for privileged revisions `startScan`, `restartScan`, `resumeScan` and `retryFailedAnalyses` → 403 `privilegedNotAllowed` without the flag; with it, `workersPending` reason `dindUnavailable` (test nodes run `SCANTOR_NODE_DIND=disabled`); a test run of a privileged task runs unprivileged for an owner with `canRunPrivileged` and fails at `static` without it |
| `remote-node.spec.ts` | `nodeSelector.pool = "remote"`: image pulled from the public registry host with a node token over TLS with the test CA (`SCANTOR_CA_CERT`), AMQPS and presigned S3 through Traefik (the public endpoint profile), results ingested, worker logs on demand |
| `backpressure.spec.ts` | 20 000-analysis `power`-style scan with `SCANTOR_SCAN_QUEUE_MAX_READY=500` completes with exact counts |
| `limits.spec.ts` | oversized result → non-retryable `validation`; too many files; analysis config over the limit fails scheduling; workers/processes above the instance caps → 400; test-run `limit`/`maxAttempts` bounds; concurrent waits and queries above their caps → 429. The build timeout and image-size cap are covered by vitest (pipeline driver with a fake `scantor task build`, §4.2) and `internal/taskpipe` integration tests, because a short build timeout on the shared stack would break every other build |
| `cli.spec.ts` | CLI through the shim: `validate`, `push`, `dev run` (local) and `dev run --remote`, `scans start/watch/pause/resume/cancel`, `uploads create` with a list-template scan, `analyses query`, `export`, `files get`; `-o json` NDJSON; exit codes 0/1/2/3; `localhost` rewrite |
| `debug.spec.ts` | `scantor dev debug` for every language: the debug port opens, `helpers/debug.ts` attaches and resumes, the analysis completes. For Go this proves that `dlv exec` passes fds 3/4 to the debuggee (otherwise the connector must use `SCANTOR_PROTOCOL_IN_FD`/`SCANTOR_PROTOCOL_OUT_FD`, [protocol](protocol.md) §10) |
| `scaffold-matrix.spec.ts` | §6 |

### 8.4 MCP (`mcp/`)

| Spec | Covers |
|---|---|
| `tools.spec.ts` | `tools/list` equals the curated table of [mcp](mcp.md) §5 and [api](api.md) §10 (names, levels, annotations, ≤ 30), names `^[a-z0-9_]{1,64}$`, descriptions present, read-only annotations follow GET/`x-read-only`, `destructiveHint` follows `DELETE`/`x-destructive`; level filtering of `tools/list` and `tools/call` (`scantor:read` sees no write tools; the admin tool only for admins with `scantor:admin`); `untrusted_data` wrapping; structured JSON errors; `wait` clamped to 50 |
| `oauth.spec.ts` | discovery documents; DCR with http loopback, private-use-scheme and allowed https redirects, https loopback redirects and non-loopback redirects outside `SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS` rejected at registration and at authorization; a CIMD `client_id` whose metadata host is private is refused (the positive CIMD path is a vitest unit test, §4.2); PKCE code flow; consent level selection; `scantor:admin` stripped for non-admins; refresh; `revokeOAuthApp` → next call 401; banned user → 401 |
| `apikey.spec.ts` | `default` and `editor` API keys on `/mcp` (level `write`; `admin` only for an admin's `default` key); an admin's `editor` key has no admin tools; an invalid key gets 401 with the OAuth challenge ([mcp](mcp.md) §3.7) |
| `agent-loop.spec.ts` | a serial loop using tools only: `create_task` (python, template `range`) → `read_task_file` (manifest, entry) → `write_task_files` (change `run`) → `test_task` (`wait=50`) → `publish_revision` (`wait`) → `start_scan` → `get_scan` (`wait`) until completed → `query_analyses` → `aggregate_analyses` → `export_scan` → `get_export`; asserts `{untrusted_data: …}` wrapping on analysis content and structured build errors after a deliberately broken edit |
| `limits.spec.ts` | 256 KiB response cap with the truncation note (a `query_analyses` call whose rows exceed it) |
| `guides.spec.ts` | server instructions (present, ≤ 8 KiB, every tool they name exists), guide resources and `get_authoring_guide` for every row of `schemas/languages.json` |
| `drift.spec.ts` | every MCP tool name and `scantor <command>` mentioned in `skills/**` and `docs/guide/*.md` exists (tools from `tools/list`, commands from `docs/guide/cli.md`, which `just docs` generates from the cobra command tree), and guide code snippets match the files in `tasks/` they claim to include |

### 8.5 Authorization matrix (`authz/`)

`openapi-lint.spec.ts` fails when an operation lacks `x-scantor-scope` or `x-mcp`, when `x-admin-only`
disagrees with scope `admin`, when the scope disagrees with the route prefix ([auth](auth.md) §5.4), when
`x-session-only` appears with a scope other than `owner` or `admin`, when `x-destructive` appears on a
`DELETE`, when an `operationId` is duplicated or not camelCase verb-first, when more than 30 operations
have `x-mcp: true`, when a request body has no schema, or when a route file exists without OpenAPI
metadata ([api](api.md) §1.1).

`matrix.spec.ts` is generated at runtime from the OpenAPI document. Its principals, seeded resources,
expectations per scope and the additional generated cases (create references, lists, caller-scoped names,
editor key, injection, the MCP half, ordering) are specified in [security](security.md) §7; this section
fixes the mechanics:

- The `authz-setup` project (`authz/seed.setup.ts`) seeds tenants **A** and **B** and the admin's
  credentials through the API (two sign-ins through the limiter; the admin reuses the global setup
  session), uses `remote-1` as node N1, derives
  worker tokens with `helpers/keys.ts`, and writes every id and credential to `.auth/authz.json`; the
  `authz-teardown` project deletes A and B. The generated tests read that file and run in parallel.
- `authz/requests.ts` is the parameter map and the body map: values for every path parameter name and a
  factory per `operationId` that receives the seeded ids. The matrix fails for an operation whose
  parameters, request body or required query parameters have no entry, so new routes cannot skip it.
- Reads run first; destructive operations (`DELETE`, `x-destructive`, cancel, retry, ban, rotate) run last
  against throwaway copies created per case. After B's attempts, A's resources are unchanged (hash of A's
  GET representations before and after).

### 8.6 Security (`security/`)

Corpora-driven and white-box specs for the [security](security.md) §6 catalogue, under the names
security.md cites (`tests/security/<name>.spec.ts`); the other mitigations are covered by the `api`,
`e2e`, `ui`, `mcp` and `authz` specs it names.

| Spec | Corpus / method | Expected |
|---|---|---|
| `dockerfile-policy.spec.ts` | `corpora/dockerfile-policy/*` through `uploadTask` (a sample per rule, including `FROM 0.0.0.0:5000/x` and `FROM [::]:5000/x`); plus a build-phase case: a task whose earlier stage is `FROM` a fixture image with an `ONBUILD` trigger, built locally in the inner dockerd by the spec (`scantor-test-onbuild:dev`, label `scantor.test=true`) | static cases: revision `failed`, `errors[0] = {phase: "static", file: "Dockerfile", line, message}` as in `expect.json` (the unspecified-address hosts are rejected by BLD-2/D5); the exploit case `COPY --from=localhost:<port>/tasks/<victim>` never yields the victim's files; the `ONBUILD` case: revision `failed` with `phase: "build"` and an error naming the image and its Dockerfile line ([security](security.md) BLD-7) |
| `hostile-labels.spec.ts` | (1) a task with forbidden `LABEL` keys (static and ARG-expanded); (2) defence in depth: a pre-built image carrying `traefik.*` and `com.docker.compose.project=scantor` labels is pushed with the orchestrator registry credential and a ready revision's digest is swapped to it (white-box via `mongosh`), then scanned | (1) static rejection; (2) the worker container's labels are the managed values (`docker inspect`), Traefik's router list has no router from it, requests to the dashboard host still reach the orchestrator |
| `tar-slip.spec.ts` | `corpora/tar-slip/cases.json` via `uploadTask` and `corpora/paths/cases.json` via `writeTaskFiles`/`deleteTaskFile`/`readTaskFile` | 422 `invalidPath` or 413; workspace unchanged (pack hash), nothing written outside the task folder |
| `query-injection.spec.ts` | `corpora/query-injection/cases.json` via `queryAnalyses`, `aggregateAnalyses`, `exportScan` | rejected cases 400 `queryRejected` with `details.path`; scope-override attempts (`{"scanId": {"$ne": null}}`, `$facet`→`$lookup`, `$unionWith`) return only the caller's scan; `$function`/`$where` rejected; connected directly as `scantor_query` (password from `helpers/keys.ts`), a `$where` find fails (`--noscripting`) and an `insertOne` is unauthorized |
| `cross-scan.spec.ts` | `helpers/amqp.ts` as `scan-<B>` | publish with routing key `<A>` refused by the broker; a spoofed `user_id` closes the channel; body claiming `scanId: A` with routing key `<B>` writes only `B-<seq>`; seq −1 / 1.5 / 2^53 and a round above the scan's round rejected; an oversized result becomes a `failed`/`validation` analysis while other scans keep ingesting; a message without `user_id` → `security.ingestRejected` event and no document |
| `banned.spec.ts` | ban a user (`freshUser`) holding a session, a `default` key, an `editor` key, an MCP OAuth token, MCP via API key and a tools cookie (admin) | every user principal rejected within the 30 s cache, keys and OAuth consents gone, editor stopped; with `cancelScans` the scans are cancelled, without it the scan's workers keep their tokens and the scan completes ([auth](auth.md) §5.7) |
| `setup-token.spec.ts` | a throwaway orchestrator (`scantor-test-setup-*`, label `scantor.test=true`, private infrastructure below), `SCANTOR_COMPONENTS=api`, no `SCANTOR_ADMIN_*` | `GET /api/setup/status` public; `createSetupAdmin` without or with a wrong token → 401 `setupTokenInvalid`; the token from its log → 201; again → 409 `setupCompleted`; a passkey setup token is single use |
| `insecure-secrets.spec.ts` | throwaway orchestrator containers ([security](security.md) CFG-2): public mode by a non-loopback `SCANTOR_PUBLIC_URL` or `SCANTOR_EDITOR_URL`, by `COMPOSE_PROFILES=traefik`, or by a non-loopback `SCANTOR_BIND_ADDRESS`/`SCANTOR_ADMIN_BIND_ADDRESS`; offenders: any variable ending in `-insecure-dev` (including one the orchestrator does not read) and short core secrets; plus an editor URL with the same origin as the public URL | in public mode: exit code 1 within 30 s and a log line naming each offending variable and no value; with `SCANTOR_ALLOW_INSECURE_DEFAULTS=true` the guard passes; all-loopback settings without Traefik pass; the same-origin editor URL always exits 1 |
| `auth-endpoints.spec.ts` | better-auth surface | each endpoint outside the HTTP allowlist ([auth](auth.md) §2.5) → 404; no other better-auth endpoint than those of [api](api.md) §3 reachable with a session; session `Set-Cookie` attributes; the client IP of sign-ins through Traefik, straight to the dashboard listener and from `scantor-sandbox` (never a forwarded value); API keys rejected on `/api/auth/*`; the rate limits are in `rate-limits.spec.ts` |
| `rate-limits.spec.ts` | throwaway orchestrators | the 11th sign-in within a minute with rotating `X-Forwarded-For` → 429 with `SCANTOR_TRUST_PROXY=false` and with `true` from a peer outside `SCANTOR_TRUSTED_PROXIES`; with the runner as the trusted proxy the rightmost entry is the client; the other per-IP auth budgets ([auth](auth.md) §2.7), so the suite's own budget (§9) is untouched |
| `csrf.spec.ts` | cookie-authenticated mutations | foreign or missing `Origin` → 403; the editor origin is never trusted; API keys need no `Origin` |
| `compose-lint.spec.ts`, `env-example.spec.ts` | the compose files and `.env.example` (no stack needed) | thin wrappers that run the rule functions of `scripts/lint-compose.mjs` and `scripts/lint-env.mjs` (§11), so the same rules fail `just lint` early and appear in the security project and TESTS.md |
| `traefik.spec.ts` | the stack's Traefik | `http://` redirects to `https://`, the test CA's certificate is served for every host and the SNI TCP router, each host routes to its target, the dashboard API needs the tools cookie |
| `secrets-masking.spec.ts` | `schema-zoo` with `writeOnly` fields | `"***"` in scans, test runs, analyses, exports and MCP; aggregations referencing a secret path rejected; values reach the task (asserted inside the task result as a hash); `getInstanceInfo` shows no secret values |
| `editor-isolation.spec.ts` | two users (`freshUser`) with editors | the dashboard listener answers 421 for the editor host and the editor listener 421 for any other host; the editor origin answers nothing but the proxy and `/_auth`; a session code is single-use and bound to its user (B cannot reach A's editor); the `scantor_editor` cookie is host-only and HttpOnly and stops working after the editor is stopped or restarted; a request to the editor origin carrying only the dashboard session cookie is not authenticated; a foreign-`Origin` WebSocket upgrade → 403; `Set-Cookie` from code-server never reaches the browser; a code-server socket replaced by a symlink (to `/var/run/docker.sock`, via `docker exec` in the editor) is refused; a POST to the dashboard API with `Origin: <editor origin>` and a session cookie → 403; a master worker cannot connect to the editor container |
| `sandbox.spec.ts` | `netprobe` on the built-in node and the remote node | the worker's `HostConfig` matches the hardening profile; master workers cannot reach mongo, mongo-express, the registry or the RabbitMQ management API (which rejects the scan user) without credentials; mode `env` shows no `SCANTOR_WORKER_TOKEN`; a test run of `netprobe` (network `scantor-egress`) reaches no platform service either; `169.254.169.254` unreachable where `egressDenyApplied` is true (skipped with a warning otherwise) |
| `downloads.spec.ts` | `hostile-output` files `x.html`, `x.svg`, `x.png` and a name with CR/LF/quotes | html/svg served as attachment with `application/octet-stream`; png inline as `image/png`; the name sanitised in `Content-Disposition`; unsigned GET → 403; a foreign-origin preflight refused; revision source downloads are `application/gzip` attachments; links expire |

The test-created orchestrator containers (`helpers/orchestrator.ts`) never run the reconciler
(`SCANTOR_COMPONENTS=api`), so their boot sweep cannot delete the main stack's per-scan RabbitMQ users. They
share only the stack's RabbitMQ (boot step 5 only asserts the global topology, which is idempotent) and get
private infrastructure for the rest (`ThrowawayInfra`, one per Playwright worker in the security specs): a
single-node MongoDB replica set, because boot step 2 creates or updates the global `scantor_query` user with a
password derived from the throwaway's own secret, which would break the stack's query client; a
Docker-in-Docker engine mounted as `/var/run/docker.sock`, because the `api` component's editor boot sweep
removes every editor container its own database does not know; and a RustFS. Every orchestrator on one
infrastructure gets a database and a bucket of its own, so each starts with zero users. They mount none of
the stack's volumes: their registry key files land in a container-local directory, so they never touch the
main registry's JWKS.

### 8.7 Chaos (`chaos/chaos.spec.ts`)

A deterministic subset: each case asserts only the final state and exact counts (via `scans.counts()`),
never timing. Cases run serially after all other projects.

| Case | Injection | Expected |
|---|---|---|
| runner killed | `docker kill` one runner of a `sleep` scan while analyses are in flight | scan `completed`; `succeeded == total`; one document per seq |
| orchestrator restart | `docker stop` the orchestrator during a running scan of about 60 s (longer than the drain and the boot together) and a running build, read the scan and the build job with `mongosh` while it is stopped, then `docker start` it with MongoDB paused, which holds the boot window open (API-010) | scan `completed` with exact counts (recount is authoritative); no `node.offline` event for the built-in node or `remote-1` and no lost worker, checked two detection ticks after the offline grace that follows the boot; the interrupted build is rebuilt from its stored snapshot |
| RabbitMQ restart with delayed retries | a flaky task with a fixed 30 s backoff; while every analysis is retrying, `docker stop` RabbitMQ until `/api/health` reports it down, then `docker start` it (a `docker restart` takes about 3 s, inside the 3 s health cache) | `/api/health` 200 `degraded` meanwhile; queue, retries and the scan user survive; retries delivered after the restart; exact final counts |
| pause/resume with delayed messages | pause while retries are delayed, wait 30 s, resume | exact final counts; no analysis lost |
| cancel with in-flight work | cancel a `sleep` scan with busy processes | `cancelled`; RabbitMQ user and queue gone; no `pending`/`retrying` documents after quiescence; counts stable over 30 s |
| delete with a result backlog | `docker pause` the orchestrator for 20 s while a fast scan keeps publishing results (they queue in `scantor.results.ingest`), `docker unpause`, then immediately cancel and delete the scan | tombstone `deleted`; zero analyses for the scan after 60 s (no resurrection); queue and RabbitMQ user absent |
| duplicate result | re-publish a captured result message as the scan user | counts unchanged |
| non-deterministic schedule | `nondeterministic` scan; kill the scheduler after `scheduling.confirmed > 0` | scan `failed`; `scheduling.error.message` contains "schedule() is not deterministic" |
| remote node partition | `docker network disconnect` the remote node (`scantor-remote-node` from `scantor-remote`) for 40 s (> `SCANTOR_NODE_OFFLINE_AFTER`), then reconnect | node `offline` then `online`; its workers `lost` and replaced; scan `completed` with exact counts; stale containers removed after return |
| lost analyses retried | a `throws` scan whose analyses are `retrying` with a long `backoff.initialMs`; delete the scan queue with its delayed messages through the RabbitMQ management API (the reconciler recreates it empty) | after `SCANTOR_SCAN_STALL_AFTER` the documents are `lost` with their config and the scan ends; `retryFailedAnalyses` resets them; scan `completed` with `succeeded == total` |
| broker alarm | lower RabbitMQ's memory watermark (`rabbitmqctl set_vm_memory_high_watermark absolute 1`) during a running scan, restore it after 20 s | while the alarm lasts `startScan` returns 503 `brokerAlarm` and the running scan shows the `brokerAlarm` condition; afterwards the condition clears and the scan completes with exact counts |

Excluded because they cannot be made deterministic in this environment: retry-failed racing late results,
killing the orchestrator exactly between a `bulkWrite` and the counter update, disk alarms, clock-skew
injection. They are covered by Go/vitest unit tests of the involved functions.

## 9. Isolation, idempotency and flake avoidance

Isolation and idempotency:

1. Every test creates its own resources with `unique()` names inside its worker's tenant and deletes them
   at teardown (the `tasks` and `scans` fixtures do it for what they create); tests that change
   account-level state use `freshUser`. Tenants are deleted at worker teardown. No test deletes resources
   it did not create, and there is no global cleanup.
2. Never assert on global emptiness or global counts, not even within a tenant; filter lists by your own
   ids.
3. **Sign-in budget.** better-auth allows 10 `/sign-in/email` and 10 `/oauth2/register` requests per
   minute per client IP in every environment ([auth](auth.md) §2.7), and the whole suite reaches Traefik
   from one IP. better-auth's limiter is a fixed window that resets only after a quiet minute, so under the
   suite's continuous sign-ins any finite budget eventually blocks: the test stack multiplies the limits by
   `SCANTOR_AUTH_RATE_LIMIT_SCALE=10000` (§7.3), and `security/rate-limits.spec.ts` asserts the real limits
   on a throwaway orchestrator. Every sign-in (API, browser form, wrong-password attempts), passkey
   authentication and dynamic client registration still goes through `helpers/limiter.ts` (whose budgets
   scale the same way), and sessions, API keys and registered OAuth clients are reused per worker. A 429
   from `/api/auth/*` outside the rate-limit test is a test bug.
4. Shared platform objects (built-in node, `remote-1`, global settings) are read-only outside the `chaos`
   project. Node tests create their own (unjoined) nodes.
5. Containers created by tests use the prefix `scantor-test-` and label `scantor.test=true`; fixtures
   remove them and the runner cleanup removes leftovers.
6. Every run starts from a fresh stack (`compose down -v` + label sweep); only images and build cache
   survive in the cache volume.
7. Tests keep `workers ≤ 2` and `processes ≤ 2` unless they test scaling, so parallel scans fit the
   built-in node.

Flake avoidance (agentor's pitfalls):

1. Select by role and accessible name (`getByRole('button', { name: 'Pause scan' })`), never by icon,
   button index or tooltip hover; use `exact: true` for prefixes ("Sign in" vs "Sign in with passkey") and
   scope to `getByRole('dialog')`.
2. No fixed sleeps. Use `expect.poll`, auto-waiting locators, `page.waitForResponse`, or `wait` on the
   API. Polled pages have a "Refresh" button; tests click it instead of waiting for an interval longer than
   the expect timeout.
3. Waits have explicit timeouts sized to the operation (UI assertions 10 s, builds 120 s, scans per test);
   helpers throw with diagnostic state (scan conditions, worker states) on timeout.
4. Counts come from `aggregateAnalyses`, not from `stats` hints.
5. Every API context sends `Origin`; storage states are created through the API (no UI login in setup).
6. The DinD netlink race: every container the inner dockerd creates adds interfaces to the runner's network
   namespace, and Chromium aborts its requests in flight with `net::ERR_NETWORK_CHANGED` when an address
   appears. Phase 1a keeps IPv6 link-local addresses off those interfaces; navigation still retries, and only
   on that error (`gotoWithRetry`).
7. Passkey tests run on the HTTPS origin with the CA trusted by Chromium; conditional mediation is
   skipped under webdriver by the app itself.
8. `shm_size: 2gb`; videos at 1920×1080; traces and screenshots retained on failure.
9. The runner never runs `docker network prune`/`volume prune`; dnsmasq never combines `no-resolv` with
   `resolv-file`; `filter-AAAA` avoids IPv6 timeouts; image builds retry.
10. The Playwright image tag equals the exact `@playwright/test` version; `node_modules` never comes from
    the host.
11. The UI never uses native dialogs, so tests never handle `dialog` events.
12. Colors are compared after normalization (production builds minify hex values).
13. Retries are 0 locally; CI allows one retry for diagnostics but fails on flaky tests.
14. RabbitMQ management statistics lag by seconds and omit a new queue's counts until their first collection,
    so helpers never read a missing count as 0 (`statsReported` in `helpers/api-scans-broker.ts`). A check of
    what a queue holds reads the broker itself (`innerDocker.rabbitmqQueues()`, rabbitmqctl), which knows a new
    queue's counts at once; only the delayed count needs the management API. Both views of a quorum queue refresh
    on its 5 s tick, so neither samples a busy queue more finely: the ready count of a scan whose runners keep up
    with its scheduler can go from a refill to nearly empty and back between two ticks. A test that must see the
    queue fill makes the runners slower than the scheduler (`e2e/backpressure.spec.ts` starts with one process
    slot) instead of hoping a snapshot lands on a peak.
15. A container's address on a Docker network is not stable: while it is stopped (`docker restart` included)
    another container can take it, and the restarted one gets a new address. Helpers that reach a container by
    IP read it again after a restart (`ThrowawayOrchestrator.restart()`); otherwise the test talks to another
    test's container.
16. A worker's lifecycle and its results travel separately: the runtime exits once the broker confirmed a result,
    and the ingestor writes it up to a flush interval later. After a worker drained, exited or stopped, wait for
    the analysis document (`waitForAnalysis`) instead of reading it once.
17. dockerd can lose the attached output of a container that exits within milliseconds (`copy stream failed …
    reading from a closed fifo` in `/var/log/dockerd.log` of the runner; the CLI still exits 0). Helpers that run
    such a container for its output (`runScantorShell`) redirect the script's output into files and copy them
    out with `docker cp` after the container exited.

## 10. `FEATURES.md` and `TESTS.md`

`tests/FEATURES.md` is the hand-written, canonical inventory of user-visible behaviour and drives coverage:

- Areas are sections `## <AREA>. <Title>` (`SCAN`, `UI-SCAN`, …: uppercase words joined by `-`), each with a
  line linking the `docs/` sections that document the mechanisms.
- Each feature is exactly one line `- **<AREA>-<NNN>** [<surfaces>] <behaviour>`: a three-digit id within its
  area, the surfaces that exercise it (`api`, `ui`, `cli`, `mcp`, `e2e`, `authz`, `security`, `chaos`), and the
  observable behaviour in present tense, including validation and error paths ("Starting a scan above the
  confirmation threshold without `confirm` returns 422 `confirmationRequired`"). It describes behaviour, not
  internals.
- Ids are stable: a new feature takes the next free number of its area, and the id of a removed feature is never
  reused (the gap stays).
- Every id must be covered by at least one Playwright test tag (`{ tag: ['@SCAN-012'] }`); tags in that shape
  must reference existing ids. Behaviour that only Go or vitest unit tests can reach is not listed (§4).

`tests/TESTS.md` has a short hand-written preamble (how to run: a pointer to this document, no duplicated
runbook) and a generated index between `<!-- BEGIN GENERATED: test-index -->` and
`<!-- END GENERATED: test-index -->`:

- per project: spec files, their top-level `describe` titles and test counts;
- per FEATURES.md id: a one-line summary and the tests that cover it;
- uncovered ids and unknown tags (the `--check` mode fails on either);
- unit suites by location, without counts: the packages of the root Go module with tests (as `go test ./...`
  finds them, `tests/docker/fixtures` included), vitest files, connector test directories (`connectors/go` is a
  module of its own).

`just test-index` runs `tests/scripts/test-index.mjs` in the Playwright image: it calls
`npx playwright test --list --reporter=json` (no stack needed) and parses FEATURES.md, failing on a line that
breaks its format (a malformed feature line, a duplicate id, an id outside its area's section, an unknown
surface). Listing loads every spec and helper, and those are written for the runner (Linux procfs, `/src`,
`/run/scantor-test`), so the script refuses to run outside a Linux container and names `just test-index`
instead; inside the test runner (`docker exec scantor-test-runner node scripts/test-index.mjs --check`) it
works too. No document anywhere (README, CLAUDE.md, docs, FEATURES.md) contains hand-kept test or feature
counts. CI runs `just test-index --check`.

Every change that adds or changes behaviour updates FEATURES.md, adds or adjusts tagged tests and
regenerates the index in the same commit ([development](development.md) §13).

## 11. Static checks run with tests

- `tests/scripts/check-terms.mjs` (part of `just lint`, dependency-free): fails when user-facing strings in
  `orchestrator/app/**/*.vue`, `docs/guide/*.md` and `README.md` use a curated list of forbidden terms from
  [architecture](architecture.md) §2 ("replica" except MongoDB's "replica set", "concurrency", "dry run",
  "campaign", "control plane", "head node", "scan template", "worker machine", "scan token"). Code is exempt:
  comments, fenced code blocks and inline code spans, identifiers (camelCase, snake_case) and env variable
  names.
- `tests/scripts/lint-compose.mjs` (`just lint-compose`, part of `just lint`) parses the compose files
  and fails when the infrastructure services (`mongo`, `rabbitmq`, `rustfs`, `registry`, `mongo-express`,
  `traefik`) differ between `docker-compose.dev.yml` and `docker-compose.prod.yml`, or when a compose rule
  of [security](security.md) is broken: Traefik `exposedbydefault=false`, the compose-project constraint
  and `api.insecure=false`; admin GUIs and MongoDB published only on `SCANTOR_ADMIN_BIND_ADDRESS`; the
  MongoDB TCP router only with `SCANTOR_EXPOSE_MONGO`; mongo-express read-only; `mongod --noscripting` and
  `--slowOpSampleRate 0`; RabbitMQ with the management plugin only (`RABBITMQ_ENABLED_PLUGINS`);
  memory limits on the orchestrator, mongo and rabbitmq; the orchestrator never mounts
  `scantor-workspaces`; no variable default anywhere (every `docker-compose.*.yml` and
  `tests/docker/stack.tests.yml`) except the image prefix fallback; the orchestrator and Traefik get
  `env_file: .env`.
- `tests/scripts/lint-env.mjs` (part of `just lint`, dependency-free) fails when a `SCANTOR_*` variable read
  by code (the Go `LoadConfig`s in `internal/*/config.go` and direct `Getenv`/`LookupEnv` calls,
  `server/utils/config.ts`, compose interpolations including `tests/docker/stack.tests.yml`, recipes,
  `tests/docker/stack.env` and `tests/helpers/env.ts`) is missing from `.env.example`,
  when a non-empty default of a variable whose name contains `PASSWORD` or `SECRET` does not end in
  `-insecure-dev` (empty defaults such as `SCANTOR_ADMIN_PASSWORD` pass; `SCANTOR_S3_ACCESS_KEY` is not a
  secret), or when a shipped value breaks a secure default:
  loopback `SCANTOR_BIND_ADDRESS` and `SCANTOR_ADMIN_BIND_ADDRESS`, `SCANTOR_NODE_DIND=disabled` and
  `SCANTOR_BUILTIN_NODE_DIND=disabled` ([security](security.md) PRIV-1), `SCANTOR_MONGO_EXPRESS_READONLY=true`
  (GUI-4), `SCANTOR_EXPOSE_MONGO=false`, `SCANTOR_NODE_EGRESS_DENY` covering `169.254.0.0/16` and
  `fd00:ec2::254/128`, and the first-initialisation note on the database root passwords. Variables that are
  not configuration form an exact allowlist and must never appear in `.env.example` (the check fails in both
  directions): the internal contract variables of [architecture](architecture.md) §10
  (`SCANTOR_WORKER_TOKEN`, `SCANTOR_DIND`, `SCANTOR_REGISTRY_PUSH_PASSWORD`), the base-image ENV contract
  (`SCANTOR_LANGUAGE`, `SCANTOR_CONNECTOR_CMD`, `SCANTOR_CHECK_CMD`, `SCANTOR_DEBUG_CMD`,
  `SCANTOR_DEBUG_PORT`) and the connector protocol variables of [protocol](protocol.md)
  (`SCANTOR_PROTOCOL_IN_FD`, `SCANTOR_PROTOCOL_OUT_FD`, `SCANTOR_PROTOCOL_VERSIONS`,
  `SCANTOR_PROCESS_INDEX`).
- `tests/scripts/*.test.mjs` (part of `just lint`, `node --test`, dependency-free) unit-test the scripts'
  pure functions, for example the container check of `test-index.mjs`.
- `authz/openapi-lint.spec.ts` (§8.5) enforces the OpenAPI extensions at runtime.

## 12. CI workflow (`.github/workflows/test.yml`)

Triggers: `push` to `main` and `pull_request` (all branches). `concurrency: test-${{ github.ref }}` with
`cancel-in-progress: true` for pull requests, so the runs on `main` finish in push order. Every job calls the
same `just` recipes developers run.

| Job | Runs on | Steps |
|---|---|---|
| `static` | `ubuntu-latest` | `actions/checkout@v7`, `extractions/setup-just@v4` (just 1.59.0), `just lint`, `just typecheck`, `just docs --check`, `just test-index --check` |
| `unit` | `ubuntu-latest`, matrix `suite: [go, go-integration, orchestrator, orchestrator-integration, connectors, conformance]` | checkout, setup-just, `docker/setup-buildx-action@v4`, `just test-<suite>`; for `go-integration` first the dev-tagged `scantor` and base images (`docker/bake-action`, `load: true`, reading the GHA cache, with the same `COMMIT` as the `e2e-images` job) and the service images `rabbitmq:4.4-management` and `registry:3.1.2`, for `orchestrator-integration` the same way the `scantor` image the recipe bakes |
| `e2e-images` | `ubuntu-latest`, `timeout-minutes: 60` | checkout; free disk space (`.github/scripts/free-disk-space.sh`: removes the preinstalled .NET, Android, GHC, CodeQL, Boost and Swift toolchains and images and moves Docker's `data-root` to `/mnt` when that disk has more room); setup-buildx; build the `test` bake group and `test-runner` with `docker/bake-action` (no output, `cache-from/to: type=gha` per target, `COMMIT` = `git rev-parse --short HEAD` like the justfile's `bake`), so the e2e groups only read the cache |
| `e2e` | `ubuntu-latest`, `needs: e2e-images`, `timeout-minutes: 120`, matrix of groups (`fail-fast: false`): `api` (`--project=api --project=authz --project=security --project=mcp`), `e2e` (`--project=e2e`), `ui` (`--project=ui`), `chaos` (`--project=chaos --no-deps`) | checkout; free disk space; setup-just, setup-buildx; the same bake with `load: true` reading the cache; `just test-images-save` (writes `.test-images/*.tar`), `SCANTOR_TEST_IMAGES_DIR=/src/.test-images SCANTOR_TEST_WORKERS=2 CI=true just test-e2e <group args>`; on failure or cancellation upload `tests/playwright-report` and `tests/test-results` as `playwright-report-<group>` with `actions/upload-artifact@v7` (7 days) |
| `latest` | `ubuntu-latest`, pushes to `main` only, `needs` `static`, `unit` and `e2e`; permissions `actions: read`, `packages: write` | `gh run list --workflow images.yml --commit <sha>` and `gh run watch` until the commit's image run ends; on success `docker buildx imagetools create -t …:latest …:sha-<short>` for the six platform images; a run cancelled by a newer push leaves `latest` alone (a notice), any other failure fails the job. `latest`, the shipped `SCANTOR_IMAGE_TAG`, therefore never names images whose tests did not pass ([development](development.md) §14) |

The privileged DinD runner works on GitHub-hosted Linux runners. Images are built on the CI host (with
the GitHub Actions cache) and loaded into the runner because the runner's cache volume does not survive
between CI runs; the runner image is baked by the same step with the build arguments of the justfile's
`bake` (`IMAGE_PREFIX`, `IMAGE_TAG` and `VERSION` are the bake defaults, `COMMIT` is set from `git rev-parse
--short HEAD`), so `just test-e2e` finds it in the builder's cache instead of rebuilding and re-exporting
it, and the pinned third-party images are pulled inside the runner on every CI run (§7.4 phase 8,
retried). The images, their tarballs, the runner's volume and the suite's task images need about 40 GB,
more than a hosted runner's root disk has free by default.

Each e2e group boots its own fresh stack on its own runner. A hosted runner of a private repository has 2 CPUs
and 7.75 GB (a public one 4 and 16 GB), and the whole suite with its serial `chaos` project outlasts the job
limit on one such runner, so the groups split it and run with 2 workers. The groups name their projects instead
of using Playwright's `--shard`, which splits only the top-level projects and runs every dependency project in
full in each shard: `chaos` depends on all other projects, so every shard would repeat everything but `chaos`.
`chaos` runs `--no-deps`; its dependencies only order it after the projects it would disturb on a shared stack.
On CI only the retry of a failed test records a video (§7.5): encoding a 1080p video of every UI test kept both
CPUs busy, and closing a context waits for the encoder, so the context teardowns outlasted the test timeout. A pull
request is mergeable only when every job passes.

## 13. Writing a new test (checklist)

1. Add or update the behaviour in `tests/FEATURES.md`.
2. Pick the project by what the test needs (API only → `api`; browser → `ui`; real scans → `e2e`;
   breaks shared infrastructure → `chaos`).
3. Import `test`/`expect` from `fixtures.ts`; use the `user`/`api`/`page` fixtures (the worker's tenant),
   or `freshUser` when the test changes account-level state; create everything you need with `unique()`
   names; never touch shared objects; never sign in or register an OAuth client without the limiter.
4. Tag the test with its FEATURES.md ids.
5. For a new API operation: add its entries to `authz/requests.ts`; for a new MCP tool: update the
   expected tool set in `mcp/tools.spec.ts`.
6. Run the file with `just test-exec <file>` against a stack kept alive with `just test-up` (remove it with
   `just test-down`); then `just test-index`.

## 14. Decisions

1. **Per-worker tenants plus on-demand fresh users** (created by admin, purged at worker or test
   teardown) are the isolation and cleanup mechanism, with unique names and fixture-owned deletion inside a
   tenant. Per-test users would need one sign-in per test, which better-auth's fixed per-IP limit
   (10/min, [auth](auth.md) §2.7) does not allow; a cross-worker limiter keeps the suite under it.
2. **The inner stack is the real `docker-compose.prod.yml`** plus a test override, started with its
   project directory set to the generated test files (`.env`, Traefik's dynamic TLS config); the suite
   runs through Traefik on one HTTPS origin with a trusted test CA. No TLS verification is disabled.
3. **DNS for `*.scantor.localhost` resolves to the runner's docker0 address** through dnsmasq, which the
   inner dockerd uses as its DNS; Traefik publishes on all runner addresses. One URL set works for the
   browser, the runner, master workers and the simulated remote node's workers.
4. **The CLI's local mode honours `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL`** so the scaffold matrix and
   `dev run` can use fixture data sources ([architecture](architecture.md) §10, [tasks](tasks.md) §11.4).
5. **The simulated remote node is one `docker:29.9-dind` service running the node daemon inside it**
   (pool `remote`), joined with the exact `dockerRun` command of `createNode`, so the join snippet, pulls
   through the public registry host, TLS with the test CA and the public endpoint profile are exercised for
   real, and the daemon's self-inspection (egress helper, free disk) works as on a real host.
6. **Orchestrator unit tests with vitest** for pure server logic, alongside Go and connector unit tests.
7. **Conformance runs through real task builds** (hidden `scantor conformance`), so the harness needs no
   per-language build logic.
8. **Images are defined once in `docker-bake.hcl`** (used by `just`, the runner and CI).
9. **CI retries once but fails on flaky tests**; local runs never retry.
10. **The authz matrix needs a parameter value and a request factory for every operation that takes
    them**, enforced by the matrix itself; its seed runs once as a Playwright setup project.
11. **Corpora are shared data files** consumed by Go/vitest unit tests (fast, exhaustive) and by e2e specs
    (one sample per rule through the real server).
12. **Compose and `.env.example` rules are static scripts** run by `just lint` (they need no stack and fail
    in the fastest CI job); `security/compose-lint.spec.ts` and `security/env-example.spec.ts` only wrap
    them.
13. **Security specs live in `tests/security/`** under the names [security](security.md) cites; behaviour
    that needs a fresh or differently configured orchestrator (setup token, startup guard, sign-in rate
    limit) runs against throwaway orchestrator containers, never against the shared stack.

## 15. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Load and soak tests (millions of analyses) | `helpers/scans.ts` and the `power`-style example scale with parameters; a separate opt-in project with its own timeouts can reuse the stack. |
| Multi-replica orchestrator tests | the stack override can add a second orchestrator service with `SCANTOR_COMPONENTS` split; the chaos project already kills and restarts components. |
| STS S3 credentials, multipart > 5 GiB | `files.spec.ts` gains cases behind the `uploads.mode` the bootstrap reports. |
| Cron / recurring scans | a `schedules` API spec and UI spec; the authz matrix covers new operations automatically. |
| Multi-arch builds | an arm64 CI runner variant of the `e2e` job; placement tests already assert architecture filtering. |
| More languages and templates | conformance, scaffold matrix and examples are driven by `languages.json`, `schemas/templates/` and `tasks/`. |
| Stack variants (no Traefik, external registry) | `stack.tests.yml` can be combined with variant overrides selected by an env variable, with variant-specific specs skipping themselves. |
| Visual regression | Playwright screenshots with `toHaveScreenshot` on stable pages (theme, empty states). |
| Nightly no-cache rebuild + full suite | a scheduled workflow calling the same recipes with `--no-cache`. |
