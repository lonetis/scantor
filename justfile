# scantor contributor recipes (docs/development.md §4).
#
# Every recipe runs its tools in containers: on the host it calls only docker, git and POSIX shell
# utilities. Containers run as the invoking user with the repository at /src and named cache
# volumes, so generated files stay owned by the contributor.

set positional-arguments
set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()
just := quote(just_executable()) + " --justfile " + quote(justfile())

# Tool images (pinned; a bump changes them here and in docs/development.md §11).
go_image := "golang:1.27.3-trixie"
node_image := "node:26.12.1-trixie-slim"
uv_image := "ghcr.io/astral-sh/uv:0.13.4-python3.14-trixie-slim"
golangci_image := "golangci/golangci-lint:v2.15.0"
playwright_image := "mcr.microsoft.com/playwright:v1.64.1-noble"
alpine_image := "alpine:3.24"

# Images the orchestrator integration tests start (the pins of orchestrator/test/services/nodes/integration.ts
# and test/services/editor/code-server.integration.test.ts).
mongo_image := "mongo:9.0.4"
rabbitmq_image := "rabbitmq:4.4-management"
rustfs_image := "rustfs/rustfs:1.0.3"
registry_image := "registry:3.1.2"
code_server_image := "codercom/code-server:4.141.0"

# docker run as the invoking user with the repository at /src (docs/development.md §3).
run := 'docker run --rm --init -u "$(id -u):$(id -g)" -e HOME=/tmp -v ' + quote(root) + ':/src -w /src --label scantor.dev=true'
go_caches := "-v scantor-dev-gomod:/go/pkg/mod -v scantor-dev-gobuild:/tmp/.cache/go-build"
npm_cache := "-v scantor-dev-npm:/tmp/.npm"
uv_cache := "-v scantor-dev-uv:/tmp/.cache/uv"
cache_volumes := "scantor-dev-gomod scantor-dev-gobuild scantor-dev-npm scantor-dev-uv"

# Group that owns the Docker socket inside containers: the host's group on Linux, root inside the
# VM of Docker Desktop and similar setups.
docker_gid := if os() == "linux" { `stat -L -c %g /var/run/docker.sock 2>/dev/null || echo 0` } else { "0" }
docker_socket := "-v /var/run/docker.sock:/var/run/docker.sock --group-add " + docker_gid

# docker-bake.hcl with the build parameters of dev images (docs/development.md §10).
bake := 'IMAGE_PREFIX= IMAGE_TAG=dev VERSION=dev COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)" docker buildx bake'

dev_compose := "docker compose -f docker-compose.dev.yml"
prod_compose := "docker compose -f docker-compose.prod.yml"
tests_compose := "docker compose -f docker-compose.tests.yml"

# Runs `npm ci` in the current directory only when package-lock.json changed since the last install.
npm_ci := 'if ! cmp -s package-lock.json node_modules/.scantor-package-lock.json; then npm ci --no-audit --no-fund && cp package-lock.json node_modules/.scantor-package-lock.json; fi'

version_pkg := "github.com/lonetis/scantor/internal/version"

# List the recipes
default:
    @{{just}} --list --unsorted

# ── Setup ────────────────────────────────────────────────────────────────────

