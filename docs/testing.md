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
| Static checks (terminology, compose, `.env.example`, test index) | `tests/scripts/*.mjs` | node container | no | `just lint` (includes `just lint-compose`), `just test-index --check` |
| Dockerized Playwright suite (API, UI, e2e, MCP, authz, security, scaffold matrix, chaos) | `tests/` | privileged DinD runner (`docker-compose.tests.yml`) | fresh master + remote node inside the runner | `just test-e2e`, `just test-api`, `just test-ui` |

`just test` runs `test-unit` (Go, orchestrator, connectors, conformance) followed by `test-e2e`. Every
recipe is idempotent, creates its own containers with `--rm`, and leaves no containers, networks or
volumes behind except named caches (§3).

## 2. Repository layout of `tests/`

```
tests/
├── package.json                 @playwright/test 1.64.1 (exact), @modelcontextprotocol/client ^2.3.1,
│                                amqplib ^2.2.0, ajv ^8.20.0, yaml ^2.9.1, tar-stream ^3.2.2,
│                                typescript ~6.0.3, @types/node
├── package-lock.json
├── tsconfig.json                strict, ES2022, moduleResolution bundler; path alias #shared → ../orchestrator/shared
├── playwright.config.ts
├── global-setup.ts
├── fixtures.ts                  test.extend: the only `test`/`expect` export specs import
├── helpers/                     env, limiter, api-client, openapi, users, webauthn, mcp, tasks, scans,
│                                docker, amqp, keys, tar, ui, cli, debug
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
├── fixtures/tasks/<name>/       test-only tasks (schema-zoo, netprobe, nondeterministic, big-result,
│                                crashy, no-hello, hostile-label, hostile-output)
├── docker/
│   ├── Dockerfile               runner image
│   ├── daemon.json              inner dockerd config
│   ├── entrypoint.sh            phases (§7.4)
│   ├── stack.tests.yml          compose override layered over docker-compose.prod.yml
│   ├── stack.env                non-secret test settings for the inner stack
│   ├── join-remote-node.mjs     creates the remote node record and starts its daemon
│   ├── traefik/tls.yml          file-provider config that makes the test CA wildcard certificate Traefik's default
│   └── fixtures/                fixtures server image: Dockerfile, server.mjs, data/ (tranco, crux, git repos)
├── scripts/
│   ├── test-index.mjs           generates the TESTS.md index; --check mode
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
| `just test-go-integration *args` | `go test -tags integration ./...` with the host Docker socket and the host network (tests publish service ports on the host's loopback); tests create containers named `scantor-test-*` with label `scantor.test=true` and remove them in `t.Cleanup`; the images they use (`scantor:dev`, the `scantor-base-*:dev` images, `rabbitmq:4.4-management`, `registry:3.1.2`) must exist locally |
| `just test-orchestrator *args` | `npm ci` (volume `scantor-dev-npm`) and `vitest run` in a Node container |
| `just test-orchestrator-integration *args` | starts throwaway MongoDB (replica set, keyFile, `--noscripting`), RabbitMQ and RustFS on a network `scantor-test-orchestrator-it`, then runs `vitest run` over the `*.integration.test.ts` files (or the given paths) as root in a `node` container with the Docker socket, the three editor stand-in volumes and `SCANTOR_TEST_INTEGRATION=true` plus the connection variables; removes every object with that prefix afterwards (§4.2) |
| `just test-connectors [base]` | builds `--target test` of `connectors/<base>/Dockerfile` (all bases by default) and runs it with `--network none` |
| `just test-conformance [language]` | runs the conformance harness for one language (default: every row of `schemas/languages.json`) |
| `just test-e2e *args` | `just init` (so `.env` has the "Tests" variables), `docker buildx bake --load test-runner` (the runner image, [development](development.md) §10), then `docker compose -f docker-compose.tests.yml run --rm test-runner *args` (args go to `playwright test`) |
| `just test-api *args` / `just test-ui *args` | `test-e2e --project=api *args` / `--project=ui` |
| `just test-exec *args` | re-runs `playwright test *args` inside a kept-alive runner (`SCANTOR_TEST_KEEP_ALIVE=true`) without rebuilding or restarting the stack |
| `just test-index [--check]` | regenerates the generated part of `tests/TESTS.md` (or fails when it is stale) |
| `just test-clean` | removes the runner container, its node_modules volume and the inner-Docker cache volume |

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
`just test-exec <file>`; do not loop the whole suite.

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
test-orchestrator-integration` satisfies the first three gates at once (one root container named
`scantor-test-orchestrator-it` on its own network, with the Docker socket, the editor stand-in volumes and
the connection variables of throwaway services); the last harness needs its own variables:

