# syntax=docker/dockerfile:1
#
# scantor-editor (docs/editor.md §2). Build context: the repository root.
#
#   toolchain  Go, Node, Python, uv, just, basedpyright, gopls, delve and the connectors at the
#              base-image paths. The single definition of the development toolchain, also used by
#              .devcontainer/ (docs/development.md §2).
#   editor     toolchain + code-server, baked extensions, machine settings and the scantor CLI.
#
# A Go toolchain bump changes go.mod, every golang: tag and this file together
# (docs/development.md §11).

# ── Build stages ─────────────────────────────────────────────────────────────

FROM golang:1.27.3-trixie AS go-tools
ENV CGO_ENABLED=0 GOBIN=/out
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install golang.org/x/tools/gopls@v0.24.0 \
 && go install github.com/go-delve/delve/cmd/dlv@v1.27.2

# The scantor binary, built like the scantor image's (VERSION, COMMIT and IMAGE_PREFIX come from
# docker-bake.hcl).
FROM golang:1.27.3-trixie AS scantor
ARG VERSION=dev
ARG COMMIT=
ARG IMAGE_PREFIX=
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY embed.go ./
COPY cmd/ cmd/
COPY internal/ internal/
COPY schemas/ schemas/
COPY scaffolds/ scaffolds/
COPY docs/guide/ docs/guide/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/scantor \
      -ldflags "-s -w \
        -X github.com/lonetis/scantor/internal/version.Version=${VERSION} \
        -X github.com/lonetis/scantor/internal/version.Commit=${COMMIT} \
        -X github.com/lonetis/scantor/internal/version.ImagePrefix=${IMAGE_PREFIX}" \
      ./cmd/scantor

# @scantor/connector as installed in scantor-base-js: the packed package (its "files") with its
# production dependencies (zod) nested in its own node_modules (docs/tasks.md §4.3).
FROM node:26.12.1-trixie-slim AS js-connector
ARG VERSION=dev
WORKDIR /src
COPY connectors/js/ ./
RUN rm -rf node_modules dist \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm pkg set scantorVersion="${VERSION}" \
 && npm pack --ignore-scripts --pack-destination /tmp \
 && mkdir /out \
 && tar -xzf /tmp/scantor-connector-*.tgz -C /out --strip-components=1 \
 && cp -R node_modules /out/node_modules

# Root /node_modules as in scantor-base-js (connectors/js/check-tools): TypeScript and the Node.js
# types for task code.
FROM node:26.12.1-trixie-slim AS js-root
WORKDIR /out
COPY connectors/js/check-tools/package.json connectors/js/check-tools/package-lock.json ./
RUN npm ci --no-audit --no-fund

# The Go connector module as in scantor-base-go, without its image build files.
FROM debian:trixie-slim AS go-connector
COPY connectors/go/ /out/
RUN rm -f /out/Dockerfile /out/Dockerfile.dockerignore /out/scantor-go-check

# A module cache with the Go connector's dependencies at the versions of the connector and the
# scaffold (scantor-base-go pre-seeds its GOMODCACHE the same way). The editor's GOMODCACHE lives
# in the persistent home volume, so the entrypoint seeds it from this copy on every start; gopls and
# builds of scaffolded tasks then resolve the connector's dependencies without network.
FROM golang:1.27.3-trixie AS go-modcache
ENV GOMODCACHE=/out GOFLAGS=-modcacherw GOTOOLCHAIN=local
COPY connectors/go/go.mod connectors/go/go.sum /opt/scantor/connectors/go/
COPY scaffolds/go/files/go.mod.tmpl /tmp/task/go.mod
COPY scaffolds/go/files/go.sum.tmpl /tmp/task/go.sum
RUN cd /opt/scantor/connectors/go \
 && go mod download \
 && cd /tmp/task \
 && go mod download \
 && go list -m all > /dev/null

# ── toolchain ────────────────────────────────────────────────────────────────