# Create or complete .env from .env.example (new secrets are random) and prepare the tool caches
[group('setup')]
init:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Merging .env.example into .env"
    docker run --rm -i -u "$(id -u):$(id -g)" -v {{quote(root)}}:/src -w /src {{alpine_image}} sh -s <<'SCRIPT'
    # docs/deployment.md §8.3: copy or append missing keys, randomise the "-insecure-dev" values
    # written in this run, never change an existing key, print key names only.
    set -eu
    umask 077
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    keys() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$1"; }

    if [ -f .env ]; then
      created=false
      : > "$work/added"
      for key in $(keys .env.example); do
        grep -q "^$key=" .env || echo "$key" >> "$work/added"
      done
      : > "$work/new"
      if [ -s "$work/added" ]; then
        # Each missing key with the comment block directly above it.
        awk 'FNR == NR { wanted[$0] = 1; next }
             /^#/ { block = block $0 "\n"; next }
             /^[A-Za-z_][A-Za-z0-9_]*=/ {
               key = $0; sub(/=.*/, "", key)
               if (key in wanted) printf "\n%s%s\n", block, $0
             }
             { block = "" }' "$work/added" .env.example > "$work/new"
      fi
    else
      created=true
      keys .env.example > "$work/added"
      cp .env.example "$work/new"
    fi

    : > "$work/generated"
    while IFS= read -r key; do
      if grep -q "^$key=.*-insecure-dev\$" "$work/new"; then
        value="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
        sed -i "s|^$key=.*\$|$key=$value|" "$work/new"
        echo "$key" >> "$work/generated"
      fi
    done < "$work/added"

    if [ "$created" = true ]; then
      cp "$work/new" .env
      echo "    created .env with $(wc -l < "$work/added" | tr -d ' ') keys"
    elif [ -s "$work/added" ]; then
      if [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi
      cat "$work/new" >> .env
      echo "    added: $(tr '\n' ' ' < "$work/added")"
    else
      echo "    .env is complete"
    fi
    if [ -s "$work/generated" ]; then
      echo "    generated: $(tr '\n' ' ' < "$work/generated")"
    fi
    SCRIPT
    echo "==> Preparing the tool caches"
    {{just}} _caches always

# Install node_modules (Linux binaries) for orchestrator/, tests/ and connectors/js/ so editors resolve imports
[group('setup')]
deps: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in orchestrator tests connectors/js; do
      echo "==> npm ci in $dir"
      {{run}} {{npm_cache}} -w "/src/$dir" {{node_image}} sh -euc \
        'npm ci --no-audit --no-fund && cp package-lock.json node_modules/.scantor-package-lock.json'
    done

# ── Dev stack ────────────────────────────────────────────────────────────────

# Build every dev image from source and start the dev stack
[group('dev stack')]
up: init
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Building the dev images (docker-bake.hcl group dev)"
    {{bake}} --load dev
    echo "==> Starting the dev stack"
    {{dev_compose}} up -d
    # Polls the orchestrator instead of `up --wait`: the first dev start installs node_modules,
    # which can outlast the healthcheck's start period and would fail `up --wait`.
    echo "==> Waiting for the orchestrator to become healthy"
    deadline=$((SECONDS + 900))
    until [ "$(docker inspect -f '{{{{.State.Health.Status}}' scantor-orchestrator)" = healthy ]; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "the orchestrator is not healthy after 15 minutes; see: just logs orchestrator" >&2
        exit 1
      fi
      sleep 3
    done
    public_url="$(sed -n 's/^SCANTOR_PUBLIC_URL=//p' .env)"
    editor_url="$(sed -n 's/^SCANTOR_EDITOR_URL=//p' .env)"
    echo "==> Dashboard: $public_url"
    echo "==> Editor:    $editor_url"
    setup_url="$(docker logs scantor-orchestrator 2>&1 | grep -o 'https\{0,1\}://[^ "]*/setup?token=[^ "]*' | tail -n 1 || true)"
    if [ -n "$setup_url" ]; then
      echo "==> Setup:     $setup_url"
    else
      echo "==> Setup:     no setup link logged (an admin exists, or SCANTOR_ADMIN_EMAIL is set)"
    fi

# Stop the dev stack (volumes are kept)
[group('dev stack')]
down:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then {{dev_compose}} down; else {{dev_compose}} --env-file .env.example down; fi

# Restart dev services (all when none are given)
[group('dev stack')]
restart *services:
    {{dev_compose}} restart "$@"

# Follow the logs of dev services (all when none are given)
[group('dev stack')]
logs *services:
    {{dev_compose}} logs -f --tail 200 "$@"

# Show the dev services and the containers scantor created
[group('dev stack')]
ps:
    {{dev_compose}} ps
    @echo
    docker ps -a --filter label=scantor.managed=true --format 'table {{{{.Names}}\t{{{{.Label "scantor.kind"}}\t{{{{.Image}}\t{{{{.Status}}'

# Run the CLI from scantor:dev through the docker shim in the current directory (SCANTOR_URL and SCANTOR_TOKEN come from the shell)
[group('dev stack')]
[no-cd]
cli *args:
    SCANTOR_IMAGE_PREFIX= SCANTOR_IMAGE_TAG=dev {{quote(root / "scantor.sh")}} "$@"

# Run a task locally with `scantor dev run` from scantor:dev against the host Docker daemon
[group('dev stack')]
[no-cd]
dev-run dir *args:
    SCANTOR_IMAGE_PREFIX= SCANTOR_IMAGE_TAG=dev SCANTOR_DEV_MODE=local {{quote(root / "scantor.sh")}} dev run "$@"

# Start the production stack from GHCR images (init, pull, up)
[group('dev stack')]
prod-up: init
    {{prod_compose}} pull
    {{prod_compose}} up -d

# ── Build ────────────────────────────────────────────────────────────────────

# Build a native scantor binary for this host into bin/scantor (dev ldflags; the dev stack never uses it)
[group('build')]
build: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -s)" in
      Linux) goos=linux ;;
      Darwin) goos=darwin ;;
      *) echo "unsupported operating system: $(uname -s)" >&2; exit 1 ;;
    esac
    case "$(uname -m)" in
      x86_64 | amd64) goarch=amd64 ;;
      arm64 | aarch64) goarch=arm64 ;;
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
    echo "==> Building bin/scantor for $goos/$goarch"
    {{run}} {{go_caches}} -e CGO_ENABLED=0 -e GOOS="$goos" -e GOARCH="$goarch" {{go_image}} \
      go build -trimpath -o bin/scantor \
        -ldflags "-X {{version_pkg}}.Version=dev -X {{version_pkg}}.Commit=$commit -X {{version_pkg}}.ImagePrefix=" \
        ./cmd/scantor