| Harness | Tests | Gate and setup |
|---|---|---|
| connection variables | `scans/broker.integration.test.ts` (topology, broker-enforced permissions, lifecycle, retry-failed backpressure, stall detection, delete job, user purge), `ingestor/ingestor.integration.test.ts` (ingestor flow and identity, dead letters, isolation mode, queries on real MongoDB) | `SCANTOR_TEST_INTEGRATION=true` plus the usual `SCANTOR_MONGO_*`, `SCANTOR_AMQP_INTERNAL_URL`, `SCANTOR_RABBITMQ_*` and `SCANTOR_S3_*` variables pointing at throwaway MongoDB (replica set, `--noscripting`), RabbitMQ 4.4 and RustFS; each run creates and removes its own database, vhost or bucket |
| containerised (`test/services/nodes/integration.ts`) | `nodes/node-api.integration.test.ts`, `runtime/runtime-api.integration.test.ts`, `registry/registry.integration.test.ts` | Linux, inside a container on a user-defined network with the Docker socket mounted (for example `node:26.12.1-trixie-slim` with Linux `node_modules` in a volume; the exact command is in the harness header). Containers are named after the runner container and never pulled: `mongo:9.0.4`, `rustfs/rustfs:1.0.3`, `registry:3.1.2` must exist locally (the recipe pulls missing images first). The registry runs in the Docker host's network namespace with a loopback forwarder for the token realm, because Docker Desktop sends non-loopback realm requests through its HTTP proxy |
| real code-server | `editor/code-server.integration.test.ts` (hardened editor container, safe socket connect, `/_auth` handoff, HTTP and WebSocket relay, symlinked sockets refused, stop) | as root in a container with the Docker socket and three throwaway volumes at `/run/scantor/editor-sockets`, `/volumes/editor-home` and `/volumes/workspaces`; `codercom/code-server:4.141.0` present locally, never pulled (command in the file header) |
| scantor image or binary | `helpers/helpers.integration.test.ts` (workspace helper operations with the production container profile), `pipeline/task-build.integration.test.ts` (a draft `scantor task build`) | `SCANTOR_TEST_SCANTOR_IMAGE=<prefix>scantor:<tag>` (prefix ending in `/`), plus `SCANTOR_TEST_SCANTOR_BINARY` (a host build of `./cmd/scantor`) for the build test; they create and remove their own volumes, networks and images |

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
    privileged: true
    container_name: scantor-test-runner
    shm_size: 2gb
    volumes:
      - test-runner-docker:/var/lib/docker
      - test-runner-node-modules:/work/tests/node_modules
      - ./:/src:ro
      - ./tests:/work/tests
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
  BuildKit cache across runs). `node_modules` lives in its own volume, never the host's.

### 7.2 Runner image (`tests/docker/Dockerfile`)

`FROM mcr.microsoft.com/playwright:v1.64.1-noble` (the tag must equal the exact `@playwright/test`
version) plus Docker Engine 29.9.2 with the buildx and compose plugins from Docker's apt repository
(pinned), `dnsmasq`, `iptables`, `openssl`, `libnss3-tools`, `jq`, `curl`, `uidmap`. Its build context is
the repository root (as for every bake target), so the `COPY` paths are `tests/docker/daemon.json`,
`tests/docker/entrypoint.sh`, `tests/docker/stack.tests.yml`, `tests/docker/stack.env`,
`tests/docker/traefik/` and `tests/docker/join-remote-node.mjs`.
`ENTRYPOINT ["/usr/local/bin/scantor-test-entrypoint"]`, `WORKDIR /work/tests`.

`daemon.json`: `{"storage-driver": "overlay2", "bip": "172.17.0.1/16", "dns": ["172.17.0.1"],
"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}`.

### 7.3 Inner stack

