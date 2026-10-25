# syntax=docker/dockerfile:1
# Image scantor-test-fixtures (docs/testing.md §7.9): the fixtures server of the test stack. It serves the
# Tranco and CrUX fakes of internal/templates/templatestest and read-only git smart-HTTP repositories
# with fixture tasks. Build context: the repository root (docker-bake.hcl target test-fixtures),
# filtered by Dockerfile.dockerignore next to this file.

FROM golang:1.27.3-alpine3.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY embed.go ./
COPY internal ./internal
COPY schemas ./schemas
COPY scaffolds ./scaffolds
COPY docs/guide ./docs/guide
COPY tests/docker/fixtures/main.go ./tests/docker/fixtures/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/scantor-test-fixtures ./tests/docker/fixtures

FROM alpine:3.24 AS repos
RUN apk add --no-cache git
COPY tests/docker/fixtures/repo-task/ /fixtures/repo-task/
COPY --chmod=0755 tests/docker/fixtures/build-repos.sh /usr/local/bin/build-repos
RUN build-repos /fixtures/repo-task /srv/git

FROM alpine:3.24
# git-daemon ships git-http-backend.
RUN apk add --no-cache git git-daemon
COPY --from=build /out/scantor-test-fixtures /usr/local/bin/scantor-test-fixtures
# The server writes per-test repository copies, so it owns /srv/git.
COPY --from=repos --chown=65534:65534 /srv/git /srv/git
USER 65534:65534
EXPOSE 8089
ENTRYPOINT ["/usr/local/bin/scantor-test-fixtures"]