# Build docker-bake.hcl targets or groups with tag dev (default: the dev group)
[group('build')]
build-images *targets:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$#" -eq 0 ]; then set -- dev; fi
    {{bake}} --load "$@"

# Save every image of the test bake group into .test-images/ (CI loads them into the test runner)
[group('build')]
test-images-save:
    #!/usr/bin/env bash
    set -euo pipefail
    images="$({{bake}} --print test | docker run --rm -i {{node_image}} node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => {
        for (const target of Object.values(JSON.parse(input).target)) for (const tag of target.tags) console.log(tag);
      });')"
    mkdir -p .test-images
    for image in $images; do
      file=".test-images/$(printf '%s' "$image" | tr '/:' '__').tar"
      echo "==> $image -> $file"
      docker save -o "$file" "$image"
    done

# ── Quality ──────────────────────────────────────────────────────────────────

# Lint Go, Python and TypeScript, the terminology, .env.example and the compose files
[group('quality')]
lint: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    for module in . connectors/go; do
      echo "==> golangci-lint ($module)"
      {{run}} {{go_caches}} -e GOLANGCI_LINT_CACHE=/tmp/golangci-lint -w "/src/$module" {{golangci_image}} \
        golangci-lint run ./...
    done
    echo "==> ruff check"
    {{run}} {{uv_cache}} {{uv_image}} uvx ruff@0.17.1 check connectors/python
    echo "==> ESLint"
    {{run}} {{npm_cache}} {{node_image}} sh -euc '
      for dir in orchestrator tests connectors/js; do
        (cd "$dir" && {{npm_ci}} && npx --no-install eslint .)
      done'
    echo "==> Terminology and .env.example"
    {{run}} {{node_image}} sh -euc 'node tests/scripts/check-terms.mjs && node tests/scripts/lint-env.mjs'
    {{just}} lint-compose

# Check the compose files: identical infrastructure services in dev and prod, compose security rules
[group('quality')]
lint-compose: _caches
    {{run}} {{npm_cache}} {{node_image}} sh -euc '(cd tests && {{npm_ci}}) && node tests/scripts/lint-compose.mjs'

# Type-check the orchestrator (vue-tsc), tests/ and connectors/js/ (tsc) and connectors/python/ (basedpyright)
[group('quality')]
typecheck: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> nuxt typecheck, tsc --noEmit"
    {{run}} {{npm_cache}} {{node_image}} sh -euc '
      (cd orchestrator && {{npm_ci}} && npx --no-install nuxt typecheck)
      for dir in tests connectors/js; do
        (cd "$dir" && {{npm_ci}} && npx --no-install tsc --noEmit)
      done'
    echo "==> basedpyright"
    {{run}} {{uv_cache}} -e UV_CONSTRAINT=/src/connectors/python/constraints.txt {{uv_image}} sh -euc '
      uv venv --quiet /tmp/venv
      uv pip install --quiet --python /tmp/venv/bin/python --editable connectors/python basedpyright==1.40.2
      cd connectors/python && /tmp/venv/bin/basedpyright --pythonpath /tmp/venv/bin/python'

# Format Go (gofmt, goimports), Python (ruff) and TypeScript/Vue (prettier)
[group('quality')]
fmt: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    for module in . connectors/go; do
      echo "==> golangci-lint fmt ($module)"
      {{run}} {{go_caches}} -e GOLANGCI_LINT_CACHE=/tmp/golangci-lint -w "/src/$module" {{golangci_image}} \
        golangci-lint fmt ./...
    done
    echo "==> ruff format"
    {{run}} {{uv_cache}} {{uv_image}} uvx ruff@0.17.1 format connectors/python
    echo "==> prettier"
    {{run}} {{npm_cache}} {{node_image}} sh -euc '
      for dir in orchestrator tests connectors/js; do
        (cd "$dir" && {{npm_ci}} && npx --no-install prettier --write .)
      done'