```
 test-runner container (privileged, own netns, no published ports)
 ├── dnsmasq  127.0.0.1 + 172.17.0.1   *.scantor.localhost → 172.17.0.1 ; rest → outer Docker DNS
 ├── dockerd  (bip 172.17.0.1/16, dns 172.17.0.1, data on scantor-test-runner-docker)
 │    └── compose project "scantor" = docker-compose.prod.yml + tests/docker/stack.tests.yml (profile traefik)
 │         traefik :443/:80 published on 0.0.0.0 of the runner ─┐  default cert = test CA wildcard
 │         orchestrator · mongo · rabbitmq · rustfs · registry · mongo-express · node (built-in, pool shared)
 │         fixtures   (tranco/crux data on :8089; git smart-HTTP behind Traefik as git.scantor.localhost)
 │         remote-node        docker:29.9-dind (own dockerd, trusts the test CA)          ┐ simulated remote
 │         remote-node-daemon scantor:dev `scantor node`, DOCKER_HOST=tcp://remote-node:2375 ┘ node, pool "remote"
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
  (§7.4 phase 7), so the production compose file is tested. Its project directory is
  `/run/scantor-test` (`--project-directory`), so the compose file's relative paths (`env_file: .env`,
  `./traefik/dynamic`) resolve to the generated test files and never to the developer's `/src/.env`.
  `stack.tests.yml` only adds the fixtures server, the remote node pair and test settings, and uses no
  relative paths. `stack.env` holds non-secret settings chosen for speed and determinism:

| Setting | Test value | Why |
|---|---|---|
| `COMPOSE_PROFILES` | `traefik` | the production Traefik mode (also seen by the startup guard) |
| `SCANTOR_IMAGE_PREFIX` | empty | locally built images: honoured by the compose file's `${SCANTOR_IMAGE_PREFIX-…}` references and by the orchestrator's image references ([architecture](architecture.md) §4.2) |
| `SCANTOR_IMAGE_TAG` | `dev` | the `:dev` images built or loaded in phase 5 |
| `SCANTOR_DOMAIN` and the URL set of [deployment](deployment.md) §7.7 | `scantor.localhost`; `SCANTOR_PUBLIC_URL` / `SCANTOR_EDITOR_URL` = `https://scantor.localhost` / `https://editor.scantor.localhost`, S3 `https://s3.scantor.localhost`, AMQP `amqps://amqp.scantor.localhost:443`, registry `registry.scantor.localhost`; `SCANTOR_TRAEFIK_CERT_RESOLVER` empty | one HTTPS origin (passkeys need it), the public endpoint profile for the remote node |
| `SCANTOR_TRUST_PROXY` | `true` | as in production behind Traefik |
| `SCANTOR_TRAEFIK_BIND_ADDRESS` | `0.0.0.0` | Traefik reachable at 127.0.0.1 and the docker0 address inside the runner (`SCANTOR_BIND_ADDRESS` keeps its loopback value) |
| `SCANTOR_ADMIN_EMAIL` | `admin@scantor.test` (password random, generated by the entrypoint) | headless first admin |
| `SCANTOR_TRANCO_URL` / `SCANTOR_CRUX_URL` | `http://fixtures.scantor.localhost:8089/tranco` / `…/crux` | no internet data sources |
| `SCANTOR_GIT_ALLOW_PRIVATE` | `true` | git import from the fixtures server |
| `SCANTOR_NODE_OFFLINE_AFTER` | `20s` | partition chaos case finishes quickly |
| `SCANTOR_SCAN_QUEUE_MAX_READY` | `500` | every scan exercises scheduler backpressure |
| `SCANTOR_SCAN_CONFIRM_THRESHOLD` | `1000` | confirmation flow testable with small scans |
| `SCANTOR_BREAKER_MIN_ATTEMPTS` | `20` | breaker trips within a small scan |
| `SCANTOR_SCAN_STALL_AFTER` | `30s` | stall detection testable |
| `SCANTOR_BUILTIN_NODE_MAX_WORKERS` | `16` | parallel e2e scans fit on the built-in node (the prod compose file maps it onto the daemon's `SCANTOR_NODE_MAX_WORKERS`, [deployment](deployment.md) §4.2) |
| `SCANTOR_EDITOR_IDLE_TIMEOUT` | `3m` | idle stop testable |

### 7.4 Entrypoint phases (`tests/docker/entrypoint.sh`)

`#!/usr/bin/env bash`, `set -euo pipefail`, helpers `log`/`err`. The cleanup function runs from a
`trap … EXIT INT TERM` installed **first**, so Ctrl+C, failures and normal exits all tear down.

| Phase | Action | Failure handling |
|---|---|---|
| 0. trap | `trap cleanup EXIT INT TERM`; `cleanup` = phase 9 | – |
| 1. cgroup v2 nesting | move processes into `/sys/fs/cgroup/init`, enable all controllers in `cgroup.subtree_control` (official dind trick) | warn and continue |
| 2. DNS | save upstream nameservers to `/etc/resolv.conf.upstream`; dnsmasq with `listen-address=127.0.0.1,172.17.0.1`, `bind-dynamic`, `address=/scantor.localhost/172.17.0.1`, `resolv-file=/etc/resolv.conf.upstream` (never together with `no-resolv`), `filter-AAAA`, `no-poll`; point `/etc/resolv.conf` at 127.0.0.1; verify `getent hosts scantor.localhost` and an upstream name | exit 1 |
| 3. dockerd | remove stale pid/socket files; start `dockerd` with `daemon.json`; wait ≤ 30 s for the socket | exit 1 with the dockerd log tail |
| 4. stale state | run `cleanup` once (leftovers of an aborted run); never `docker network prune`/`volume prune` (breaks BuildKit) | ignore errors |
| 5. images | `SCANTOR_TEST_IMAGES_DIR` set → `docker load` every `*.tar`; `SCANTOR_TEST_SKIP_BUILD=true` → require the images to exist; otherwise `docker buildx bake --load test` from `/src` (`docker-bake.hcl`, `IMAGE_TAG=dev`), retried 4× (cold pulls in DinD hit TLS timeouts) | exit 1 |
| 6. secrets and certificates | write `/run/scantor-test/.env`: `/src/.env.example`, overridden by `stack.env` (so compose interpolation and the orchestrator's `env_file` see the empty `SCANTOR_IMAGE_PREFIX` and `SCANTOR_IMAGE_TAG=dev`, never the shipped GHCR values), with every `-insecure-dev` value replaced by 48 random hex characters (the `just init` merge of [deployment](deployment.md) §8.3) and a random `SCANTOR_ADMIN_PASSWORD`; create the CA and wildcard certificate and `tls.yml` in `/run/scantor-test/traefik/dynamic/`; add the CA PEM as `SCANTOR_CA_CERT` (double-quoted, `\n`-escaped); install trust (system, NSS, Node) | exit 1 |
| 7. stack | pull every image the two compose files name (including the remote node pair's `docker:29.9-dind`) that is absent locally, with `docker pull` retried 4× like the build; after phase 5 only the pinned third-party images can be absent (once per cache volume locally, on every CI run). Then `docker compose -p scantor --project-directory /run/scantor-test -f /src/docker-compose.prod.yml -f /src/tests/docker/stack.tests.yml up -d --pull never` (profiles from `COMPOSE_PROFILES` in the project `.env`; without the remote node services) | exit 1 |
| 8a. wait | poll `https://scantor.localhost/api/health` until `status: ok` and every component `ok` (≤ 300 s) | dump `compose logs --tail 200`, exit 1 |
| 8b. remote node | `node join-remote-node.mjs`: sign in as the seeded admin (one sign-in), `createNode {name: "remote-1", pool: "remote", labels: {zone: "remote"}}`, write the token to the env file, `compose up -d remote-node remote-node-daemon` (same project flags as phase 7), wait ≤ 120 s until the node is `online` | exit 1 |
| 8c. playwright | `npm ci` into the node_modules volume when `package-lock.json` changed (hash stamp); export `SCANTOR_PUBLIC_URL`, `SCANTOR_EDITOR_URL`, `SCANTOR_ADMIN_EMAIL`, `SCANTOR_ADMIN_PASSWORD`, `SCANTOR_SECRET`, `NODE_EXTRA_CA_CERTS`; run `npx playwright test "$@"`; keep its exit code | – |
| 8d. keep alive | `SCANTOR_TEST_KEEP_ALIVE=true` → print `docker compose -f docker-compose.tests.yml exec test-runner bash` and block (`tail -f /dev/null`) until interrupted | – |
| 9. cleanup | `compose down -v --remove-orphans` (same project flags as phase 7); remove every container with label `scantor.managed=true` or `scantor.test=true` (workers, helpers, editors, test-run and build containers, test-created orchestrators); remove app-created networks (`scantor-egress`, label `scantor.kind=network`) and the boot-created volumes `scantor-workspaces` and `scantor-editor-home`; remove task and draft images (`*/tasks/*`); keep platform images and build cache; `chown -R` `playwright-report/` and `test-results/` to `SCANTOR_TEST_HOST_UID:GID` when set; exit with the Playwright exit code | best effort, logs every failure |

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
    video: { mode: 'retain-on-failure', size: { width: 1920, height: 1080 } },
  },
  projects: [
    { name: 'api', testMatch: 'api/**/*.spec.ts' },
    { name: 'authz-setup', testMatch: 'authz/seed.setup.ts', teardown: 'authz-teardown' },
    { name: 'authz-teardown', testMatch: 'authz/seed.teardown.ts' },
    { name: 'authz', testMatch: 'authz/**/*.spec.ts', dependencies: ['authz-setup'] },
    { name: 'security', testMatch: 'security/**/*.spec.ts' },
    { name: 'mcp', testMatch: 'mcp/**/*.spec.ts', timeout: 300_000 },
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts', timeout: 600_000 },
    { name: 'ui', testMatch: 'ui/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'chaos', testMatch: 'chaos/**/*.spec.ts', timeout: 900_000, fullyParallel: false,
      dependencies: ['api', 'authz', 'security', 'mcp', 'e2e', 'ui'] },
  ],
})
```

`chaos` starts only after every other project has finished, and its single spec file is serial, so
fault injection never disturbs other tests. The `authz` seed runs once as a setup project, so the matrix's
generated tests can run in parallel on every worker.

### 7.6 Global setup

Fails loudly (every error is thrown; nothing is swallowed):

1. Read the environment (`helpers/env.ts` is the only place reading `process.env` in tests).
2. Poll `GET /api/health` (≤ 120 s) until `status: ok`.
3. Reset the sign-in limiter state (`.auth/limiter/`, §9). Sign in as
   `SCANTOR_ADMIN_EMAIL`/`SCANTOR_ADMIN_PASSWORD` through `POST /api/auth/sign-in/email` with an API
   request context (one limiter slot); save `.auth/admin.json` (storage state). Browser pages reuse that
   storage state (same origin, cookie only), so no UI login happens in setup.
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
| `role` | option | `'user'` (default) or `'admin'` for `page`/`api` | – |
| `user` | worker | the worker's **tenant**: a user created by admin (`createUser`, unique email `w<workerIndex>-<unique>@scantor.test`, random password), signed in once through the limiter (storage state `.auth/user-<workerIndex>.json`), plus one `default` API key created with that session | `deleteUser` (202, `userPurge` job) at worker teardown |
| `api` | test | `ApiClient` with the tenant's session (admin's when `role: 'admin'`) | dispose |
| `apiKeyApi` | test | `ApiClient` with the tenant's API key (`Authorization: Bearer sk_scantor_…`) | dispose |
| `otherUser`, `otherApi` | worker (lazy) | a second tenant for cross-user checks | `deleteUser` |
| `freshUser`, `freshApi` | test (lazy) | a dedicated user and session for tests that change account-level state: password, passkeys, sessions, API key or OAuth app revocation, ban, role and limits, the editor | `deleteUser` |
| `anonApi` | test | `ApiClient` without credentials | dispose |
| `page` | test | browser page with the tenant's storage state (admin's when `role: 'admin'`, `freshUser`'s with option `pageUser: 'fresh'`) | Playwright |
| `mcp` | test (lazy) | MCP client connected through the real OAuth flow as the tenant, with the worker's registered OAuth client (one `/oauth2/register` per worker, through the limiter; `helpers/mcp.ts`); option `mcpScopes` | close |
| `mcpKey` | test (lazy) | MCP client authenticated with the tenant's API key ([mcp](mcp.md) §3.7) | close |
| `webauthn` | test (lazy) | CDP virtual authenticator on `page` (`ctap2`, resident key, user verification) | remove authenticator |
| `docker` | worker | inner-Docker helper: `inspect`, `exec`, `kill`, `networkDisconnect/Connect`, `logs`, `mongoCount` (read-only `mongosh` as `scantor_query`), `rabbitmqQueues` | – |
| `tasks` | test | `tasks.upload(dir, {name?})` (packs a folder with a unique manifest name, `uploadTask?wait=120`, expects `ready`), `tasks.fixture(name)`, `tasks.example(dir)` | `deleteTask` for every task it created |
| `scans` | test | `scans.start(body)`, `scans.wait(id, {state, timeoutMs})`, `scans.counts(id)` | `cancelScan` when not terminal, then `deleteScan`, for every scan it started (before the `tasks` teardown) |

Tenants are per worker because better-auth limits sign-ins per client IP and the whole suite shares one
IP (§9). Unique names (`unique()`) keep tests of the same tenant apart; the `tasks` and `scans` fixtures
delete what they created, and `deleteUser` at worker teardown removes everything else of the tenant
(scans, tasks, revisions, files, keys, [data model](data-model.md) §5).

### 7.8 Helpers

| Helper | Contract |
|---|---|
| `helpers/limiter.ts` | `reserve(path)`: a cross-worker sliding-window limiter (a lock file plus a timestamp log per path under `.auth/limiter/`) that blocks until a slot is free; at most 8 per rolling 60 s for `/sign-in/email` and for `/oauth2/register`, 16 for `/passkey/verify-authentication` (below the limits of [auth](auth.md) §2.7, with a margin for window-boundary effects) |
| `helpers/api-client.ts` | `ApiClient(request)`: generic `call(operationId, {path, query, body, headers})` resolved through the OpenAPI index (method + path template) returning `{status, headers, body}` (body `{}` when not JSON); thin typed wrappers for frequent operations using type-only imports from `#shared/types`; 2xx JSON bodies are validated against the operation's response schema (ajv, OpenAPI 3.0-style `nullable` converted to type arrays) so documentation drift fails tests |
| `helpers/users.ts` | `createUser`, `signedInContext(email, password)`, `browserSignIn(context, user)`; every sign-in (API, browser form, wrong-password attempts) first calls `reserve('/sign-in/email')`; every context carries `Origin` |
| `helpers/webauthn.ts` | `installVirtualAuthenticator(page)`, `listCredentials`, `dispose`; passkey sign-ins reserve `/passkey/verify-authentication` |
| `helpers/mcp.ts` | `TestOAuthProvider`, `registerClient()` (DCR, reserves `/oauth2/register`; cached per worker), `connectMcp(session, {scopes, client?})` (401 challenge → discovery → registration unless a client is given → consent via `POST /api/auth/oauth2/consent` → token → connect), `connectMcpWithKey(key)`, `callJson`, `callError`, `resultText`; redirect URI `http://127.0.0.1:53682/callback` (nothing listens; the code is read from the redirect) |
| `helpers/tasks.ts` | deterministic tar.gz of a folder with the manifest `name` rewritten (`yaml`), upload, publish, wait |
| `helpers/scans.ts` | `wait()` loops `getScan?wait=50` until the scan reaches the wanted state and throws with the scan's `state`, `stateReason` and `conditions` when it reaches another terminal state or times out; `counts()` uses `aggregateAnalyses [{$group: {_id: "$status", n: {$sum: 1}}}]` (exact, never the `stats` hints) |
| `helpers/docker.ts` | `execFile('docker', [...])` only (never a shell string), label-filtered lookups (`scantor.scan=<id>`, `scantor.kind=worker`) |
| `helpers/amqp.ts` | publish raw messages as a scan's RabbitMQ user (password via `helpers/keys.ts`) or as the admin, for security and chaos cases |
| `helpers/keys.ts` | HKDF derivations of [architecture](architecture.md) §9 from the stack's `SCANTOR_SECRET` for white-box tests (`amqp`, `registry-push`, `worker-token` with the worker documents from `listScanWorkers`, `mongo-query`, `tools-cookie`, `editor-cookie`), checked against `corpora/keys-vectors.json` |
| `helpers/tar.ts` | builds hostile archives (traversal, absolute, symlink, hardlink, device, FIFO, NUL, backslash, too many files, gzip bomb) from `corpora/tar-slip/cases.json` |
| `helpers/ui.ts` | `gotoWithRetry` (retries only on `net::ERR_NETWORK_CHANGED`), `expectToast(text)`, `openTab(name)` |
| `helpers/cli.ts` | runs `scantor:dev` with the shim flags against the inner dockerd and returns `{exitCode, stdout, stderr, json}` |
| `helpers/debug.ts` | minimal attach clients that resume a debuggee waiting for its debugger: DAP for debugpy (`initialize`, `attach`, `configurationDone`), the Chrome DevTools protocol for Node (`Runtime.runIfWaitingForDebugger`), delve's JSON-RPC API v2 (`RPCServer.Command {name: "continue"}`) |
| `unique(prefix)` | `${prefix}-${workerIndex}-${Date.now().toString(36)}-${rand4}`, lowercase slug ≤ 64 |

