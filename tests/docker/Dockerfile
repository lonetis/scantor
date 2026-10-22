# syntax=docker/dockerfile:1
# Runner image of the dockerized Playwright suite (docs/testing.md §7.2): Playwright with Chromium,
# a pinned Docker Engine (the inner dockerd that runs the test stack), DNS and TLS tooling, and the
# scantor CLI built from this checkout. Build context: the repository root (docker-bake.hcl target
# test-runner), filtered by Dockerfile.dockerignore next to this file.

FROM golang:1.27.3-trixie AS cli
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY embed.go ./
COPY cmd ./cmd
COPY internal ./internal
COPY schemas ./schemas
COPY scaffolds ./scaffolds
COPY docs/guide ./docs/guide
ARG VERSION=dev
ARG COMMIT=
# An empty image prefix: the CLI refers to the locally built scantor:dev and base images.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w \
        -X github.com/lonetis/scantor/internal/version.Version=${VERSION} \
        -X github.com/lonetis/scantor/internal/version.Commit=${COMMIT} \
        -X github.com/lonetis/scantor/internal/version.ImagePrefix=" \
      -o /out/scantor ./cmd/scantor

# The tag must equal the exact @playwright/test version of tests/package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# Docker Engine and its plugins from Docker's apt repository, pinned (docs/development.md §11).
ARG DOCKER_VERSION=5:29.9.2-1~ubuntu.24.04~noble
ARG CONTAINERD_VERSION=2.4.2-3~ubuntu.24.04~noble
ARG BUILDX_VERSION=0.38.1-1~ubuntu.24.04~noble
ARG COMPOSE_VERSION=5.6.1-1~ubuntu.24.04~noble

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" "containerd.io=${CONTAINERD_VERSION}" \
      "docker-buildx-plugin=${BUILDX_VERSION}" "docker-compose-plugin=${COMPOSE_VERSION}" \
      dnsmasq git iptables jq libnss3-tools openssl uidmap; \
    rm -rf /var/lib/apt/lists/*; \
    # dnsmasq is started by the entrypoint with its own configuration.
    rm -f /etc/dnsmasq.d/*

COPY tests/docker/daemon.json /etc/docker/daemon.json
COPY tests/docker/stack.tests.yml tests/docker/stack.env tests/docker/join-remote-node.mjs /opt/scantor-test/
COPY tests/docker/traefik/ /opt/scantor-test/traefik/
COPY --chmod=0755 tests/docker/entrypoint.sh /usr/local/bin/scantor-test-entrypoint
COPY --chmod=0755 tests/docker/playwright.sh /usr/local/bin/scantor-test-playwright
COPY --from=cli /out/scantor /usr/local/bin/scantor

WORKDIR /work/tests
ENTRYPOINT ["/usr/local/bin/scantor-test-entrypoint"]