# Regenerate docs/guide/cli.md and the guide snippets (--check fails when anything is stale)
[group('quality')]
docs *flags: _caches
    {{run}} {{go_caches}} {{go_image}} go run ./cmd/scantor docs cli "$@"

# ── Tests ────────────────────────────────────────────────────────────────────

# Run the unit suites, then the dockerized Playwright suite (args go to playwright test)
[group('tests')]
test *args:
    {{just}} test-unit
    {{just}} test-e2e "$@"

# Run the Go, orchestrator, connector and conformance unit suites
[group('tests')]
test-unit:
    {{just}} test-go
    {{just}} test-orchestrator
    {{just}} test-connectors
    {{just}} test-conformance

# Go unit tests with -race (default packages ./...; e.g. just test-go ./internal/taskpipe/...)
[group('tests')]
test-go *args: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    packages="./..."
    for arg in "$@"; do
      case "$arg" in ./* | github.com/*) packages="" ;; esac
    done
    {{run}} {{go_caches}} {{go_image}} go test -race -count=1 "$@" $packages

# Go tests tagged integration, with the host Docker socket
[group('tests')]
test-go-integration *args: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    packages="./..."
    for arg in "$@"; do
      case "$arg" in ./* | github.com/*) packages="" ;; esac
    done
    # Host network: tests publish service ports (RabbitMQ) on the Docker host's loopback and dial them
    # there. The images they use must exist locally: scantor:dev and the scantor-base-*:dev images
    # (just build-images scantor base-python base-js base-go), rabbitmq:4.4-management, registry:3.1.2.
    {{run}} {{go_caches}} {{docker_socket}} --network host {{go_image}} go test -count=1 -tags integration "$@" $packages

# vitest unit tests of the orchestrator
[group('tests')]
test-orchestrator *args: _caches
    {{run}} {{npm_cache}} -w /src/orchestrator {{node_image}} sh -euc '{{npm_ci}} && exec npx --no-install vitest run "$@"' sh "$@"

# Orchestrator integration tests against throwaway MongoDB, RabbitMQ, RustFS, registry and code-server containers (args go to vitest run)
[group('tests')]
test-orchestrator-integration *args:
    #!/usr/bin/env bash
    set -euo pipefail
    # The runner's name prefixes every container the tests create (orchestrator/test/services/nodes/
    # integration.ts); everything here carries it, so one name filter finds every leftover.
    prefix=scantor-test-orchestrator-it
    mongo="$prefix-svc-mongo" rabbitmq="$prefix-svc-rabbitmq" rustfs="$prefix-svc-rustfs"
    volumes="$prefix-editor-home $prefix-editor-workspaces $prefix-editor-sockets"
    # Throwaway credentials: the services publish no ports and live only on this run's network.
    mongo_password=mongo-integration-test rabbitmq_password=rabbitmq-integration-test s3_secret=rustfs-integration-test

    remove_test_objects() {
      local ids failed=0
      ids="$(docker ps -aq --filter "name=^$prefix")" || return 1
      if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null || failed=1; fi
      if docker network inspect "$prefix" >/dev/null 2>&1; then docker network rm "$prefix" >/dev/null || failed=1; fi
      docker volume rm -f $volumes >/dev/null || failed=1
      return "$failed"
    }
    cleanup() {
      local status=$?
      echo "==> Removing the test containers, network and volumes"
      remove_test_objects || echo "some test objects were not removed; just prune removes them" >&2
      exit "$status"
    }
    # wait_for <what> <seconds> <command...>: retries the command every second until it succeeds.
    wait_for() {
      local what="$1" deadline=$((SECONDS + $2))
      shift 2
      until "$@" >/dev/null 2>&1; do
        if [ "$SECONDS" -ge "$deadline" ]; then
          echo "timed out waiting for $what; last attempt:" >&2
          "$@" >&2 || true
          return 1
        fi
        sleep 1
      done
    }
    mongo_eval() {
      docker exec "$mongo" mongosh --quiet -u scantor -p "$mongo_password" --authenticationDatabase admin --eval "$1"
    }

    # The tests never pull: every image they start must be present.
    for image in {{node_image}} {{alpine_image}} {{mongo_image}} {{rabbitmq_image}} {{rustfs_image}} {{registry_image}} {{code_server_image}}; do
      if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "==> Pulling $image"
        docker pull --quiet "$image" >/dev/null
      fi
    done

    remove_test_objects
    trap cleanup EXIT
    echo "==> Creating the network and the volumes"
    docker network create --label scantor.test=true "$prefix" >/dev/null
    for volume in $volumes; do docker volume create --label scantor.test=true "$volume" >/dev/null; done

    echo "==> Starting MongoDB, RabbitMQ and RustFS"
    docker run -d --name "$mongo" --network "$prefix" --label scantor.test=true \
      -e MONGO_INITDB_ROOT_USERNAME=scantor -e MONGO_INITDB_ROOT_PASSWORD="$mongo_password" \
      --entrypoint bash {{mongo_image}} -c \
      'set -euo pipefail; openssl rand -base64 756 > /tmp/kf; chmod 400 /tmp/kf; chown mongodb:mongodb /tmp/kf; exec docker-entrypoint.sh "$@"' \
      mongo-entrypoint mongod --replSet rs0 --keyFile /tmp/kf --noscripting --bind_ip_all --wiredTigerCacheSizeGB 0.25 >/dev/null
    docker run -d --name "$rabbitmq" --hostname rabbitmq --network "$prefix" --label scantor.test=true \
      -e RABBITMQ_DEFAULT_USER=scantor -e RABBITMQ_DEFAULT_PASS="$rabbitmq_password" \
      -e "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=-rabbit max_message_size 4194304 -rabbit consumer_timeout 1800000 -rabbit anonymous_login_user none -rabbit auth_mechanisms ['PLAIN','AMQPLAIN']" \
      {{rabbitmq_image}} >/dev/null
    docker run -d --name "$rustfs" --network "$prefix" --label scantor.test=true \
      -e RUSTFS_ACCESS_KEY=scantor -e RUSTFS_SECRET_KEY="$s3_secret" -e RUSTFS_OBS_LOG_DIRECTORY= -e RUSTFS_CHECK_UPDATE=false \
      {{rustfs_image}} >/dev/null
    wait_for "the MongoDB replica set" 120 mongo_eval \
      "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '$mongo:27017' }] }).ok }"
    wait_for "the MongoDB primary" 60 mongo_eval "if (!db.hello().isWritablePrimary) quit(1)"
    wait_for "RabbitMQ" 120 docker exec "$rabbitmq" rabbitmq-diagnostics -q check_port_connectivity
    wait_for "RustFS" 60 docker exec "$rustfs" curl -fsS http://127.0.0.1:9000/health/ready

    # Root (the editor test chowns to the editor uid) with the Docker socket, on the run's network, and
    # the three volumes standing in for the editor's (orchestrator/test/services/editor/
    # code-server.integration.test.ts). The checkout stays read-only: orchestrator/ is copied into the
    # container next to links to the rest of the repository, and gets Linux node_modules and .nuxt there.
    echo "==> Running the integration tests"
    docker run --rm --init --name "$prefix" --network "$prefix" --label scantor.test=true \
      -v {{quote(root)}}:/repo:ro -w /src/orchestrator \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$prefix-editor-sockets:/run/scantor/editor-sockets" \
      -v "$prefix-editor-home:/volumes/editor-home" -v "$prefix-editor-workspaces:/volumes/workspaces" \
      -e SCANTOR_TEST_INTEGRATION=true \
      -e "SCANTOR_MONGO_URL=mongodb://$mongo:27017/?replicaSet=rs0&authSource=admin" \
      -e SCANTOR_MONGO_USER=scantor -e SCANTOR_MONGO_PASSWORD="$mongo_password" \
      -e SCANTOR_AMQP_INTERNAL_URL="amqp://$rabbitmq:5672" -e SCANTOR_RABBITMQ_MANAGEMENT_URL="http://$rabbitmq:15672" \
      -e SCANTOR_RABBITMQ_USER=scantor -e SCANTOR_RABBITMQ_PASSWORD="$rabbitmq_password" \
      -e SCANTOR_S3_INTERNAL_URL="http://$rustfs:9000" -e SCANTOR_S3_ACCESS_KEY=scantor -e SCANTOR_S3_SECRET_KEY="$s3_secret" \
      -e NPM_CONFIG_UPDATE_NOTIFIER=false \
      {{node_image}} bash -euo pipefail -c '
        tar -C /repo/orchestrator --exclude=./node_modules --exclude=./.nuxt --exclude=./.output --exclude=./.data -cf - . \
          | tar -C /src/orchestrator -xf -
        for path in /repo/* /repo/.env.example; do
          if [ "${path##*/}" != orchestrator ]; then ln -s "$path" "/src/${path##*/}"; fi
        done
        npm ci --ignore-scripts --no-audit --no-fund
        npx --no-install nuxt prepare
        filter=.integration.test.ts
        for arg in "$@"; do
          case "$arg" in -*) ;; *) filter="" ;; esac
        done
        # One file at a time: the files share MongoDB and RabbitMQ, and the scans reconciler sweeps
        # every scan user it does not know, including those of the ingestor test.
        exec npx --no-install vitest run --no-file-parallelism "$@" $filter' bash "$@"