### 7.9 Fixture tasks and fixtures server

- `tests/fixtures/tasks/` (Python unless noted; small and fast to build): `schema-zoo` (one field per
  construct of the supported JSON Schema subset ([tasks](tasks.md) §6.4) including a discriminated union,
  `writeOnly`, upload and FileRef fields; also in TypeScript and Go to compare describe output),
  `netprobe` (TCP connect attempts to hosts from its task config, returns reachability; mode `env` returns
  the names of its environment variables), `nondeterministic` (custom schedule yielding random items
  slowly), `big-result` (exceeds `SCANTOR_MAX_RESULT_BYTES`), `crashy` (modes: exit 3, allocate beyond its
  memory limit, hang past the timeout), `no-hello` (connector never sends `hello`), `hostile-label`
  (Dockerfile with forbidden `LABEL`s), `hostile-output` (results and logs with HTML/script strings and
  ANSI sequences; files `x.html`, `x.svg`, `x.png` and a name with CR/LF and quotes).
- Fixtures server (`tests/docker/fixtures/`, image `scantor-test-fixtures:dev`, Node 26 + git): serves
  exactly the upstream endpoints of [templates](templates.md) §9.5–§9.6 from small pinned files, under
  `/tranco` (`/api/lists/date/latest`, `/daily_list_id`, `/api/lists/id/<id>`, `/download/<id>/<n>` with
  CRLF CSVs) and `/crux` (`data/global/<YYYYMM>.csv.gz`, `data/country/<cc>/<YYYYMM>.csv.gz`, `HEAD`
  probes), a git smart-HTTP endpoint (`git http-backend`) with a public repository
  (one task), a multi-task repository (candidate selection) and a private repository behind Basic auth (git
  credentials), and a repository whose second commit diverges (pull conflicts).

