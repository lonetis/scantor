# Development

This document is the contributor guide for the scantor repository: the development environment (the
devcontainer built from the editor's toolchain stage plus Docker-in-Docker), the rule that every `just`
recipe runs its tools in containers, the complete recipe list, everyday workflows, how code is organized
in each component (Go module, orchestrator, connectors), step-by-step checklists for adding an API route,
a language, a template, a UI page and an environment variable, the image build definitions, the version
and dependency policy, commit conventions, documentation rules and the release process. Testing is
specified in [testing](testing.md); the system design in [architecture](architecture.md).

## 1. Prerequisites

The host needs only:

| Tool | Version | Used for |
|---|---|---|
| Docker Engine (or Docker Desktop) with the compose and buildx plugins | ≥ 29 (BuildKit) | everything: builds, toolchains, the dev stack, tests |
| just | 1.59.0 (GitHub release binary, Homebrew or `extractions/setup-just@v4` in CI) | task runner |
| git | any recent | source control, `just release` |
| POSIX shell | – | recipe glue |

No Go, Node or Python is needed on the host. Contributors who want local IntelliSense either open the
devcontainer (§2) or run `just deps` (installs `node_modules` for IDEs, in a container).

## 2. Devcontainer

`.devcontainer/devcontainer.json`:

```jsonc
{
  "name": "scantor",
  "build": { "dockerfile": "../editor/Dockerfile", "context": "..", "target": "toolchain" },
  "features": {
    "ghcr.io/devcontainers/features/common-utils:2": {
      "username": "vscode", "userUid": "1000", "userGid": "1000",
      "installZsh": false, "installOhMyZsh": false, "upgradePackages": false
    },
    "ghcr.io/devcontainers/features/docker-in-docker:4": { "moby": false }
  },
  "remoteUser": "vscode",
  "updateRemoteUserUID": true,
  "postCreateCommand": "bash .devcontainer/post-create.sh",
  "customizations": {
    "vscode": {
      "extensions": [
        "golang.go", "ms-python.python", "detachhead.basedpyright", "charliermarsh.ruff",
        "Vue.volar", "dbaeumer.vscode-eslint", "esbenp.prettier-vscode", "redhat.vscode-yaml",
        "ms-playwright.playwright"
      ]
    }
  }
}
```

- The `toolchain` stage of `editor/Dockerfile` ([editor](editor.md)) is the single definition of the
  development toolchain: Go 1.27.3, Node 26, Python 3.14, uv 0.13.4, just 1.59.0, basedpyright, gopls,
  delve, git, and the connectors installed at the same well-known paths as the base images (Python
  connector system-wide, `/node_modules/@scantor/connector`, `/opt/scantor/connectors/go`). The
  connectors live in `toolchain`, so the `editor` stage inherits them ([editor](editor.md) §2.1); the
  stage makes these paths writable by the container user (owned by uid 1000).
- The docker-in-docker feature gives the devcontainer its own Docker daemon, so `just up`, `just test`
  and the dockerized test runner work unchanged inside it.
- The devcontainer runs as `vscode`, a non-root user that the `common-utils` feature creates with uid 1000
  (the `toolchain` stage has no user of its own; the `editor` stage adds `coder` with the same uid) and
  passwordless sudo; the docker-in-docker feature adds it to the `docker` group. On Linux,
  `updateRemoteUserUID` gives it the host user's uid, so the recipes' `-u "$(id -u):$(id -g)"` (§3) and
  `post-create.sh` leave `.env`, `node_modules/` and `bin/` in the bind-mounted checkout owned by the
  contributor, never by root.
- `.devcontainer/post-create.sh` makes the repository's connectors live at the well-known paths, so edits
  are visible to IntelliSense, `dev run` builds in the devcontainer and the language servers without a
  rebuild:

```bash
#!/usr/bin/env bash
set -euo pipefail
repo="$(pwd)"
# as_owner runs a command directly while the user can write the uid-1000 connector paths, otherwise with
# sudo (a user remapped to another host uid)
as_owner uv pip install --system --break-system-packages --no-deps --editable "$repo/connectors/python"
# The image ships real directories at these paths; ln -sfn would create the link inside them.
as_owner rm -rf /node_modules/@scantor/connector /opt/scantor/connectors/go
as_owner ln -sfn "$repo/connectors/js" /node_modules/@scantor/connector
as_owner ln -sfn "$repo/connectors/go" /opt/scantor/connectors/go
just init
just deps
```

The linked JS connector resolves through its `dist/` like the installed one (§8); `just deps` runs
`npm ci` in `connectors/js`, whose `prepare` script compiles it.

- Nested Docker: the test runner (privileged DinD) inside the devcontainer (DinD) needs cgroup v2
  nesting at both levels; the runner's entrypoint applies it ([testing](testing.md) §7.4). The result of
  running `just test-e2e` inside the devcontainer must be recorded here once verified.

## 3. Containers-only rule

Every `just` recipe runs its tools in containers; recipes call only `docker`, `git` and POSIX shell
utilities on the host. This keeps the host free of toolchains and makes local runs identical to CI.

Conventions for recipes:

- Tool images are pinned in variables at the top of the `justfile` (§11): `go_image`
  (`golang:1.27.3-trixie`), `node_image` (`node:26.12.1-trixie-slim`), `uv_image`
  (`ghcr.io/astral-sh/uv:0.13.4-python3.14-trixie-slim`), `golangci_image`
  (`golangci/golangci-lint:v2.15.0`), `playwright_image` (`mcr.microsoft.com/playwright:v1.64.1-noble`),
  `alpine_image` (`alpine:3.24`), and the throwaway services of `test-orchestrator-integration`:
  `mongo_image` (`mongo:9.0.4`), `rabbitmq_image` (`rabbitmq:4.4-management`), `rustfs_image`
  (`rustfs/rustfs:1.0.3`), `registry_image` (`registry:3.1.2`), `code_server_image`
  (`codercom/code-server:4.141.0`).
- Invocation pattern: `docker run --rm --init -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" -w /src
  --label scantor.dev=true <cache volumes> <image> <command>`. Running as the invoking user keeps
  generated files owned by the contributor.
- Caches live in named volumes: `scantor-dev-gomod` (`/go/pkg/mod`), `scantor-dev-gobuild`
  (`/tmp/.cache/go-build`), `scantor-dev-npm` (`/tmp/.npm`), `scantor-dev-uv` (`/tmp/.cache/uv`). The
  private recipe `_caches`, a dependency of every tool recipe and run by `just init`, creates missing ones
  (label `scantor.dev=true`) and `chown`s them to the invoking user, so Docker never creates them owned
  by root.
- Recipes that need Docker (integration tests, conformance, images) mount `/var/run/docker.sock` and
  label every container they create (`scantor.test=true` or `scantor.dev=true`).
- Multi-line recipes are `#!/usr/bin/env bash` + `set -euo pipefail` shebang recipes with `==>` progress
  lines. The justfile does not use `dotenv-load`: compose reads `.env` itself, and recipes stay independent
  of local configuration.

## 4. Recipes

`just` with no arguments prints this list (`just --list`).

| Recipe | Description |
|---|---|
| **Setup** | |
| `init` | create or complete `.env` from `.env.example` ([deployment](deployment.md) §8.3): copy it when missing, append every key that `.env` lacks, replace each `-insecure-dev` value written in this run with 48 random hex characters, never change a key that already existed, print the names of added and generated keys (never values); create and own the cache volumes. Idempotent; every recipe that starts a stack runs it first. |
| `deps` | install `node_modules` for `orchestrator/`, `tests/` and `connectors/js/` (`npm ci`, Linux binaries) so editors resolve imports |
| **Dev stack** | |
| `up` | `init`; `docker buildx bake --load dev` (every dev image built from source, tag `dev`, layer-cached, §10); `docker compose -f docker-compose.dev.yml up -d`, which recreates the services whose image changed; wait until the orchestrator container is healthy (polled, not `up --wait`: the first dev start installs `node_modules`, which can outlast the dev orchestrator's healthcheck start period, [deployment](deployment.md) §4.5); print the dashboard, editor and setup URLs (the setup link is read from the orchestrator log) |
| `down` | stop the dev stack (volumes kept) |
| `restart *services` | restart dev services (all when empty) |
| `logs *services` | follow logs of dev services |
| `ps` | show dev services and scantor-managed containers |
| `cli *args` | run the CLI from `scantor:dev` with the shim flags (`SCANTOR_URL`, `SCANTOR_TOKEN` passed through from the shell) |
| `dev-run dir *args` | `scantor dev run <dir> *args` from `scantor:dev` (local mode against the host Docker daemon) |
| `prod-up` | `init`, then `docker compose -f docker-compose.prod.yml pull` and `up -d` ([deployment](deployment.md) §10) |
| **Build** | |
| `build` | build a native `scantor` binary for the host OS and architecture with dev ldflags (`bin/scantor`) in a Go container; the dev stack never uses it |
| `build-images *targets` | `docker buildx bake --load` of `docker-bake.hcl` targets (default: the `dev` group, §10), tagged `:dev` without registry prefix |
| `test-images-save` | `docker save` every image of the `test` bake group into `.test-images/` (CI, §12 of [testing](testing.md)) |
| **Quality** | |
| `lint` | `golangci-lint run` (Go), `ruff check` (Python connector), ESLint (orchestrator with `@nuxt/eslint`, tests, JS connector; `vue/no-v-html` is an error), `tests/scripts/check-terms.mjs`, `tests/scripts/lint-env.mjs`, the `tests/scripts/*.test.mjs` unit tests (`node --test`), `lint-compose` ([testing](testing.md) §11) |
| `lint-compose` | `tests/scripts/lint-compose.mjs`: the infrastructure services are identical in `docker-compose.dev.yml` and `docker-compose.prod.yml`, and the compose security rules of [security](security.md) hold |
| `typecheck` | `nuxt typecheck` (vue-tsc), `tsc --noEmit` for `tests/` and `connectors/js/`, `basedpyright` for `connectors/python/` |
| `fmt` | `golangci-lint fmt` (gofmt + goimports), `ruff format`, `prettier --write` |
| `docs *flags` | regenerate `docs/guide/cli.md` from the cobra command tree (hidden `scantor docs cli`) and refresh guide snippet includes from `tasks/`; `--check` fails when anything is stale |
| **Tests** ([testing](testing.md) §3) | |
| `test *args` | `test-unit`, then `test-e2e *args` |
| `test-unit` | `test-go`, `test-orchestrator`, `test-connectors`, `test-conformance` |
| `test-go *args` | Go unit tests with `-race` |
| `test-go-integration *args` | Go tests tagged `integration` (host Docker socket, host network; the images they use must exist locally, [testing](testing.md) §4.1) |
| `test-orchestrator *args` | vitest unit tests of the orchestrator |
| `test-orchestrator-integration *args` | bake `scantor:dev`, then run the orchestrator's `*.integration.test.ts` ([testing](testing.md) §4.2) in one root `node` container with the Docker socket, `scantor:dev` and its binary, next to throwaway MongoDB, RabbitMQ and RustFS on a private network; every object carries the prefix `scantor-test-orchestrator-it` and is removed afterwards |
| `test-connectors [base]` | connector unit tests in each base image's `test` stage |
| `test-conformance [language]` | connector conformance harness |
| `test-e2e *args` | dockerized Playwright suite on a fresh stack, torn down afterwards (args go to `playwright test`): `docker compose -f docker-compose.tests.yml run --rm --name scantor-test-runner test-runner …` |
| `test-api *args` / `test-ui *args` | `test-e2e --project=api` / `--project=ui` |
| `test-up` | start the test runner in the background with `SCANTOR_TEST_KEEP_ALIVE=true` and return once its fresh stack is up |
| `test-exec *args` | re-run Playwright inside the kept-alive test runner (`docker exec scantor-test-runner scantor-test-playwright …`; the runner writes its Playwright environment to `/etc/profile.d/scantor-test.sh`) |
| `test-down` | stop the kept-alive runner; its teardown removes the inner stack (the cache volumes stay) |
| `test-index *flags` | regenerate the `tests/TESTS.md` index; `--check` fails when stale |
| `test-clean` | remove the test runner, its node_modules volume and its Docker cache volume |
| **Maintenance** | |
| `prune` | stop the dev stack (with `--env-file .env.example` when `.env` is missing); remove containers labelled `scantor.managed=true`, `scantor.dev=true` or `scantor.test=true` (master workers and editors belong to no compose project but hold `scantor-sandbox` and `scantor-editor-sockets`, so they go first); `compose down -v`; remove app-created networks (`scantor.kind=network`) and every network and volume left with the label `com.docker.compose.project=scantor`, and the volumes `scantor-workspaces` and `scantor-editor-home` that the orchestrator creates at boot; delete `bin/` and `.test-images/`. Keeps tool caches, the test cache and images. |
| `purge` | `prune` + `test-clean` + remove the dev cache volumes and every `scantor*:dev` and `scantor*:test` image |
| `registry-gc env="dev"` | stop the orchestrator (the only pusher) of the `dev` or `prod` compose stack, run `registry garbage-collect --delete-untagged /etc/distribution/config.yml` inside `scantor-registry`, start the orchestrator again ([deployment](deployment.md) §14.1) |
| `backup dir` | MongoDB dump plus the volume tars into `dir` (created with mode 0700, files 0600), stopping and starting `rustfs` and `registry` around their tars ([deployment](deployment.md) §12) |
| `deps-outdated` | report outdated dependencies (`npm outdated` per package, `go list -m -u all`, connector constraints) without changing anything |
| **Release** | |
| `release version` | validate `X.Y.Z`, require a clean `main` that equals `origin/main` and an unused tag, create the annotated tag `vX.Y.Z` and push it (§14) |

## 5. Everyday workflows

- **First run**: `just up` (it runs `just init` first); open `http://localhost:3000`; the setup link is in
  `just logs orchestrator` (or set `SCANTOR_ADMIN_EMAIL`/`SCANTOR_ADMIN_PASSWORD` in `.env` for a headless
  first admin).
- **Orchestrator (UI and server)**: the dev orchestrator image (bake target `orchestrator-dev`) runs
  `nuxt dev` with the repository mounted at `/app` ([deployment](deployment.md) §6.2); UI and Nitro edits
  hot-reload. HMR shares port 3000 with the dev server (to verify on Nuxt 4.6 at implementation).
- **Go code**: every dev image is built from source with docker-bake, and no host-built binary is mounted.
  After Go changes run `just up`: bake rebuilds the affected images from cache (`scantor:dev`, the dev
  orchestrator image with its Go build stage, `scantor-editor:dev`) and compose recreates `orchestrator`
  and `node`. New workers and test runs then get the new runtime, because it is injected from the
  binary of the node daemon or the orchestrator.
- **Connectors and base images**: `just build-images base-python` (or `base-js`, `base-go`), or simply
  `just up`; new revisions and test runs use the rebuilt base image, editors pick up a rebuilt editor
  image at their next start.
- **Tasks**: `just dev-run tasks/<example>` runs an example locally; `just cli push tasks/<example>`
  publishes it to the dev stack (create an API key on the "CLI & MCP access" page first).
- **Remote node against the dev stack** (Docker Desktop): point the four public endpoints of `.env` at
  `host.docker.internal` (`SCANTOR_PUBLIC_URL=http://host.docker.internal:3000`, AMQP `:5672`, S3 `:9000`,
  registry `host.docker.internal:5000`) and run `docker compose -f docker-compose.dev.yml up -d`; the
  browser and the CLI keep using `localhost`. Start a privileged `docker:29.9-dind` on its own network
  with `DOCKER_TLS_CERTDIR=` and the dockerd flags `--insecure-registry host.docker.internal:5000 --dns
  <the DNS server of a normal container's /etc/resolv.conf>` (inner containers cannot use the embedded
  DNS that resolves `host.docker.internal`), load the image with `docker save scantor:dev | docker exec -i
  <dind> docker load`, create the node with `scantor nodes create <name> --pool remote` and run the printed
  `dockerRun` inside the DinD container. Restore `.env` afterwards: the registry's token realm follows
  `SCANTOR_PUBLIC_URL`.
- **Data**: mongo-express, the RabbitMQ management UI and the RustFS console are bound to
  `SCANTOR_ADMIN_BIND_ADDRESS` ([deployment](deployment.md)).
- **Tests while developing**: run the narrowest suite first (`just test-go ./internal/taskpipe/...`,
  `just test-orchestrator test/services/query`, `just test-e2e api/scans.spec.ts`); for the dockerized suite
  start a kept-alive stack with `just test-up`, iterate with `just test-exec <spec> [playwright args]` and
  remove it with `just test-down` ([testing](testing.md) §3). Changes to the stack's images or to
  `tests/docker/` need a new stack (`just test-down`, `just test-up`); spec and helper changes do not.

## 6. Go code organization

One module at the repository root (`github.com/lonetis/scantor`, `go 1.27`, `toolchain go1.27.3`); the
overview is in [architecture](architecture.md) §5. The packages:

| Directory | Contents |
|---|---|
| `cmd/scantor/` | `main.go` only (below) |
| `internal/cli/` | the cobra tree, one file per command or group (`init.go`, `validate.go`, `dev.go`, `push.go`, `tasks.go`, `revisions.go`, `scans.go`, `analyses.go`, `exports.go`, `files.go`, `api_uploads.go`, `jobs.go`, `nodes.go`, `templates.go`, `whoami.go`, `version.go`, and the hidden `task.go`, `workspace.go`, `runtime.go`, `node.go`, `conformance.go`, `docs.go`); shared API-command helpers `api_common.go` (waits, retries, hints), `api_input.go` (inline/`@file`/stdin JSON), `api_download.go` (verified downloads); `config.go` (`LoadConfig` of the CLI and the task pipeline), `output.go`, `exitcode.go`, `registry.go` (registration seam), `root.go` |
| `internal/api/` | wire types (`types_*.go`), the typed client (`client.go`, `user.go`, `user_tasks.go`, `node.go`, `runtime.go`, `sse.go`), errors and exit classes (`errors.go`), transport policy (`transport.go`), ISO-ms time and clock offset (`time.go`); `testdata/` holds the [api](api.md) examples the round-trip tests read |
| `internal/node/` | the node daemon ([nodes](nodes.md)), one package: `config.go` (`LoadConfig`), `daemon.go` and `host.go` (start-up, the hello loop, Docker host facts), `session.go` (one registered instance: conflict, unauthorized mode, shutdown, the desired set, Docker events, the worker network), `loops.go` (assignments long-poll, status reports, on-demand log tails, image GC, the egress loop), `reconcile.go` (worker recognition per [security](security.md) LBL-5 and the level-triggered reconcile pass), `actor.go` (the per-worker state machine: pull, create, inject, start, limits, exits, removal), `spec.go`, `validate.go`, `dind.go` (container spec, assignment validation, DinD modes), `images.go` (pulls, image GC), `logs.go` (log tails), `netpol.go` (the egress helper and `egress-apply`), `health.go` (status file, healthcheck, clock offset), `timing.go` (intervals and backoffs that tests shrink), `statfs_*.go` (free disk). Commands: `scantor node`, `node healthcheck` and the hidden `node egress-apply` in `internal/cli/node.go` |
| `internal/runtime/` | the runtime ([runtime](runtime.md) §1.3): the root package holds only shared types (`config.go` with `LoadConfig`, `errors.go` with the classified `Error`, `messages.go` with the AMQP bodies of `schemas/messages/`) and imports none of its sub-packages `bootstrap`, `amqpx`, `pool`, `runner`, `scheduler`, `worker`, `local`, `describe`, `check`, `pipeline`, `scerr`, `logtail`, `upload`, `canonical`, `dind`; `internal/runtime/internal/{fakeapi,fakebroker,fakeconn}` are the test fakes (orchestrator, broker, scripted connector) |
| `internal/taskpipe/` | the task pipeline ([tasks](tasks.md) §9): pack (`pack.go`, `packdir.go`, `packread.go`, `ignore.go`), check-static (`static.go`), build, describe, check and push (`pipeline.go`, `image.go`, `trace.go`, `containerrun.go`, `describe.go`, `push.go`), events and results (`events.go`, `result.go`), local mode for `dev run`/`dev debug` (`local.go`, `localevents.go`); `dockerfile/` holds the Dockerfile policy (D1–D11, W1–W3) and the image-reference rules; `testdata/stubruntime/` is the stub runtime of the integration tests |
| `internal/workspace/` | the workspace helper operations ([editor](editor.md) §9): path rules and caps (`paths.go`, `limits.go`), extract of tar.gz and zip uploads (`extract.go`, `archive.go`), staging and commit (`commit.go`), git (`git.go`), list/read (`browse.go`), write/delete (`files.go`), scaffold rendering (`scaffold.go`), init/purge (`volumes.go`), the pack summary (`pack.go`), events and error codes; its own `LoadConfig` (`config.go`) |
| `internal/templates/` | `registry.go` (`Lookup`, `List`, and the re-exported contract), `core/` (the interface, `Definition`, errors, line trimming), `fetch/` (the HTTP policy of [templates](templates.md) §7.2), one package per template (`single`, `list`, `range` (package `ranges`), `repeat`, `tranco`, `crux`, `cidr`), `templatestest/` (fake upstreams and the fixtures runner) |
| `internal/conformance/` | the conformance harness (`harness.go`, `driver.go`, `exec.go`, `cases.go`, `suite.go`) and `testdata/<language>/<fixture>/` task folders ([protocol](protocol.md) §12) |
| `internal/protocol/` | connector messages, the NDJSON codec, the schema validator, the fd/environment constants of connector processes |
| `internal/container/` | the moby client, managed labels, hardening profiles, runtime injection and binary extraction |
| `internal/manifest/`, `internal/languages/`, `internal/schema/` | `scantor.yaml` parsing and rules M1–M10, the language table, JSON Schema validation with ajv-identical defaults |
| `internal/keys/`, `internal/redact/`, `internal/envconf/`, `internal/version/` | HKDF derivations and the registry signing key, log redaction, the environment value parsers, the build version and `ImageRef` |
| `internal/deps/` | `tools.go` (build tag `tools`), which pins modules before their first import |

Additional conventions:

- `cmd/scantor/main.go` only builds the root command (`cli.NewRootCommand()`), executes it and exits with
  `cli.ExitCode(err)` (0 ok, 1 analysis failures, 2 validation, 3 platform). API errors map to 2 for 4xx
  except 408, 426 and 429, and to 3 for those, 5xx, network errors and anything unclassified. A failed
  command prints `Error: <message>` to stderr, or with `-o json` one document `{"error": {code, message,
  exitCode, status?, details?, requestId?}}` (flag and argument errors that cobra reports before the
  command runs stay plain text).
- `internal/version` holds `Version`, `Commit` and `ImagePrefix`, set with `-ldflags -X` (dev builds:
  `Version=dev`, `ImagePrefix=""`; releases: the tag and `ghcr.io/lonetis/`). Image references of base
  images and the scantor image follow [architecture](architecture.md) §4.2: the compiled-in pair is the
  default, and `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG` replace it whenever `SCANTOR_IMAGE_TAG` is
  non-empty (the orchestrator passes its own values to every `scantor task …` subprocess). One function,
  `version.ImageRef(image, override)`, applies the rule, where `override` is the
  `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG` pair (`version.ImageOverride`) read by the component's
  `LoadConfig`; nothing else builds image references.
- `internal/envconf` holds the shared parsers for the environment value syntax of
  [architecture](architecture.md) §10 (durations, byte sizes, booleans, lists). Each component has exactly
  one `LoadConfig` that reads every variable it uses: `internal/cli` and `internal/workspace` take
  `getenv func(string) string`, `internal/runtime` takes `getenv` plus the process environment (the
  passthrough of connector processes, [runtime](runtime.md) §3.4), and `internal/node` takes `lookup
  func(string) (string, bool)` (`os.LookupEnv`); like every loader it treats an empty value as unset.
  Only `internal/cli` passes `os.Getenv`,
  `os.LookupEnv` or `os.Environ()` in; no other package reads the environment (test fakes such as
  `fakeconn` and `stubruntime` aside, which read their own control variables). The CLI reads its
  credentials only from `SCANTOR_URL`/`SCANTOR_TOKEN`; its other variables (CA, mode selectors, image and
  data-source overrides, the per-component table of [architecture](architecture.md) §10) are listed in the
  CLI section of `.env.example`. Inside a container (both `/.dockerenv` exists and `host.docker.internal`
  resolves, as with the shim's `--add-host`) the CLI rewrites a loopback host in `SCANTOR_URL` to
  `host.docker.internal`; otherwise the URL is kept. The shim (`scantor.sh`, also behind `just cli` and
  `just dev-run`) maps that name to the host gateway on Docker Desktop; on a Linux Docker Engine, including
  the devcontainer's Docker-in-Docker, it runs the CLI container with `--network host` and maps the name to
  `127.0.0.1`, because the gateway address does not reach the dev stack's ports on `127.0.0.1`
  ([architecture](architecture.md) §4.2).
- Dependency direction: `cli` → domain packages (`node`, `runtime`, `taskpipe`, `workspace`, `templates`,
  `conformance`) → shared packages (`api`, `protocol`, `manifest`, `languages`, `schema`, `container`,
  `keys`, `redact`, `envconf`, `version`). No package imports `cli`; no import cycles; `internal/api` holds
  the wire types, the typed HTTP client and the transport policy used by the CLI, the node daemon and the
  runtime; `internal/redact` is the only log redactor of the Go roles (`redact.NewLogger` builds every
  role's `slog` logger).
- CLI command tree: one cobra command per file in `internal/cli`, registered from that file's `init()`
  with `registerCommand(parent, build)` (and the idempotent `registerGroup(parent, name, short, hidden)`
  for groups such as `scans`), so adding a command never edits `root.go`; `build` receives the `*App`
  (configuration, output, API client, Docker client, logger). Public commands are listed in
  [architecture](architecture.md) §4.2 and in the generated `docs/guide/cli.md`. Hidden commands and
  groups (`Hidden: true`, or `registerGroup(…, true)`; absent from `--help` and from `docs/guide/cli.md`):
  `scantor task pack | check-static | build`, `scantor workspace …`, `scantor runtime …`, `scantor node
  egress-apply`, `scantor conformance` (plus `scantor conformance exec`, [protocol](protocol.md) §12) and
  `scantor docs cli` (writes `docs/guide/cli.md` and refreshes the `<!-- scantor:include -->` blocks of
  `docs/guide/*.md`, used by `just docs`).
- No language switch anywhere: language-specific behaviour comes from `schemas/languages.json` and the base
  image ENV contract ([architecture](architecture.md) §4.2).
- Errors: wrap with context (`fmt.Errorf("pull %s: %w", ref, err)`), compare with `errors.Is/As`; errors
  that end a CLI command carry their exit class; never discard an error silently.
- Logging: `log/slog` JSON with correlation attributes (`scanId`, `workerId`, `nodeId`, `analysisId`,
  `executionId`), to stdout in the node daemon and to stderr in the runtime (its stdout is reserved for
  NDJSON events in local, describe and check modes, [runtime](runtime.md) §13.2); human-readable output in
  the CLI unless `-o json`.
- Every blocking operation takes a `context.Context`; goroutines have an owner that cancels and waits.
- Docker access only through `github.com/moby/moby/client` wrapped by `internal/container` (runtime
  injection, managed labels, hardening profile). `github.com/docker/docker` is forbidden (golangci
  `depguard`).
- `embed.go` (package `scantor` at the root) exposes `Schemas`, `Scaffolds` (`all:scaffolds`, so dot
  files are included) and `Guides` (`embed.FS`); scaffold `go.mod`/`go.sum` are stored as
  `go.mod.tmpl`/`go.sum.tmpl` (`go:embed` skips directories that contain a `go.mod`) and renamed on
  render. The example tasks under `tasks/` are not embedded and keep real `go.mod`/`go.sum`.
- Tests: §4.1 of [testing](testing.md). `.golangci.yml` enables `errcheck`, `govet`, `staticcheck`,
  `unused`, `ineffassign`, `gosec`, `depguard`, `misspell` and the `gofmt`/`goimports` formatters.

## 7. Orchestrator code organization

```
orchestrator/
├── nuxt.config.ts, package.json, package-lock.json, tsconfig.json, eslint.config.mjs, vitest.config.ts,
│   Dockerfile, Dockerfile.dockerignore
├── app/                          UI ([ui](ui.md) §2): pages/, components/, composables/, layouts/, middleware/
│                                 (auth.global), plugins/ (api), utils/, assets/, app.vue, app.config.ts
├── server/
│   ├── api/<tag>/…               one file per method; path segments mirror the API path
│   ├── routes/                   mcp.ts (/mcp), .well-known/[...path].ts (never editor routes: the editor origin is
│   │                             its own listener)
│   ├── middleware/               ordered by prefix (auth §1): 00.request (request id, x-scantor-client-ip,
│   │                             421 for the editor host), 01.path (400 for non-canonical paths, auth §5.5),
│   │                             02.body-limit, 10.auth (prefixes, principals, operation registry, scopes,
│   │                             bans, CSRF), 11.passkey-guard
│   ├── plugins/                  Nitro plugins in file-name order: 00.boot (resets the registries, registers the
│   │                             foundation boot steps, architecture §4.1), 10.components (foundation component
│   │                             tasks: the jobs runners, userPurge), 20–89 domain plugins that only register
│   │                             (boot steps, component tasks, job kinds, userPurge steps, lockout hooks; never
│   │                             I/O at load): 20.editor-listener (editor origin on container port 3001,
│   │                             editor §8.1), 30.tasks, 40.scans, 50.results, 60.nodes (also registry and
│   │                             runtime), 70.editor (reaper, purge step, lockout hook); 99.start (runs the boot
│   │                             steps in order, then starts the SCANTOR_COMPONENTS); security-headers.ts (the
│   │                             security headers of every response in Nitro's request hook, which runs before
│   │                             the public assets, and the per-response CSP nonce, ui §13); openapi.ts (narrows
│   │                             /api/docs/openapi.json to the API operations, api §1.1)
│   ├── services/<area>/          domain logic (mappers turn documents into API representations): account,
│   │                             analyses, catalog, configs, credentials, editor, exports, helpers, ingestor, jobs,
│   │                             mcp, metrics, nodes, pipeline, placement, query, reconciler, registry, revisions,
│   │                             runtime, scans, setup, tasks, test-runs, tools, uploads, users; inflight.ts (the
│   │                             in-memory in-flight store fed by runtime state polls)
│   ├── types/                    documents.ts (MongoDB document types including internal fields, server-only),
│   │                             openapi.ts (route-meta typing with the x-scantor extensions)
│   └── utils/                    foundation seams and clients: config (the only process.env reader), env-values,
│                                 startup-guard, errors, error-handler, zod (validate helpers), pagination, serialize,
│                                 auth and auth-policy (better-auth instance), principal, operations (operation
│                                 registry), authz (ownership helpers), internal-auth, node-tokens, worker-tokens,
│                                 users, user-cache, setup, keys, secrets, redact, logger, mongo, s3, amqp,
│                                 rabbitmq-management, docker, labels (reads schemas/managed-labels.json), boot
│                                 (registerBootStep, registerComponentTask), jobs (registerJobKind, createJob),
│                                 user-purge (registerUserPurgeStep), locks, wait (long-polls) and
│                                 wait-watchers (their change streams, one per collection), health,
│                                 instance and instance-info, version, client-ip, cors, body-limits,
│                                 security-headers, guides and guide-assets
├── shared/
│   ├── types/<area>.ts           API representations ([api](api.md) §2), used by server, UI and tests;
│   │                             types/augments/route-meta.d.ts types defineRouteMeta
│   ├── schemas/<area>.ts         zod request schemas (bodies, queries, params)
│   └── utils/                    error-codes (code → HTTP status, UI title), enums, scan-actions, slug rules
└── test/                         vitest: services/ and utils/ mirror server/ (testing §1), shared/, ui/ (pure
                                  app/utils code), helpers/ (fake collection, repository paths); setup.ts
                                  silences the loggers; *.integration.test.ts files are opt-in (testing §4.2)
```

Route conventions:

| File | Route | operationId |
|---|---|---|
| `server/api/scans/index.get.ts` | `GET /api/scans` | `listScans` |
| `server/api/scans/index.post.ts` | `POST /api/scans` | `startScan` |
| `server/api/scans/[scanId]/index.get.ts` | `GET /api/scans/{scanId}` | `getScan` |
| `server/api/scans/[scanId]/index.delete.ts` | `DELETE /api/scans/{scanId}` | `deleteScan` |
| `server/api/scans/[scanId]/pause.post.ts` | `POST /api/scans/{scanId}/pause` | `pauseScan` |

- Bracket names equal the OpenAPI parameter names (`[task]`, `[revision]`, `[scanId]`, `[analysisId]`,
  `[fileId]`, …). Static segments (`upload`, `import-git`) win over parameters.
- The first statement is `defineRouteMeta({ openAPI: { … } })` with a static object literal of plain
  literals only ([api](api.md) §1.1: no negative numbers, template literals or strings with both quote
  kinds; `test/api/route-meta.test.ts` checks it): tag,
  `operationId`, `summary`, a `description` written for an AI agent, parameters, request body, responses
  (errors `$ref: '#/components/schemas/Error'`), `x-scantor-scope`, `x-mcp`, and `x-admin-only` /
  `x-read-only` when true.
- Handlers are thin:

```ts
defineRouteMeta({ openAPI: { tags: ['scans'], operationId: 'pauseScan', summary: 'Pause a scan',
  description: 'Stops consuming analyses …', 'x-scantor-scope': 'owner', 'x-mcp': true, /* … */ } })

import { scanIdParams } from '#shared/schemas/scans'

export default defineEventHandler(async (event) => {
  const user = requireUser(event)                              // principal for scope "owner"
  const { scanId } = await validateParams(event, scanIdParams) // 400 validationFailed
  const scan = await loadOwnedScan(user, scanId)               // 404 when missing or not owned
  return toApiScan(await scanService.pause(scan, user))        // intent only; 409 invalidState
})
```

- `validateBody/Query/Params(event, schema)` (`server/utils/zod.ts`, strict objects) turn failures into
  `validationFailed` with `details.issues`; `apiError(code, message, details?)` takes the HTTP status from
  the shared error-code table; nothing else throws HTTP errors. Ownership helpers (`requireUser`,
  `loadOwned`, `loadOwnedScan`, `ownerFilter`, …) are those of [auth](auth.md) §9.
- Handlers record intent and create jobs; long work runs in services started by the reconciler or the jobs
  runner ([architecture](architecture.md) §4.1). Request objects never go into MongoDB filters.
- Services take their dependencies explicitly (collections, clients, clock) so vitest can test them
  without Nitro.
- `server/utils/config.ts` parses every variable at boot with zod; invalid security-relevant values abort
  startup.
- Shared types are the only DTO definitions; the UI and the tests import them (type-only in tests).

## 8. Connectors, scaffolds, schemas and examples

| Directory | Contents | Rules |
|---|---|---|
| `connectors/python/` | `pyproject.toml`, `src/scantor/` (public modules, private `_*.py` protocol internals, `templates/` proxies, `serve.py` and `check.py` behind the base image's commands), `tests/` (with `fixtures/` and a fake-runtime harness), `constraints.txt` (pinned, used as `PIP_CONSTRAINT` in the base image), `Dockerfile` (stages `wheel`, `base`, `test`), `Dockerfile.dockerignore` | snake_case API; `ruff` + `basedpyright` clean |
| `connectors/js/` | `package.json` (`@scantor/connector`; every export has a `scantor-source` condition pointing at `src/`), `src/*.ts` (with `src/templates/` proxies), `serve.js` and `check.js` (the entry files of `SCANTOR_CONNECTOR_CMD`/`SCANTOR_CHECK_CMD`), `tsconfig.json` (type check) and `tsconfig.build.json` (`dist/`), `test/` (with `fixtures/`, `helpers/`, `typing/`), `check-tools/` (the root `/node_modules` of the base image: typescript, @types/node), `Dockerfile`, `Dockerfile.dockerignore` | re-exports `z`; TypeScript ~6.0.3 for type checks. Tests run `src/*.ts` through Node 26 type stripping with `node --conditions=scantor-source`; the installed package ships `dist/` compiled by `tsc` (`npm run build`, also the `prepare` script) and its `package.json` drops the `scantor-source` condition, because Node does not strip types under `node_modules` ([tasks](tasks.md) §5.7). `dist/` is a build output, never edited. The `test` stage also covers the TS/JS examples, scaffolds and guides. |
| `connectors/go/` | separate module `github.com/lonetis/scantor/connectors/go`, package `scantor` (`serve.go`, `conn.go`, `handlers.go`, `schema.go`, `validate.go`, `version.go`, …), `templates/<name>/` proxies (`templates/range` is package `ranges`) sharing `internal/proxy/`, `scantor-go-check` (the base image's `SCANTOR_CHECK_CMD`), `Dockerfile` (stages `base`, `test`), `Dockerfile.dockerignore` | depends only on the standard library and pinned schema libraries (invopop/jsonschema) |
| `scaffolds/<language>/` | task starter templates rendered by `scantor workspace scaffold` / `scantor init` | output publishes unchanged; ships `.devcontainer/`, `.vscode/`, `.dockerignore`, `.gitignore`, `AGENTS.md` |
| `schemas/` | `task-manifest.schema.json`, `describe.schema.json`, `languages.json`, `managed-labels.json`, `protocol/*.json`, `messages/*.json`, `templates/<name>.json` + `<name>.fixtures.json` | canonical; Go and TS read them, never copy them |
| `tasks/` | example tasks | together they cover every language and every template; each has an entry in `tests/e2e/examples.ts` |

The connector API, the protocol and templates are specified in [tasks](tasks.md), [protocol](protocol.md)
and [templates](templates.md).

## 9. Checklists for common changes

### 9.1 Add an API route

1. Choose the tag, `operationId` (camelCase, verb first), path and scope (`x-scantor-scope`). Decide
   `x-mcp`: default `false`; `true` only for operations an agent needs in the authoring or scan loop,
   keeping the total ≤ 30. Set `x-admin-only` iff scope is `admin`; `x-read-only` for side-effect-free POSTs.
2. Add the representation to `shared/types/<area>.ts` and the request schema to `shared/schemas/<area>.ts`.
3. Create `server/api/<path>.<method>.ts` with `defineRouteMeta` first, then the thin handler (§7).
   Long-running work becomes a job; ownership through `loadOwned`; status codes per [api](api.md) §1.6.
4. Update [api](api.md) (route table, representation, errors) and, when MCP-exposed, [mcp](mcp.md)
   (tool list, untrusted-data wrapping, response size).
5. If MCP-exposed, update the expected tool set in `tests/mcp/tools.spec.ts`; check the tool description
   reads well for an agent.
6. Add a request factory for the operation to `tests/authz/requests.ts` (the authorization matrix fails
   without it), API tests in `tests/api/<tag>.spec.ts`, FEATURES.md lines and tags; UI tests if the UI
   uses it.
7. If users need it from the terminal, add the CLI command (`internal/api` client method +
   `internal/cli` command) and regenerate `docs/guide/cli.md` with `just docs`.
8. `just lint typecheck test-orchestrator`, the relevant e2e specs, `just test-index`.

### 9.2 Add a language

1. **Connector**: `connectors/<base>/` with the typed definition API, error helpers, template proxies for
   every template in `schemas/templates/`, and a `Dockerfile` with a `base` stage (toolchain + connector at
   a well-known path, ENV contract `SCANTOR_LANGUAGE`, `SCANTOR_CONNECTOR_CMD`, `SCANTOR_CHECK_CMD`,
   `SCANTOR_DEBUG_CMD`, `SCANTOR_DEBUG_PORT`, `WORKDIR /task`, dependency isolation) and a `test` stage.
   A language that reuses an existing base (as TypeScript and JavaScript share `js`) skips this step.
2. **Language table**: one row in `schemas/languages.json` (language, title, base, default entry, file
   extensions). No code anywhere switches on language names.
3. **Conformance**: fixture tasks in `internal/conformance/testdata/<language>/` for every case;
   `just test-conformance <language>` passes.
4. **Scaffold**: `scaffolds/<language>/` with every template variant and the editor files; the
   embedded-scaffold completeness test and the scaffold matrix cover it automatically.
5. **Editor and devcontainer**: toolchain, language server, debugger and connector at the well-known path in
   the `toolchain` stage of `editor/Dockerfile`; the extension in the editor settings and in
   `.devcontainer/devcontainer.json`; a link line in `.devcontainer/post-create.sh`.
6. **Images and CI**: a `base-<base>` (and `base-<base>-test`) target in `docker-bake.hcl`; CI matrices read
   `languages.json`, so no workflow edit is needed.
7. **Example**: at least `echo` in `tasks/` plus its entry in `tests/e2e/examples.ts`.
8. **Debugging**: `SCANTOR_DEBUG_CMD`/`SCANTOR_DEBUG_PORT` in the base image and a launch configuration in
   the scaffold.
9. **Docs**: `docs/guide/authoring-<language>.md`, language notes in [tasks](tasks.md), the README features
   list, CLAUDE.md.

### 9.3 Add a template

1. Canonical schema `schemas/templates/<name>.json` (title, description, scan config and analysis config
   schemas, example, whether it resolves non-deterministic inputs) and `schemas/templates/<name>.fixtures.json`
   (scan configs with expected analysis configs, expected totals and resolutions).
2. Go implementation `internal/templates/<name>/` implementing the template interface of
   [templates](templates.md) (resolve, estimate, stream) and its registration in the single template
   registry; unit tests over the fixtures and a determinism test.
3. If it fetches external data: a base URL variable `SCANTOR_<NAME>_URL` (§9.5), passed to schedulers in
   bootstrap `scheduler.dataSources`, honoured by the CLI's local mode, and fixture data in
   `tests/docker/fixtures/` served at exactly the upstream endpoint paths of [templates](templates.md).
4. Typed proxies in every connector (models matching the canonical schema exactly; conformance compares
   them), the `template-<name>` conformance fixture in every language, and the template variant in every
   scaffold.
5. An example in `tasks/` that uses it, with its entry in `tests/e2e/examples.ts` (the examples together
   cover every language and every template); the scaffold matrix picks the template up automatically.
6. Docs: [templates](templates.md), `docs/guide/templates.md`.

### 9.4 Add a UI page

1. Create `app/pages/<path>.vue` with `definePageMeta` (`auth: false` for public pages, `admin: true` for
   admin pages) and `useHead({ title: '<Page> · scantor' })`.
2. Render one `UDashboardPanel` (`#header` with `UDashboardNavbar`, `UDashboardSidebarCollapse`, a
   "Refresh" button when the page polls; `#body` with the content).
3. Load data with `useApiFetch`/`useCursorList` and poll with `usePoll` at the intervals of [ui](ui.md) §9;
   forms use `UForm` with a zod schema from `#shared/schemas`.
4. Give every icon-only button an `aria-label`, use `ConfirmModal` or a two-step button for destructive
   actions, and colors/labels from `app/utils/status.ts`.
5. Add a sidebar item in `app/utils/navigation.ts` when the page is top-level.
6. Update [ui](ui.md) (route map and page section), FEATURES.md, and add a UI spec with tags.

### 9.5 Add an environment variable

1. Add it to `.env.example` in the right section with its default and a short description (and how to
   obtain it, for secrets and tokens). Secrets get an `-insecure-dev` default. CLI variables (credentials,
   mode selectors) go in the "CLI" section; a variable the CLI shares with another component stays in that
   component's section (a key appears once) and is named in the CLI section's header comment. Test-only
   `SCANTOR_TEST_*` variables go in "Tests". `tests/scripts/lint-env.mjs`
   fails when code reads a variable that `.env.example` lacks.
2. Parse it in the component's single config loader (`server/utils/config.ts` or the Go `LoadConfig`),
   using the shared value syntax.
3. Pass it through in the compose files when a container needs it, as plain `${VAR}` without a default
   ([deployment](deployment.md) §2).
4. Refer to it by name in docs, never with its default or description.

Build parameters of `docker-bake.hcl` (§10) are not environment configuration and are documented only in
this file.

## 10. Images (`docker-bake.hcl`)

All images are defined once in `docker-bake.hcl` at the repository root and built by `just
build-images`, by the test runner and by CI.

| Target | Dockerfile (target) | Image name |
|---|---|---|
| `scantor` | `Dockerfile` | `${IMAGE_PREFIX}scantor:${IMAGE_TAG}` |
| `orchestrator` | `orchestrator/Dockerfile` (final stage) | `${IMAGE_PREFIX}scantor-orchestrator:${IMAGE_TAG}` |
| `orchestrator-dev` | `orchestrator/Dockerfile` (`dev`) | `scantor-orchestrator-dev:${IMAGE_TAG}` (= `scantor-orchestrator-dev:dev`, never pushed) |
| `editor` | `editor/Dockerfile` (`editor`) | `${IMAGE_PREFIX}scantor-editor:${IMAGE_TAG}` |
| `base-python`, `base-js`, `base-go` | `connectors/<base>/Dockerfile` (`base`) | `${IMAGE_PREFIX}scantor-base-<base>:${IMAGE_TAG}` |
| `base-python-test`, `base-js-test`, `base-go-test` | `connectors/<base>/Dockerfile` (`test`) | `scantor-base-<base>:test` (never pushed) |
| `test-runner` | `tests/docker/Dockerfile` | `scantor-test-runner:dev` (never pushed) |
| `test-fixtures` | `tests/docker/fixtures/Dockerfile` | `scantor-test-fixtures:dev` (never pushed) |

Groups: `default` (the six platform images), `dev` (`scantor`, `orchestrator-dev`, `editor`,
`base-python`, `base-js`, `base-go`; used by `just up`), `test` (`default` + `test-fixtures`; built inside
the test runner or on the CI host, never next to a dev stack), `connector-tests`. `release` is a matrix
target (a group cannot set platforms) that expands to `release-<target>` for each image of `default`, with
`platforms = ["linux/amd64", "linux/arm64"]`; CI builds each `release-<target>` per architecture on a
native runner (§14). The platform images carry the OCI labels `org.opencontainers.image.source`,
`version` and `revision`. `orchestrator-dev` has its own image name
(`scantor-orchestrator-dev`), so it never collides with the production-style `scantor-orchestrator:dev`
that the `default` and `test` groups build for the test runner ([deployment](deployment.md) §3).

- Every build uses the repository root as context. Each Dockerfile outside the root filters that context
  with its own allowlist `<Dockerfile>.dockerignore` (`orchestrator/`, `editor/`, `connectors/<base>/`):
  BuildKit reads this file next to the Dockerfile instead of the root `.dockerignore`, and never a
  `.dockerignore` in a subdirectory. The root `.dockerignore` (secrets, `.git`, dependency trees, build
  outputs) serves the root `Dockerfile`.
- The orchestrator image copies `schemas/` and `docs/guide/` in as Nitro server assets (base names
  `schemas` and `guide`, [mcp](mcp.md) §6) and builds the `scantor` binary in its own Go stage; the `dev`
  target adds the Node toolchain for `nuxt dev` and expects the source mounted at `/app`
  ([deployment](deployment.md) §6.2). The editor image also builds its `scantor` binary in its own Go
  stage, so no image build depends on another (no named contexts).
- The `scantor` image runs as root by default, because the node daemon needs the Docker socket; workspace
  helpers and editors set their uid (`1000:1000`) explicitly ([editor](editor.md) §3).

Bake variables `IMAGE_PREFIX` (default empty), `IMAGE_TAG` (default `dev`), `VERSION` (default `dev`) and
`COMMIT` are build parameters set by `just` and CI, not runtime configuration, so they are documented only
here and never in `.env.example`. `VERSION`, `COMMIT` and `IMAGE_PREFIX` become build args (ldflags for the
Go binary, the orchestrator's reported version, the connectors' reported version); the orchestrator build
hands `VERSION` to Nitro's build-time replacement through the build environment variable `BUILD_VERSION`.

## 11. Versions and dependency policy

Pins (researched 2026-10-21; update this table in the same commit as any bump):

| Area | Pin |
|---|---|
| Node | 26.12.1 (`node:26.12.1-alpine3.24` for the orchestrator images, `node:26.12.1-trixie-slim` for tools, `scantor-base-js` and the editor toolchain); never `lts` tags |
| Orchestrator | nuxt ^4.6.2, @nuxt/ui ^4.12.0, tailwindcss ^4.3.3, **typescript ~6.0.3**, vue-tsc ^3.3.13, @vueuse/core ^14.4.0, better-auth 1.7.12 with every `@better-auth/*` package at the same version, zod ^4.6.7, ajv ^8.20.0 with ajv-formats ^3.0.1 (server), @cfworker/json-schema ^4.1.1 (browser forms, [ui](ui.md) §6.1), mongodb ^7.7.0, amqplib ^2.2.0, @aws-sdk/client-s3, s3-request-presigner and lib-storage ^3.1155.0 (lockstep), dockerode ^5.0.1, @modelcontextprotocol/server ^2.3.1, mcp-from-openapi ^2.9.1, yaml ^2.9.1, @iconify-json/lucide ^1.2.147, h3 ^1.15.11, tar-stream ^3.2.2, nanoid ^6.0.2, vitest ^5.0.5, eslint ^10.13.0, @nuxt/eslint ^1.17.0, prettier ^3.9.10 (`tests/` and `connectors/js/` use the same versions when they add ESLint and Prettier) |
| Tests | @playwright/test **1.64.1 exact** = `mcr.microsoft.com/playwright:v1.64.1-noble`, @modelcontextprotocol/client ^2.3.1 |
| Go | go 1.27 / toolchain go1.27.3, the same patch level in every `golang:` image (`golang:1.27.3-alpine3.24` builds the binaries of the scantor and orchestrator images and the test fixtures server, `golang:1.27.3-trixie` the editor, the Go base image, the test runner's CLI, the recipes and `release.yml`); github.com/moby/moby/client **v0.6.2 exact** + moby/api v1.56.1; amqp091-go v1.16.0; cobra v1.10.2; invopop/jsonschema v0.14.0; santhosh-tekuri/jsonschema/v6 v6.0.3; aws-sdk-go-v2 service/s3 v1.114.4; go.yaml.in/yaml/v3 v3.0.5; golang.org/x/sync v0.24.0; github.com/moby/buildkit v0.34.1 (Dockerfile parser of `internal/taskpipe`); github.com/moby/patternmatcher v0.6.1 (`.dockerignore` semantics of `task pack`); delve v1.27.2; gopls v0.24.0; golangci-lint v2.15.0 |
| Python | 3.14 base images; pydantic >=2.14,<3; debugpy >=1.8.22; pytest >=9.1; pytest-asyncio >=1.4; ruff >=0.17.1 (`just lint`/`fmt` run `uvx ruff@0.17.1`); basedpyright 1.40.2; uv 0.13.4 |
| Base images | `scantor-base-python` ships basedpyright 1.40.2 (its `SCANTOR_CHECK_CMD`); `scantor-base-js` ships typescript ~6.0.3 and @types/node at `/node_modules` (its check command); zod stays nested inside `@scantor/connector`, so user code imports the re-exported `z` ([tasks](tasks.md)) |
| Infrastructure images | `rabbitmq:4.4-management`, `mongo:9.0`, `mongo-express:1.0.2-20-alpine3.19`, `rustfs/rustfs:1.0.3`, `registry:3.1.2`, `traefik:v3.7`, `codercom/code-server:4.141.0`, `docker:29.9-dind` (tests) |
| Editor extensions | Open VSX, pinned in `editor/extensions.txt` ([editor](editor.md) §2.2): ms-python.python 2026.4.0 with its pack members ms-python.debugpy 2026.6.0 and ms-python.vscode-python-envs 1.40.0, detachhead.basedpyright 1.40.2, charliermarsh.ruff 2026.88.0, golang.go 0.58.0, redhat.vscode-yaml 2.0.0, dbaeumer.vscode-eslint 3.0.34 |
| Tools | just 1.59.0; GitHub Actions majors: checkout@v7, cache@v6, upload-artifact@v7, download-artifact@v8, setup-buildx-action@v4, setup-qemu-action@v4, login-action@v4, metadata-action@v6, build-push-action@v7, bake-action@v7, setup-just@v4, golangci-lint-action@v9 |

Rules:

- **TypeScript stays on 6.0.x**: TypeScript 7 (the native port) ships no `lib/tsc.js`, which vue-tsc
  requires. Move to 7 only after `nuxt typecheck` is verified on it; the whole repository uses one
  TypeScript version.
- Exact pins where drift breaks things: `@playwright/test` (must equal the runner image tag), pre-1.0 Go
  modules (`moby/moby/client`), better-auth and its plugins (one version), tool images in the justfile.
- npm dependencies use caret ranges plus a committed `package-lock.json`, installed with `npm ci`; Go uses
  `go.sum`; the Python connector uses `constraints.txt`. No `.npmrc` with `legacy-peer-deps`.
- Never use floating `latest`/`lts` tags for images; pin at least the minor version.
- Do not use: `github.com/docker/docker` (frozen; enforced by depguard), `@types/amqplib` (amqplib ships
  types), `zod-to-json-schema` (zod 4 has `z.toJSONSchema`), `gopkg.in/yaml.v3` (use `go.yaml.in/yaml/v3`),
  `@modelcontextprotocol/sdk` 1.x.
- Version requirements that are design constraints: RabbitMQ ≥ 4.4 (quorum-queue delayed delivery), MongoDB
  replica set (transactions, change streams), Node ≥ 22.19 (mcp-from-openapi; we use 26), Docker Engine ≥ 25
  (API 1.44) on remote nodes with 29 tested ([nodes](nodes.md) §2; classic and containerd image stores,
  [nodes](nodes.md) §10.1), Docker Engine ≥ 29 on the master ([deployment](deployment.md) §10).
- Bumps: one area per commit (`build(deps): 🏗️ bump nuxt to 4.7.0`), with lockfiles regenerated in a
  container and the full `just test`. A Playwright bump changes `tests/package.json`, the lockfile and the
  runner's base image tag together; a Go toolchain bump changes `go.mod`, every `golang:` tag and the editor
  toolchain together.
- `just deps-outdated` once a month; security fixes immediately.
- Not pinned yet (pin when first added and record in the table above): the runner's
  `openssl`/`libnss3-tools` packages.

## 12. Commit conventions

Conventional Commits 1.0.0 with an emoji after the colon (the maintainer's global convention):

```
<type>[(scope)][!]: <emoji> <description>

[body, wrapped at ~72 characters]

[footers]
```

| Type | Emoji | Use |
|---|---|---|
| `feat` | ✨ | new feature |
| `fix` | 🐛 | bug fix |
| `docs` | 📝 | documentation |
| `style` | 🎨 | formatting only |
| `refactor` | ♻️ | restructuring without behaviour change |
| `perf` | ⚡️ | performance |
| `test` | ✅ | tests |
| `build` | 🏗️ | build system, dependencies, Dockerfiles, bake |
| `ci` | 👷 | workflows |
| `chore` | 🧹 | maintenance |
| `revert` | ⏪ | revert |

- Type lowercase; optional lowercase scope; description imperative, starting lowercase, no trailing
  period; natural capitalisation only (OAuth, MCP, CLI, WebAuthn).
- Scopes used in this repository: `api`, `ui`, `auth`, `mcp`, `ingestor`, `reconciler`, `placement`,
  `jobs`, `editor`, `cli`, `node`, `runtime`, `taskpipe`, `workspace`, `templates`, `protocol`,
  `connector-python`, `connector-js`, `connector-go`, `scaffolds`, `schemas`, `examples`, `compose`,
  `images`, `tests`, `deps`, `docs`.
- Breaking changes: `!` before the colon and a `BREAKING CHANGE: <what breaks and how to migrate>` footer.
  Issue references in footers (`Fixes #123`).
- Commits authored or co-authored by an AI agent add `Co-authored-by: <agent> <noreply@…>`.
- Separate tasks get separate commits; one cohesive change (route + service + types + tests + docs) is one
  commit. When in doubt, commit more often.

Examples: `feat(api): ✨ add retry-failed for cancelled scans`, `fix(ingestor): 🐛 ack duplicates on
E11000`, `build(deps): 🏗️ bump better-auth to 1.7.13`, `test(chaos): ✅ add remote node partition case`.

## 13. Documentation maintenance

| File | Audience and rules |
|---|---|
| `README.md` | users only, concise: short intro, features, getting started (configuration → `.env.example`, development → `docker-compose.dev.yml`, production → `docker-compose.prod.yml`), links to `docs/guide/`. No internals, no project structure, no environment variable descriptions. |
| `CLAUDE.md` | the internal index: project structure, tech stack, design decisions, conventions, and a plain-path link (no `@` imports) to every `docs/*.md`. Updated with every structural change, new component, design decision or convention. |
| `docs/*.md` | internal specifications ([architecture](architecture.md), [data model](data-model.md), [api](api.md) are the backbone and win on conflicts). Each starts with a purpose paragraph, uses the glossary terms exactly, links other docs relatively, records new decisions in a "Decisions" section and ends with "Future extensions". Never documents environment variable defaults. |
| `docs/guide/*.md` | user guides (authoring per language, templates, manifest, errors and retries, CLI reference generated by `just docs`, MCP and agents, remote nodes). Embedded into the binary and the orchestrator image and served over MCP; code snippets are included from `tasks/` (a fenced block with the file's exact content between `<!-- scantor:include <path> -->` and `<!-- scantor:include:end -->`) and refreshed by `just docs`; the drift test checks referenced tools and commands. There is one `authoring-<language>.md` per row of `schemas/languages.json` (including `authoring-javascript.md`, which may point to the TypeScript guide). `mcp.md` contains the section between `<!-- scantor:mcp-instructions:start -->` and `<!-- scantor:mcp-instructions:end -->` (≤ 8 KiB) that becomes the MCP server instructions ([mcp](mcp.md) §6). |
| `.env.example` | the only documentation of environment variables: every variable with its default and a short description, grouped in sections (including "Remote node", "CLI" and "Tests"), with instructions for obtaining secrets and tokens. |
| `tests/FEATURES.md`, `tests/TESTS.md` | behaviour inventory and generated test index ([testing](testing.md) §10). |
| `skills/` | thin agent skills that point to MCP guide tools and `docs/guide/`; checked by the drift test. |

Every change that alters behaviour, structure, configuration or a convention updates the affected docs in
the same commit: `README.md` for user-visible features, `CLAUDE.md` for structure and conventions,
`docs/*.md` for internals, `.env.example` for variables, FEATURES.md and the generated TESTS.md for tests.

## 14. Release process

Versioning: SemVer on the repository tag `vX.Y.Z` (module version, image tags, binary version). MAJOR for
breaking changes of the user API, CLI, manifest or connector protocol beyond the supported N−1 window;
MINOR for features (orchestrator, node daemons and runtimes interoperate within the same or previous
minor, [api](api.md) §1.10); PATCH for fixes. No version numbers are edited in files: builds inject them.

```
just release 1.5.0
  └─ checks: semver, on main, clean tree, main == origin/main, tag absent
  └─ git tag -a v1.5.0 -m "release v1.5.0" && git push origin v1.5.0
        ├─ .github/workflows/images.yml   → multi-arch images 1.5.0, 1.5, sha-<short>
        └─ .github/workflows/release.yml  → binaries + GitHub release
```

| Workflow | Triggers | Does |
|---|---|---|
| `test.yml` | push to `main`, pull requests | lint, typecheck, unit suites, dockerized e2e ([testing](testing.md) §12); on `main`, once all of them passed, the `latest` job waits for the commit's `images.yml` run and tags its `sha-<short>` images `latest` (`docker buildx imagetools create`), so `latest` only ever names tested images |
| `images.yml` | push to `main`, tags `v*`, pull requests (build only) | builds the bake `release` matrix (one job per `release-<target>` × architecture, `docker/bake-action`) on native runners (`ubuntu-latest` amd64, `ubuntu-24.04-arm` arm64), pushes by digest, merges multi-arch manifests in GHCR (`ghcr.io/lonetis/<image>`); tags: `main` → `sha-<short>` (`latest` follows from `test.yml`); `vX.Y.Z` → `X.Y.Z`, `X.Y`, `sha-<short>` (`flavor: latest=false`, so a release never moves `latest`); `VERSION` = the tag without `v`, otherwise `git describe --tags --always` without `v`; GHA layer cache per image and architecture |
| `release.yml` | tags `v*` | builds `scantor` for darwin/linux × amd64/arm64 in a `golang:1.27.3-trixie` container (`CGO_ENABLED=0`, `-trimpath`, `-ldflags "-s -w -X …/internal/version.Version=X.Y.Z -X …Commit=<sha> -X …ImagePrefix=ghcr.io/lonetis/"`), copies `scantor.sh` with its `default_tag` set to `X.Y.Z`, writes `SHA256SUMS`, and creates the GitHub release (`gh release create --generate-notes`) with the assets `scantor-darwin-amd64`, `scantor-darwin-arm64`, `scantor-linux-amd64`, `scantor-linux-arm64`, `scantor.sh` and `SHA256SUMS` |

Before tagging: `main` is green in `test.yml`. After the workflows finish: `docker run --rm
ghcr.io/lonetis/scantor:X.Y.Z version` and a downloaded binary report `X.Y.Z`. Operators update with
`docker compose pull && docker compose up -d` ([deployment](deployment.md)); remote nodes update by
restarting `scantor node` with the new image tag within the compatibility window.

## 15. Decisions

1. **`docker-bake.hcl`** is the single definition of image builds for `just`, the test runner and CI
   ([architecture](architecture.md) §4.3, §5).
2. **Image references follow [architecture](architecture.md) §4.2**: compiled-in `internal/version`
   defaults (dev builds reference `scantor-base-<base>:dev` and `scantor:dev`), replaced by
   `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG` whenever `SCANTOR_IMAGE_TAG` is non-empty.
3. **`internal/envconf` and `internal/version`** packages; one `LoadConfig` per Go component.
4. **The dev stack builds every image from source with docker-bake** (group `dev`, tag `dev`). The dev
   orchestrator image (target `dev`) contains the `scantor` binary and mounts the Nuxt source for hot
   reload; Go changes need `just up` (a cached rebuild plus recreation), and no host-built binary is ever
   mounted ([deployment](deployment.md) §6.2).
5. **Recipes run tools as the invoking user** with named cache volumes owned by that user.
6. **Version strings are injected at build time**; no file holds a version number.
7. **`latest` moves only with `main`**; release tags get `X.Y.Z` and `X.Y`.
8. **ESLint with `@nuxt/eslint` and Prettier** for TypeScript/Vue (versions pinned when first added and
   recorded in §11). The orchestrator uses the standalone `@nuxt/eslint` configuration (`withNuxt` from
   `.nuxt/eslint.config.mjs`) with `vue/no-v-html` as an error and `import/first` off for `server/api`
   (`defineRouteMeta` is a route's first statement).
9. **Compose and `.env.example` checks are static scripts** (`lint-compose.mjs`, `lint-env.mjs`) run by
   `just lint`: they need no stack and fail in the fastest CI job (the security specs only wrap them,
   [testing](testing.md) §8.6).

## 16. Future extensions

| Extension | How the setup accommodates it |
|---|---|
| Scheduled no-cache rebuilds (dependency refresh) | `images.yml` can gain a `schedule` trigger building with `--no-cache` and promoting by retag, as agentor does. |
| Renovate/Dependabot | pins live in a few predictable places (package.json + lockfiles, go.mod, Dockerfile `FROM`/`ARG`, justfile image variables, workflow `uses:`). |
| Multi-arch task builds | bake already builds multi-platform platform images; task builds would move to buildx in `internal/taskpipe`. |
| Separate builder nodes, scan priorities, cron/recurring scans | new packages and routes follow §6, §7 and the §9 checklists without new conventions. |
| Package registries for connectors (PyPI, npm, Go proxy) | connectors are self-contained packages with their own manifests; a publish job could join `release.yml`. |
| Signed releases and SBOMs | `release.yml` and `images.yml` can add cosign signing and buildx SBOM attestations. |
| Additional languages and templates | §9.2 and §9.3; CI matrices are derived from `schemas/languages.json` and `schemas/templates/`. |