# Connector unit tests in each base image's test stage (default: every base of schemas/languages.json)
[group('tests')]
test-connectors base="":
    #!/usr/bin/env bash
    set -euo pipefail
    bases="$1"
    if [ -z "$bases" ]; then bases="$({{just}} _bases)"; fi
    for base in $bases; do
      echo "==> Connector tests: $base"
      {{bake}} --load "base-$base-test"
      docker run --rm --network none --label scantor.dev=true "scantor-base-$base:test"
    done

# Connector conformance harness (default: every language of schemas/languages.json)
[group('tests')]
test-conformance language="":
    #!/usr/bin/env bash
    set -euo pipefail
    languages="$({{just}} _languages)"
    if [ -n "$1" ]; then
      languages="$(printf '%s\n' "$languages" | awk -v language="$1" '$1 == language')"
      if [ -z "$languages" ]; then echo "unknown language: $1" >&2; exit 2; fi
    fi
    bases="$(printf '%s\n' "$languages" | awk '{ print "base-" $2 }' | sort -u | tr '\n' ' ')"
    echo "==> Building scantor:dev and $bases"
    {{bake}} --load scantor $bases
    while read -r language base; do
      echo "==> Conformance: $language ($base)"
      {{run}} {{docker_socket}} scantor:dev conformance --language "$language"
    done <<< "$languages"