## 8. Suites

Every test carries the FEATURES.md ids it covers as tags (`{ tag: ['@F5.2'] }`, §10).

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
another node ignored, wrong-prefix credentials 401), `runtime-api` (bootstrap shape per role, runner
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
| `tasks.spec.ts` | list filters, wizard (scaffold, git with candidates, upload with `workspaceDirty`), task tabs, unpublished badge, publish → live build log, git pull with divergence, delete with `taskInUse` |
| `revisions.spec.ts` | build log phases, errors of a failed revision, describe view (schema tables, raw JSON) |
| `test-run.spec.ts` | schema-driven forms, SSE log and analyses, cancel, files, schema-changed banner |
| `schema-form.spec.ts` | every widget of [ui](ui.md) §6.2 on `schema-zoo`, JSON fallback, "Edit as JSON" round trip, server `configInvalid` mapping |
| `scans.spec.ts` | new scan form (estimate, confirmation above the threshold, privileged warning), detail controls per state (retry-failed counts failed and lost analyses), scale and restart modals; the privileged badge on tasks, revisions and scans, and `canRunPrivileged` in the admin user list ([security](security.md) PRIV-5) |
| `scan-results.spec.ts` | results filters, projection, load more, analysis slideover (attempts, logs, file chips), query console (rejected query shows the path), exports; `hostile-output` results, logs, errors and file names render inert as text (no element injected, no script run, ANSI stripped, data links only for `http(s):` with `rel="noopener noreferrer"`, [security](security.md) HDR-5) |
| `scan-health.spec.ts` | conditions rendering (`crashLoop` from `crashy`, `workersPending` from an impossible node selector, `breakerTripped` with resume) |
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
| `retries.spec.ts` | `taskError` retried with backoff then succeeds, `Fatal` fails without retry, `Retry` delay honoured, timeout, attempts history (≤ 10) |
| `files.spec.ts` | `ctx.files.put` → FileRefs in nested results, presigned download with forced headers, quota |
| `lifecycle.spec.ts` | pause/resume, scale workers and processes live (`processes.applied`), cancel (the scan's RabbitMQ user and queue are gone afterwards), retry-failed (new round, exact counts; failed analyses and `lost` ones with a config are reset, `cancelled` ones are not), restart clone, delete → tombstone |
| `breaker.spec.ts` | 100 %-failing scan auto-pauses with `breakerTripped`; resume clears it |
| `privileged.spec.ts` | publishing a manifest with `defaults.privileged: true` fails with a static error for a user without `canRunPrivileged`; for privileged revisions `startScan`, `restartScan`, `resumeScan` and `retryFailedAnalyses` → 403 `privilegedNotAllowed` without the flag; with it, `workersPending` reason `dindUnavailable` (test nodes run `SCANTOR_NODE_DIND=disabled`); a test run of a privileged task runs unprivileged |
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
| `oauth.spec.ts` | discovery documents; DCR with loopback, private-use-scheme and allowed https redirects, non-loopback redirect outside `SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS` rejected at registration and at authorization; a CIMD `client_id` whose metadata host is private is refused (the positive CIMD path is a vitest unit test, §4.2); PKCE code flow; consent level selection; `scantor:admin` stripped for non-admins; refresh; `revokeOAuthApp` → next call 401; banned user → 401 |
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
| `setup-token.spec.ts` | a throwaway orchestrator container (`scantor-test-setup-*`, label `scantor.test=true`) on the stack network with its own database and bucket, `SCANTOR_COMPONENTS=api`, no `SCANTOR_ADMIN_*` | `GET /api/setup/status` public; `createSetupAdmin` without or with a wrong token → 401 `setupTokenInvalid`; the token from its log → 201; again → 409 `setupCompleted`; a passkey setup token is single use |
| `insecure-secrets.spec.ts` | throwaway orchestrator containers ([security](security.md) CFG-2): public mode by a non-loopback `SCANTOR_PUBLIC_URL` or `SCANTOR_EDITOR_URL`, by `COMPOSE_PROFILES=traefik`, or by a non-loopback `SCANTOR_BIND_ADDRESS`/`SCANTOR_ADMIN_BIND_ADDRESS`; offenders: any variable ending in `-insecure-dev` (including one the orchestrator does not read) and short core secrets; plus an editor URL with the same origin as the public URL | in public mode: exit code 1 within 30 s and a log line naming each offending variable and no value; with `SCANTOR_ALLOW_INSECURE_DEFAULTS=true` the guard passes; all-loopback settings without Traefik pass; the same-origin editor URL always exits 1 |
| `auth-endpoints.spec.ts` | better-auth surface | each disabled path ([auth](auth.md) §2.5) → 404; no other better-auth endpoint than those of [api](api.md) §3 reachable with a session; session `Set-Cookie` attributes; API keys rejected on `/api/auth/*`; sign-in rate limit: on a throwaway orchestrator (`SCANTOR_TRUST_PROXY=false`), the 11th sign-in within a minute with rotating `X-Forwarded-For` → 429, so the suite's own budget (§9) is untouched |
| `csrf.spec.ts` | cookie-authenticated mutations | foreign or missing `Origin` → 403; the editor origin is never trusted; API keys need no `Origin` |
| `compose-lint.spec.ts`, `env-example.spec.ts` | the compose files and `.env.example` (no stack needed) | thin wrappers that run the rule functions of `scripts/lint-compose.mjs` and `scripts/lint-env.mjs` (§11), so the same rules fail `just lint` early and appear in the security project and TESTS.md |
| `secrets-masking.spec.ts` | `schema-zoo` with `writeOnly` fields | `"***"` in scans, test runs, analyses, exports and MCP; aggregations referencing a secret path rejected; values reach the task (asserted inside the task result as a hash); `getInstanceInfo` shows no secret values |
| `editor-isolation.spec.ts` | two users (`freshUser`) with editors | the dashboard listener answers 421 for the editor host and the editor listener 421 for any other host; the editor origin answers nothing but the proxy and `/_auth`; a session code is single-use and bound to its user (B cannot reach A's editor); the `scantor_editor` cookie is host-only and HttpOnly and stops working after the editor is stopped or restarted; a request to the editor origin carrying only the dashboard session cookie is not authenticated; a foreign-`Origin` WebSocket upgrade → 403; `Set-Cookie` from code-server never reaches the browser; a code-server socket replaced by a symlink (to `/var/run/docker.sock`, via `docker exec` in the editor) is refused; a POST to the dashboard API with `Origin: <editor origin>` and a session cookie → 403; a master worker cannot connect to the editor container |
| `sandbox.spec.ts` | `netprobe` on the built-in node and the remote node | the worker's `HostConfig` matches the hardening profile; master workers cannot reach mongo, mongo-express, the registry or the RabbitMQ management API (which rejects the scan user) without credentials; mode `env` shows no `SCANTOR_WORKER_TOKEN`; a test run of `netprobe` (network `scantor-egress`) reaches no platform service either; `169.254.169.254` unreachable where `egressDenyApplied` is true (skipped with a warning otherwise) |
| `downloads.spec.ts` | `hostile-output` files `x.html`, `x.svg`, `x.png` and a name with CR/LF/quotes | html/svg served as attachment with `application/octet-stream`; png inline as `image/png`; the name sanitised in `Content-Disposition`; unsigned GET → 403; a foreign-origin preflight refused; revision source downloads are `application/gzip` attachments; links expire |

The test-created orchestrator containers never run the reconciler (`SCANTOR_COMPONENTS=api`), so their
boot sweep cannot delete the main stack's per-scan RabbitMQ users. They get their own database and bucket
and the Docker socket (boot step 6 ensures Docker objects idempotently), but none of the stack's volumes:
their registry key files land in a container-local directory, so they never touch the main registry's
JWKS.

### 8.7 Chaos (`chaos/chaos.spec.ts`)

A deterministic subset: each case asserts only the final state and exact counts (via `scans.counts()`),
never timing. Cases run serially after all other projects.

| Case | Injection | Expected |
|---|---|---|
| runner killed | `docker kill` one runner of a `sleep` scan while analyses are in flight | scan `completed`; `succeeded == total`; one document per seq |
| orchestrator restart | `docker restart` the orchestrator during a running scan | scan `completed` with exact counts (recount is authoritative) |
| RabbitMQ restart with delayed retries | `throws` (flaky) with `backoff.initialMs` 20 000; restart RabbitMQ while retries are delayed | retries delivered after the restart; exact final counts |
| pause/resume with delayed messages | pause while retries are delayed, wait 30 s, resume | exact final counts; no analysis lost |
| cancel with in-flight work | cancel a `sleep` scan with busy processes | `cancelled`; RabbitMQ user and queue gone; no `pending`/`retrying` documents after quiescence; counts stable over 30 s |
| delete with a result backlog | `docker pause` the orchestrator for 20 s while a fast scan keeps publishing results (they queue in `scantor.results.ingest`), `docker unpause`, then immediately cancel and delete the scan | tombstone `deleted`; zero analyses for the scan after 60 s (no resurrection); queue and RabbitMQ user absent |
| duplicate result | re-publish a captured result message as the scan user | counts unchanged |
| non-deterministic schedule | `nondeterministic` scan; kill the scheduler after `scheduling.confirmed > 0` | scan `failed`; `scheduling.error.message` contains "schedule() is not deterministic" |
| remote node partition | `docker network disconnect` the remote node pair for 40 s (> `SCANTOR_NODE_OFFLINE_AFTER`), then reconnect | node `offline` then `online`; its workers `lost` and replaced; scan `completed` with exact counts; stale containers removed after return |
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
   from one IP. Every sign-in (API, browser form, wrong-password attempts), passkey authentication and
   dynamic client registration therefore goes through `helpers/limiter.ts`, and sessions, API keys and
   registered OAuth clients are reused per worker. A 429 from `/api/auth/*` outside the rate-limit test is
   a test bug.
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
6. Navigation retries only on `net::ERR_NETWORK_CHANGED` (DinD netlink race).
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

## 10. `FEATURES.md` and `TESTS.md`

`tests/FEATURES.md` is the hand-written inventory of user-visible behaviour and drives coverage:

- Numbered sections `## F<n>. <Area>` and subsections `### F<n>.<m> <Feature>` (new subsections take the
  next free number; ids are never reused). Bullets describe observable behaviour in present tense,
  including validation and error paths ("Starting a scan above the confirmation threshold without
  `confirm` returns 422 `confirmationRequired`").
- It describes behaviour, not internals; it links to `docs/` for mechanisms.
- Every subsection id must be covered by at least one test tag (`{ tag: ['@F5.2'] }`); tags must reference
  existing ids.

`tests/TESTS.md` has a short hand-written preamble (how to run: a pointer to this document, no duplicated
runbook) and a generated index between `<!-- BEGIN GENERATED: test-index -->` and
`<!-- END GENERATED: test-index -->`:

- per project: spec files, their top-level `describe` titles and test counts;
- per FEATURES.md id: the tests that cover it;
- uncovered ids and unknown tags (the `--check` mode fails on either);
- unit suites by location (Go packages with tests, vitest files, connector test directories), without
  counts.

`just test-index` runs `tests/scripts/test-index.mjs` in the Playwright image: it calls
`npx playwright test --list --reporter=json` (no stack needed) and parses FEATURES.md. No document
anywhere (README, CLAUDE.md, docs) contains hand-kept test counts. CI runs `just test-index --check`.

Every change that adds or changes behaviour updates FEATURES.md, adds or adjusts tagged tests and
regenerates the index in the same commit ([development](development.md) §13).

## 11. Static checks run with tests

- `tests/scripts/check-terms.mjs` (part of `just lint`): fails when user-facing strings in
  `orchestrator/app/**/*.vue`, `docs/guide/*.md` and `README.md` use a curated list of forbidden terms from
  [architecture](architecture.md) §2 ("replica", "concurrency" in scaling contexts, "dry run", "campaign",
  "control plane", "head node", "scan template", "worker machine", "scan token"). Code identifiers and env
  variable names are exempt.
- `tests/scripts/lint-compose.mjs` (`just lint-compose`, part of `just lint`) parses the compose files
  and fails when the infrastructure services (`mongo`, `rabbitmq`, `rustfs`, `registry`, `mongo-express`,
  `traefik`) differ between `docker-compose.dev.yml` and `docker-compose.prod.yml`, or when a compose rule
  of [security](security.md) is broken: Traefik `exposedbydefault=false`, the compose-project constraint
  and `api.insecure=false`; admin GUIs and MongoDB published only on `SCANTOR_ADMIN_BIND_ADDRESS`; the
  MongoDB TCP router only with `SCANTOR_EXPOSE_MONGO`; mongo-express read-only; `mongod --noscripting`;
  memory limits on the orchestrator, mongo and rabbitmq; the orchestrator never mounts
  `scantor-workspaces`; no variable default anywhere except the image prefix fallback; the orchestrator
  and Traefik get `env_file: .env`.
- `tests/scripts/lint-env.mjs` (part of `just lint`) fails when a `SCANTOR_*` variable read by code (Go
  `LoadConfig`s, `server/utils/config.ts`, compose interpolations, recipes) is missing from `.env.example`,
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
- `authz/openapi-lint.spec.ts` (§8.5) enforces the OpenAPI extensions at runtime.

## 12. CI workflow (`.github/workflows/test.yml`)

Triggers: `push` to `main` and `pull_request` (all branches). `concurrency: test-${{ github.ref }}` with
`cancel-in-progress: true` for pull requests. Every job calls the same `just` recipes developers run.

| Job | Runs on | Steps |
|---|---|---|
| `static` | `ubuntu-latest` | `actions/checkout@v7`, `extractions/setup-just@v4` (just 1.59.0), `just lint`, `just typecheck`, `just docs --check`, `just test-index --check` |
| `unit` | `ubuntu-latest`, matrix `suite: [go, go-integration, orchestrator, orchestrator-integration, connectors, conformance]` | checkout, setup-just, `docker/setup-buildx-action@v4`, `just test-<suite>`; for `go-integration` first the dev-tagged `scantor` and base images (`docker/bake-action`, `load: true`, reading the GHA cache) and the service images `rabbitmq:4.4-management` and `registry:3.1.2` |
| `e2e` | `ubuntu-latest`, `timeout-minutes: 120` | checkout, setup-just, setup-buildx; build the `test` bake group with `docker/bake-action` (`load: true`, `cache-from/to: type=gha`), `just test-images-save` (writes `.test-images/*.tar`), `SCANTOR_TEST_IMAGES_DIR=/src/.test-images CI=true just test-e2e`; on failure upload `tests/playwright-report` and `tests/test-results` with `actions/upload-artifact@v7` (7 days) |

The privileged DinD runner works on GitHub-hosted Linux runners. Images are built on the CI host (with
the GitHub Actions cache) and loaded into the runner because the runner's cache volume does not survive
between CI runs; the runner image itself is baked on the CI host by `just test-e2e`, and the pinned
third-party images are pulled inside the runner on every CI run (§7.4 phase 7, retried). A pull request is mergeable only when all three jobs pass.

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
6. Run the file with `just test-exec <file>` against a kept-alive stack; then `just test-index`.

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
5. **The simulated remote node is a `docker:29.9-dind` service plus a separate `scantor node` service**
   (pool `remote`), so pulls, TLS and the public endpoint profile are exercised for real.
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