FROM debian:trixie-slim AS toolchain
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime dependencies of the toolchains copied below (the packages their images add to
# debian:trixie-slim): libatomic1 for Node.js and code-server; libffi8, libgdbm6t64, libncursesw6,
# libreadline8t64 and netbase for Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less openssh-client procps \
      libatomic1 libffi8 libgdbm6t64 libncursesw6 libreadline8t64 netbase \
 && rm -rf /var/lib/apt/lists/*

COPY --from=python:3.14-slim-trixie /usr/local/ /usr/local/
COPY --from=node:26.12.1-trixie-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:26.12.1-trixie-slim /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=node:26.12.1-trixie-slim /usr/local/include/node/ /usr/local/include/node/
COPY --from=golang:1.27.3-trixie /usr/local/go/ /usr/local/go/
COPY --from=ghcr.io/astral-sh/uv:0.13.4 /uv /uvx /usr/local/bin/
COPY --from=go-tools /out/ /usr/local/bin/
RUN ldconfig \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ENV LANG=C.UTF-8 \
    PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GOTOOLCHAIN=local \
    PIP_CONSTRAINT=/opt/scantor/constraints.txt \
    UV_CONSTRAINT=/opt/scantor/constraints.txt \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# just from its GitHub release (the distribution packages are outdated), checked against pinned
# checksums.
RUN case "${TARGETARCH}" in \
      amd64) arch=x86_64;  sha256=409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e ;; \
      arm64) arch=aarch64; sha256=23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSLo /tmp/just.tar.gz "https://github.com/casey/just/releases/download/1.59.0/just-1.59.0-${arch}-unknown-linux-musl.tar.gz" \
 && echo "${sha256}  /tmp/just.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/just.tar.gz -C /usr/local/bin just \
 && rm /tmp/just.tar.gz

RUN npm install -g --no-audit --no-fund basedpyright@1.40.2 \
 && npm cache clean --force

# Connectors at the well-known paths of the base images (docs/tasks.md §4.3), owned by uid 1000 so
# a non-root devcontainer user can relink them to the repository (.devcontainer/post-create.sh).
COPY --chown=1000:1000 connectors/python/constraints.txt /opt/scantor/constraints.txt
RUN --mount=type=bind,source=connectors/python,target=/tmp/connector-python,rw \
    uv pip install --system --break-system-packages --no-cache /tmp/connector-python \
 && chown -R 1000:1000 /usr/local/lib/python3.14/site-packages
COPY --chown=1000:1000 --from=js-root /out/node_modules/ /node_modules/
COPY --chown=1000:1000 --from=js-connector /out/ /node_modules/@scantor/connector/
COPY --chown=1000:1000 --from=go-connector /out/ /opt/scantor/connectors/go/

# ── editor ───────────────────────────────────────────────────────────────────

FROM toolchain AS editor

COPY --from=codercom/code-server:4.141.0 /usr/lib/code-server/ /usr/lib/code-server/
RUN ln -s /usr/lib/code-server/bin/code-server /usr/bin/code-server \
 && groupadd --gid 1000 coder \
 && useradd --uid 1000 --gid 1000 --home-dir /home/coder --no-create-home --shell /bin/bash coder \
 && install -d -o 1000 -g 1000 -m 0755 /home/coder /home/coder/workspace /run/scantor-editor

# Pinned extensions from Open VSX into a directory that stays read-only at runtime. The build fails
# when an extension dependency pulls in anything but the pinned set.
RUN --mount=type=bind,source=editor/extensions.txt,target=/tmp/extensions.txt \
    grep -Ev '^[[:space:]]*(#|$)' /tmp/extensions.txt > /tmp/wanted \
 && while read -r extension; do \
      code-server --user-data-dir /tmp/code-server --extensions-dir /opt/code-server/extensions \
        --install-extension "${extension}" || exit 1; \
    done < /tmp/wanted \
 && code-server --user-data-dir /tmp/code-server --extensions-dir /opt/code-server/extensions \
      --list-extensions --show-versions > /tmp/installed \
 && diff <(tr '[:upper:]' '[:lower:]' < /tmp/wanted | sort) <(tr '[:upper:]' '[:lower:]' < /tmp/installed | sort) \
 && chmod -R a+rX /opt/code-server \
 && rm -rf /tmp/code-server /tmp/wanted /tmp/installed /root/.config /root/.local /root/.cache

COPY --from=scantor /out/scantor /usr/local/bin/scantor
COPY --from=go-modcache /out/ /opt/scantor/gomodcache/
COPY schemas/ /opt/scantor/schemas/
COPY editor/machine-settings.json /opt/scantor/editor/machine-settings.json
COPY --chmod=0755 editor/entrypoint.sh /usr/local/bin/scantor-editor-entrypoint

# The root filesystem is read-only at runtime: Go modules, caches and user tools live in the
# persistent home volume, and no toolchain is ever downloaded.
ENV HOME=/home/coder \
    GOPATH=/home/coder/go \
    GOMODCACHE=/home/coder/go/pkg/mod \
    PATH=/usr/local/go/bin:/home/coder/go/bin:/home/coder/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/coder/workspace
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/scantor-editor-entrypoint"]
# The orchestrator always passes its own arguments (docs/editor.md §2.4); this default serves on the
# same unix socket without authentication and must never be published on a network.
CMD ["--socket", "/run/scantor-editor/code.sock", "--socket-mode", "600", "--auth", "none", \
     "--disable-proxy", "--disable-telemetry", "--disable-update-check", \
     "--disable-getting-started-override", "--user-data-dir", "/home/coder/.local/share/code-server", \
     "--extensions-dir", "/opt/code-server/extensions", "/home/coder/workspace"]
