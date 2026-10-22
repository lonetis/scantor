# syntax=docker/dockerfile:1
# Images of the orchestrator (docs/architecture.md §4.3, docs/development.md §10). The build context is the
# repository root (docker-bake.hcl): the image needs schemas/ and docs/guide/ as Nitro server assets and builds the
# scantor binary in its own Go stage, so it never depends on another image build.
#
#   target dev    scantor-orchestrator-dev:dev  Node 26, the scantor binary and the dependencies; runs `nuxt dev`
#                 with the repository mounted at /app (docker-compose.dev.yml)
#   final stage   scantor-orchestrator          the built Nuxt output and the scantor binary
#
# Build arguments (set by docker-bake.hcl): VERSION, COMMIT, IMAGE_PREFIX.

# ── scantor binary ──────────────────────────────────────────────────────────────
FROM golang:1.27-alpine AS scantor
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

# ── dependencies ────────────────────────────────────────────────────────────────
# Lifecycle scripts are skipped: the root postinstall (`nuxt prepare`) needs the sources, and no dependency needs
# its own script on linux (native tools ship as platform packages; ssh2's optional crypto build is not used).
FROM node:26-alpine AS deps
WORKDIR /app/orchestrator
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

# ── dev image ───────────────────────────────────────────────────────────────────
# docker-compose.dev.yml mounts the repository at /app and a named volume at /app/orchestrator/node_modules; the
# volume is seeded from this image on first use, and `npm install` at container start keeps it current.
FROM node:26-alpine AS dev
WORKDIR /app/orchestrator
COPY --from=scantor /out/scantor /usr/local/bin/scantor
COPY --from=deps /app/orchestrator/node_modules ./node_modules
ENV NODE_ENV=development
EXPOSE 3000 3001
CMD ["sh", "-c", "npm install --no-audit --no-fund && exec npx nuxt dev --host 0.0.0.0 --port 3000"]

# ── build ───────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY schemas /app/schemas
COPY docs/guide /app/docs/guide
COPY orchestrator ./
ARG VERSION=dev
RUN BUILD_VERSION="${VERSION}" npx nuxt build

# ── production image (final stage) ──────────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app
COPY --from=scantor /out/scantor /usr/local/bin/scantor
COPY --from=build /app/orchestrator/.output ./.output
ENV NODE_ENV=production
# Container port 3000 serves the dashboard, /api and /mcp; 3001 is the editor origin (docs/api.md §9). The process
# runs as root: it uses the host Docker socket and connects to the editors' 0600 unix sockets.
EXPOSE 3000 3001
CMD ["node", ".output/server/index.mjs"]
