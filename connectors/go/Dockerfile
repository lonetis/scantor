# scantor-base-go: Go toolchain + connector + ENV contract (docs/tasks.md §4). Build context: the
# repository root (docker-bake.hcl targets base-go and base-go-test).

FROM golang:1.27.3-trixie AS golang

# delve for SCANTOR_DEBUG_CMD, built in its own stage so its dependencies stay out of GOMODCACHE.
FROM golang AS delve
RUN CGO_ENABLED=0 go install github.com/go-delve/delve/cmd/dlv@v1.27.2

FROM golang AS base
ARG VERSION=dev
ENV GOTOOLCHAIN=local \
    GOFLAGS=-modcacherw \
    GOMODCACHE=/go/pkg/mod
COPY --from=delve /go/bin/dlv /usr/local/bin/dlv
COPY connectors/go/scantor-go-check /opt/scantor/bin/scantor-go-check
COPY connectors/go/ /opt/scantor/connectors/go/
# Stamp the release version into the connector (reported in hello), pre-seed GOMODCACHE so a task with
# the scaffold's go.mod/go.sum builds offline, and prove it by building and vetting such a task (the
# build cache is dropped again to keep the image small).
COPY scaffolds/go/files/go.mod.tmpl /tmp/warm/go.mod
COPY scaffolds/go/files/go.sum.tmpl /tmp/warm/go.sum
RUN set -eu; \
    cd /opt/scantor/connectors/go; \
    rm -f Dockerfile Dockerfile.dockerignore scantor-go-check; \
    if [ "$VERSION" != "dev" ]; then \
      printf '%s\n\n%s\n%s\n' 'package scantor' \
        '// Version is the connector version reported in hello, stamped by the base image build.' \
        "const Version = \"${VERSION#v}\"" > version.go; \
    fi; \
    go mod download; \
    go build ./...; \
    cd /tmp/warm; \
    printf '%s\n' 'package main' '' 'import scantor "github.com/lonetis/scantor/connectors/go"' '' \
      'func run(scantor.Context, scantor.Empty, scantor.Empty) (scantor.Empty, error) { return scantor.Empty{}, nil }' '' \
      'func main() { scantor.ServeRun(run) }' > main.go; \
    go mod download; \
    go build -o /dev/null .; \
    go vet ./...; \
    cd /; rm -rf /tmp/warm; \
    go clean -cache
ENV SCANTOR_LANGUAGE=go \
    SCANTOR_CONNECTOR_CMD={entry} \
    SCANTOR_CHECK_CMD=/opt/scantor/bin/scantor-go-check \
    SCANTOR_DEBUG_CMD="dlv exec --headless --listen=0.0.0.0:2345 --api-version=2 --accept-multiclient {entry}" \
    SCANTOR_DEBUG_PORT=2345
WORKDIR /task

# Connector unit tests (just test-connectors go): run with --network none.
FROM base AS test
COPY schemas/ /opt/scantor/schemas/
COPY connectors/go/ /opt/scantor/connectors/go/
WORKDIR /opt/scantor/connectors/go
ENV GOFLAGS="-modcacherw -mod=mod"
CMD ["sh", "-c", "go vet ./... && go test -race -count=1 ./..."]