# Dockerized Playwright suite on a fresh stack, torn down afterwards (args go to playwright test)
[group('tests')]
test-e2e *args: init
    #!/usr/bin/env bash
    set -euo pipefail
    if docker container inspect scantor-test-runner >/dev/null 2>&1; then
      echo "a test runner is already running (keep-alive?); use just test-exec, or just test-down first" >&2
      exit 1
    fi
    echo "==> Building the test runner image"
    {{bake}} --load test-runner
    # compose run leaves the project network behind; the cache volumes stay.
    trap '{{tests_compose}} down --remove-orphans >/dev/null 2>&1 || true' EXIT
    echo "==> Running the dockerized suite"
    SCANTOR_TEST_HOST_UID="$(id -u)" SCANTOR_TEST_HOST_GID="$(id -g)" \
      {{tests_compose}} run --rm --name scantor-test-runner test-runner "$@"

# Dockerized API tests (test-e2e --project=api)
[group('tests')]
test-api *args:
    {{just}} test-e2e --project=api "$@"

# Dockerized UI tests (test-e2e --project=ui)
[group('tests')]
test-ui *args:
    {{just}} test-e2e --project=ui "$@"

# Start the test runner in the background and keep its fresh stack up for just test-exec (SCANTOR_TEST_KEEP_ALIVE=true)
[group('tests')]
test-up: init
    #!/usr/bin/env bash
    set -euo pipefail
    if docker container inspect scantor-test-runner >/dev/null 2>&1; then
      if docker exec scantor-test-runner test -f /run/scantor-test/ready 2>/dev/null; then
        echo "==> The test stack is already up: just test-exec <args>"
        exit 0
      fi
      echo "a test runner exists but its stack is not ready; see docker logs scantor-test-runner, or just test-down" >&2
      exit 1
    fi
    echo "==> Building the test runner image"
    {{bake}} --load test-runner
    echo "==> Starting the test runner (keep-alive)"
    # --list only checks that the suite loads; the stack stays up until just test-down.
    SCANTOR_TEST_KEEP_ALIVE=true SCANTOR_TEST_HOST_UID="$(id -u)" SCANTOR_TEST_HOST_GID="$(id -g)" \
      {{tests_compose}} run -d --rm --name scantor-test-runner test-runner --list >/dev/null
    # Stopping the follower makes the CLI report its closed log stream; that line is noise.
    docker logs -f scantor-test-runner 2> >(grep --line-buffered -v 'use of closed network connection' >&2) &
    follower=$!
    trap 'kill "$follower" 2>/dev/null || true' EXIT
    until docker exec scantor-test-runner test -f /run/scantor-test/ready 2>/dev/null; do
      if ! docker container inspect scantor-test-runner >/dev/null 2>&1; then
        echo "the test runner exited before its stack was ready (its log is above)" >&2
        exit 1
      fi
      sleep 3
    done
    echo "==> The test stack is up: just test-exec <playwright args>; just test-down to remove it"

