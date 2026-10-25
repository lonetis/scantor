# syntax=docker/dockerfile:1
# Image ghcr.io/lonetis/scantor: the static scantor binary plus git (docs/architecture.md §4.3).
# It serves the CLI, the node daemon, the workspace helpers and the runtime source for injection.
# Build arguments (set by docker-bake.hcl): VERSION, COMMIT, IMAGE_PREFIX.

FROM golang:1.27.3-alpine3.24 AS build
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
ARG IMAGE_PREFIX=
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w \
        -X github.com/lonetis/scantor/internal/version.Version=${VERSION} \
        -X github.com/lonetis/scantor/internal/version.Commit=${COMMIT} \
        -X github.com/lonetis/scantor/internal/version.ImagePrefix=${IMAGE_PREFIX}" \
      -o /out/scantor ./cmd/scantor

FROM alpine:3.24
# iptables + iptables-legacy provide the nft and legacy iptables/ip6tables the egress helper
# (scantor node egress-apply, docs/nodes.md §9) detects and drives.
RUN apk add --no-cache git ca-certificates iptables iptables-legacy
COPY --from=build /out/scantor /usr/local/bin/scantor
# Root by default: the node daemon needs the Docker socket; workspace helpers set their uid explicitly.
ENTRYPOINT ["/usr/local/bin/scantor"]