# Re-run playwright test inside the kept-alive runner (just test-up, or SCANTOR_TEST_KEEP_ALIVE=true just test-e2e)
[group('tests')]
test-exec *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! docker exec scantor-test-runner test -f /run/scantor-test/ready 2>/dev/null; then
      echo "no kept-alive test stack is ready; start one with just test-up" >&2
      exit 1
    fi
    tty=""
    if [ -t 0 ] && [ -t 1 ]; then tty="-t"; fi
    docker exec -i $tty scantor-test-runner scantor-test-playwright "$@"

# Stop the test runner: its teardown removes the inner stack (the cache volumes stay)
[group('tests')]
test-down:
    #!/usr/bin/env bash
    set -euo pipefail
    if docker container inspect scantor-test-runner >/dev/null 2>&1; then
      echo "==> Stopping the test runner (it tears its stack down first)"
      docker stop --time 300 scantor-test-runner >/dev/null
      docker rm -f scantor-test-runner >/dev/null 2>&1 || true
    fi
    {{tests_compose}} down --remove-orphans >/dev/null 2>&1 || true

# Regenerate the tests/TESTS.md index (--check fails when it is stale)
[group('tests')]
test-index *flags: _caches
    {{run}} {{npm_cache}} -w /src/tests {{playwright_image}} sh -euc '{{npm_ci}} && exec node scripts/test-index.mjs "$@"' sh "$@"

# Remove the test runner, its node_modules volume and its Docker cache volume
[group('tests')]
test-clean: test-down
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Removing the test runner's volumes"
    {{tests_compose}} down -v --remove-orphans >/dev/null 2>&1 || true
    docker volume rm -f scantor-test-runner-docker scantor-test-runner-node-modules >/dev/null

# ── Maintenance ──────────────────────────────────────────────────────────────

# Wipe the dev platform (stack, volumes, scantor containers and networks, bin/, .test-images/); keeps caches and images
[group('maintenance')]
prune:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Stopping the dev stack and removing its volumes"
    if [ -f .env ]; then
      {{dev_compose}} down -v --remove-orphans
    else
      {{dev_compose}} --env-file .env.example down -v --remove-orphans
    fi
    echo "==> Removing scantor-managed, dev and test containers"
    for label in scantor.managed=true scantor.dev=true scantor.test=true; do
      ids="$(docker ps -aq --filter "label=$label")"
      if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; fi
    done
    echo "==> Removing the networks scantor created"
    ids="$(docker network ls -q --filter label=scantor.kind=network)"
    if [ -n "$ids" ]; then docker network rm $ids >/dev/null; fi
    echo "==> Removing the volumes the orchestrator created"
    docker volume rm -f scantor-workspaces scantor-editor-home >/dev/null
    echo "==> Deleting bin/ and .test-images/"
    rm -rf bin .test-images

# prune, test-clean, and remove the tool caches and every scantor dev and test image
[group('maintenance')]
purge: prune test-clean
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Removing the tool caches"
    docker volume rm -f {{cache_volumes}} >/dev/null
    echo "==> Removing scantor*:dev and scantor*:test images"
    images="$(docker images -q --filter 'reference=scantor*:dev' --filter 'reference=scantor*:test' | sort -u)"
    if [ -n "$images" ]; then docker image rm -f $images >/dev/null; fi

# Registry garbage collection: stop the orchestrator of the dev or prod stack, collect, start it again
[group('maintenance')]
registry-gc env="dev":
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      dev | prod) ;;
      *) echo "env must be dev or prod" >&2; exit 2 ;;
    esac
    compose="docker compose -f docker-compose.$1.yml"
    echo "==> Stopping the orchestrator (the only pusher)"
    $compose stop orchestrator
    trap 'echo "==> Starting the orchestrator"; $compose start orchestrator' EXIT
    echo "==> Collecting garbage"
    docker exec scantor-registry registry garbage-collect --delete-untagged /etc/distribution/config.yml

# Back up MongoDB and the RustFS, registry, workspace and editor-home volumes into a directory
[group('maintenance')]
backup dir:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "$1"
    dir="$(cd "$1" && pwd)"
    stamp="$(date +%F)"
    owner="$(id -u):$(id -g)"
    archive() { # volume file
      docker run --rm -v "$1:/data:ro" -v "$dir:/backup" {{alpine_image}} \
        sh -euc 'tar -czf "/backup/$1" -C /data . && chown "$2" "/backup/$1"' sh "$2" "$owner"
    }
    archive_stopped() { # container volume file
      echo "==> Stopping $1"
      docker stop "$1" >/dev/null
      if ! archive "$2" "$3"; then docker start "$1" >/dev/null; return 1; fi
      echo "==> Starting $1"
      docker start "$1" >/dev/null
    }
    echo "==> MongoDB dump -> mongo-$stamp.archive.gz"
    docker exec scantor-mongo sh -c 'exec mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" \
      --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --oplog --archive --gzip' \
      > "$dir/mongo-$stamp.archive.gz"
    echo "==> RustFS -> rustfs-$stamp.tgz"
    archive_stopped scantor-rustfs scantor-rustfs-data "rustfs-$stamp.tgz"
    echo "==> Registry -> registry-$stamp.tgz"
    archive_stopped scantor-registry scantor-registry-data "registry-$stamp.tgz"
    for volume in scantor-workspaces scantor-editor-home; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        echo "==> $volume -> ${volume#scantor-}-$stamp.tgz"
        archive "$volume" "${volume#scantor-}-$stamp.tgz"
      fi
    done
    echo "==> Backup written to $dir"

# Report outdated dependencies (npm, Go modules, Python connector constraints) without changing anything
[group('maintenance')]
deps-outdated: _caches
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> npm (exit code 1 of npm outdated means updates exist)"
    {{run}} {{npm_cache}} {{node_image}} sh -uc '
      for dir in orchestrator tests connectors/js; do
        echo "--- $dir"
        (cd "$dir" && npm outdated) || [ "$?" -eq 1 ] || exit 1
      done'
    for module in . connectors/go; do
      echo "==> Go modules ($module)"
      {{run}} {{go_caches}} -w "/src/$module" {{go_image}} \
        go list -m -u -f '{{{{if .Update}}{{{{.Path}} {{{{.Version}} -> {{{{.Update.Version}}{{{{end}}' all \
        | sed '/^$/d'
    done
    echo "==> Python connector constraints"
    {{run}} {{uv_cache}} {{uv_image}} sh -euc '
      uv venv --quiet /tmp/venv
      uv pip install --quiet --python /tmp/venv/bin/python -r connectors/python/constraints.txt
      uv pip list --python /tmp/venv/bin/python --outdated'

# ── Release ──────────────────────────────────────────────────────────────────

# Tag a release vX.Y.Z on a clean main that equals origin/main and push the tag (CI builds and publishes)
[group('release')]
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$1"
    if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
      echo "version must be X.Y.Z, got: $version" >&2; exit 2
    fi
    tag="v$version"
    if [ "$(git rev-parse --abbrev-ref HEAD)" != main ]; then echo "releases are tagged on main" >&2; exit 1; fi
    if [ -n "$(git status --porcelain)" ]; then echo "the working tree is not clean" >&2; exit 1; fi
    git fetch --quiet --tags origin main
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then echo "main differs from origin/main" >&2; exit 1; fi
    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "tag $tag already exists" >&2; exit 1; fi
    echo "==> Tagging $tag"
    git tag -a "$tag" -m "release $tag"
    git push origin "$tag"
    echo "==> Pushed $tag: .github/workflows/images.yml and release.yml publish it"

# ── Helpers ──────────────────────────────────────────────────────────────────

# Create missing tool cache volumes owned by the invoking user (Docker would create them root-owned)
_caches chown="missing":
    #!/usr/bin/env bash
    set -euo pipefail
    created=false
    for volume in {{cache_volumes}}; do
      if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        docker volume create --label scantor.dev=true "$volume" >/dev/null
        created=true
      fi
    done
    if [ "$created" = true ] || [ "$1" = always ]; then
      docker run --rm -v scantor-dev-gomod:/caches/gomod -v scantor-dev-gobuild:/caches/gobuild \
        -v scantor-dev-npm:/caches/npm -v scantor-dev-uv:/caches/uv {{alpine_image}} \
        chown "$(id -u):$(id -g)" /caches/gomod /caches/gobuild /caches/npm /caches/uv
    fi

# Bases of schemas/languages.json, one per line
_bases:
    @docker run --rm -v {{quote(root / "schemas")}}:/schemas:ro {{node_image}} node -e 'const l = require("/schemas/languages.json").languages; console.log([...new Set(Object.values(l).map((x) => x.base))].join("\n"))'

# "<language> <base>" for every row of schemas/languages.json
_languages:
    @docker run --rm -v {{quote(root / "schemas")}}:/schemas:ro {{node_image}} node -e 'const l = require("/schemas/languages.json").languages; for (const [name, row] of Object.entries(l)) console.log(name + " " + row.base)'
