# Authoring tasks in Go

A Go task is a small program: `main` hands two functions to the connector, `scantor.Serve(schedule,
run)`, and the Dockerfile builds it into the binary `/task/task`. Configs and results are plain Go
structs; the connector derives their JSON Schemas, validates every value that enters or leaves your
code and speaks the connector protocol with the scantor runtime. This guide covers the Go specifics;
templates, the manifest and errors are explained in [templates](templates.md), [manifest](manifest.md)
and [errors and retries](errors-and-retries.md).

## Task folder

```
my-task/
├── scantor.yaml       manifest (name, language: go, defaults)
├── Dockerfile         builds /task/task FROM ${SCANTOR_BASE}
├── main.go            the definition: types, schedule, run, main
├── go.mod, go.sum     module "task" with the connector replaced by its path in the base image
├── .dockerignore      .git/ .scantor/ /task .DS_Store
└── …                  any other packages, data files and tests
```

`scantor init my-task --language go --template cidr` (or the "New task" wizard) creates a folder that
publishes unchanged, including `.devcontainer/`, `.vscode/` (validate, dev run, dev debug and push
tasks plus a Delve attach configuration) and `AGENTS.md`. The manifest's `entry` defaults to
`/task/task`, the binary the Dockerfile builds; set it only if your Dockerfile writes the binary
elsewhere.

The scaffold's Dockerfile is the minimal one. Add `RUN apt-get …` lines for system packages as you
need them; builder stages are allowed as long as the final stage is `FROM ${SCANTOR_BASE}`.

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG SCANTOR_GCFLAGS=""
RUN go build -gcflags="${SCANTOR_GCFLAGS}" -o /task/task .
```

`SCANTOR_GCFLAGS` disables optimisations for `scantor dev debug`; leave the line in place. The base
image `scantor-base-go` (Debian, Go 1.27, Delve) has the connector at `/opt/scantor/connectors/go`,
which is why `go.mod` contains

```
replace github.com/lonetis/scantor/connectors/go => /opt/scantor/connectors/go
```

Keep that line. The base image already holds the connector's dependencies, so the scaffold builds
without network access; `GOTOOLCHAIN=local` pins the Go version of the image. Add your own
dependencies with `go get` in the devcontainer or the browser editor, where the same path exists, and
commit `go.mod` and `go.sum`.

## Defining a task

```go
package main

import scantor "github.com/lonetis/scantor/connectors/go"

type TaskConfig struct {
	Greeting string `json:"greeting" jsonschema:"default=Hello"`
}

type Result struct {
	Text string `json:"text"`
}

func run(ctx scantor.Context, _ scantor.Empty, tc TaskConfig) (Result, error) {
	return Result{Text: tc.Greeting + ", world!"}, nil
}

func main() { scantor.ServeRun(run) }
```

| Function | Signature | Purpose |
|---|---|---|
| `scantor.Serve(schedule, run)` | `schedule func(scantor.Context, SC, TC) iter.Seq2[AC, error]`, `run func(scantor.Context, AC, TC) (R, error)` | full definition; the type parameters task config `TC`, scan config `SC`, analysis config `AC` and result `R` are inferred from the two functions |
| `scantor.ServeRun(run)` | `run func(scantor.Context, scantor.Empty, TC) (R, error)` | no schedule: every scan runs exactly one analysis (template `single`) |

Both block until the runtime shuts the process down and then exit the process. `schedule` runs once
per scan, `run` once per attempt of an analysis. `run` never sees the scan config: put whatever an
analysis needs into the analysis config and whatever is constant into the task config. The runtime
starts several connector processes per worker (`processes`), each handling one call at a time, so
package-level state is per process; goroutines inside a call are fine.

A complete task: the [`reverse-dns`](../../tasks/reverse-dns) example looks up the PTR records of every
address of CIDR ranges.

<!-- scantor:include tasks/reverse-dns/main.go -->
```go
// Package main is the reverse-dns example task: a PTR lookup for every address of CIDR ranges. The
// cidr template is used unwrapped, so the scheduler expands the ranges natively.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/cidr"
)

// TaskConfig is constant for all analyses of a scan.
type TaskConfig struct {
	Nameserver string `json:"nameserver" jsonschema:"default=,description=DNS server as host:port; empty uses the resolver of the worker container"`
	TimeoutMs  int    `json:"timeoutMs" jsonschema:"default=3000,minimum=100,maximum=30000,description=Timeout of one lookup in milliseconds"`
}

// Result lists the PTR names of one address.
type Result struct {
	Names []string `json:"names" jsonschema:"description=PTR names without the trailing dot; sorted"`
	Found bool     `json:"found" jsonschema:"description=Whether the address has at least one PTR record"`
}

func run(ctx scantor.Context, ac cidr.AnalysisConfig, tc TaskConfig) (Result, error) {
	if ac.Prefix != 32 && ac.Prefix != 128 {
		return Result{}, scantor.Fatal("reverse DNS needs single addresses; leave the scan config prefix unset")
	}
	resolver, err := newResolver(tc.Nameserver)
	if err != nil {
		return Result{}, scantor.Fatalf("invalid task config: %w", err)
	}
	lookupCtx, cancel := context.WithTimeout(ctx, time.Duration(tc.TimeoutMs)*time.Millisecond)
	defer cancel()
	names, err := resolver.LookupAddr(lookupCtx, ac.IP)
	var dnsErr *net.DNSError
	switch {
	case err == nil:
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound:
		return Result{Names: []string{}, Found: false}, nil
	case errors.As(err, &dnsErr) && (dnsErr.IsTimeout || dnsErr.IsTemporary):
		// Transient resolver trouble: try again after the scan's backoff.
		return Result{}, scantor.Retry(err.Error(), 0)
	default:
		return Result{}, fmt.Errorf("PTR lookup of %s: %w", ac.IP, err)
	}
	for i, name := range names {
		names[i] = strings.TrimSuffix(name, ".")
	}
	slices.Sort(names)
	ctx.Log(scantor.LevelInfo, "resolved", "ip", ac.IP, "names", len(names))
	return Result{Names: names, Found: len(names) > 0}, nil
}

// newResolver returns Go's own resolver (identical behaviour in every image), optionally pinned to
// one nameserver.
func newResolver(nameserver string) (*net.Resolver, error) {
	if nameserver == "" {
		return &net.Resolver{PreferGo: true}, nil
	}
	if _, _, err := net.SplitHostPort(nameserver); err != nil {
		return nil, fmt.Errorf("nameserver %q: %w", nameserver, err)
	}
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, nameserver)
		},
	}, nil
}

func main() { scantor.Serve(cidr.Schedule, run) }
```
<!-- scantor:include:end -->

## Config and result types

Configs (`TC`, `SC`, `AC`) are structs. Results are structs or maps with string keys. The connector
reflects their JSON Schemas with [invopop/jsonschema](https://github.com/invopop/jsonschema):

- Field names come from `json` tags; unexported fields and fields tagged `json:"-"` are skipped,
  embedded structs are flattened.
- Configs are closed: unknown keys are rejected (`additionalProperties: false`), so a typo such as
  `"limt": 100` fails when the scan starts instead of silently using the default.
- Config fields are optional unless tagged `jsonschema:"required"`. Give every config field a default,
  so that `{}` is a valid config and the forms in the UI start filled in.
- Result fields are required unless they have `omitempty` (or `omitzero`).
- A pointer field is nullable (`null` is allowed). A nil slice or map is sent as `[]` or `{}`.
- Every value is checked against the schema: configs (with missing defaults filled in) before your
  code sees them, analysis configs your schedule yields and results your run returns before they
  leave the process. A violation fails the call with a `validation` error that lists the paths.

Constraints and annotations are `jsonschema` tags, separated by commas; write `\,` (`\\,` inside the
tag string) for a comma inside a value:

| Tag | Applies to | Example |
|---|---|---|
| `default=<value>` | any field | `default=Hello`, `default=443`, `default=true` |
| `default=null` / `default=[]` / `default={}` | pointer / slice / struct or map fields | `default=null` |
| repeated `default=` | slices | `default=80,default=443` (the values are converted to the element type) |
| `required` | configs | `jsonschema:"required"` |
| `minimum=`, `maximum=`, `exclusiveMinimum=`, `exclusiveMaximum=`, `multipleOf=` | numbers | `minimum=1,maximum=64` |
| `minLength=`, `maxLength=`, `pattern=`, `format=` | strings, and the items of string slices | `pattern=^[a-z]+$`, `format=uuid` |
| `enum=` (repeated) | strings and numbers | `enum=http,enum=https` |
| `minItems=`, `maxItems=`, `uniqueItems=true` | slices | `maxItems=1000` |
| `title=`, `description=` | any field | `description=Ports to probe` |
| `writeOnly=true` | strings | prefer the type `scantor.Secret` |

Asserted formats are `date`, `date-time`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`,
`uri`, `uuid` and `regex`. Patterns use the syntax that Go and JavaScript share. The platform sends
every call complete configs, with defaults filled in.

Types the connector provides:

| Type | Meaning |
|---|---|
| `scantor.Empty` | a config without fields: `{}` |
| `scantor.Secret` | a string marked `writeOnly`: encrypted at rest, shown as `***` in every response; your code gets the real value. An omitted secret gets its `default=` tag (`""` without one); the platform never stores that default. Secrets that your code prints into logs or results cannot be masked. |
| `scantor.FileRef` | a reference to a file registered with `ctx.Files()`; results may contain FileRefs anywhere (fields, nested structs, slices), and the UI renders them as download links |

## The context

Every call gets a `scantor.Context`. It is a `context.Context`: pass it to every blocking operation
(HTTP requests, DNS lookups, `select`), because it is cancelled at the analysis deadline and when the
worker drains or stops.

| Method | In `run` | In `schedule` |
|---|---|---|
| `ScanID()` | scan id (`local` in `scantor dev run`, the test-run id in test runs) | same |
| `AnalysisID()`, `Seq()` | `<scanId>-<seq>`, the 0-based position in the schedule | `""`, `-1` |
| `Attempt()` | 1-based attempt of the analysis | scheduler start count |
| `Deadline()`, `Done()`, `Err()` | deadline of the attempt (the scan's `timeout`) | no deadline |
| `TmpDir()` | empty scratch directory, deleted after the call | same |
| `Log(level, msg, kv...)` | log line with key/value fields | same |
| `Progress(fraction, message)` | progress 0…1 (negative = unknown), shown for running analyses | ignored |
| `Files()` | file registration | not available |

At the deadline the runtime kills the process, so cleanup must not rely on running afterwards: budget
your work with `ctx.Deadline()`. Log levels are `scantor.LevelDebug`, `LevelInfo`, `LevelWarning` and
`LevelError`; prints to stdout and stderr are captured too and appear in the analysis log.

## Files

```go
shot, err := ctx.Files().Put("shot.png", png, "image/png")      // bytes
report, err := ctx.Files().PutFile("report.json", path, "")     // copies the file at path
```

Large or binary outputs belong in files, not in the result (results are limited in size). `Put` and
`PutFile` copy the content and return the final `scantor.FileRef` at once; store it in the result. The
files are uploaded only after `run` succeeded, so files of failed attempts disappear. Names are 1–255
characters without `/`, `\` and NUL and unique within the attempt. An empty content type means
`application/octet-stream`, and a content type is at most 255 characters long; pass `image/png`,
`image/jpeg`, `image/gif` or `image/webp` for images that should open inline. Violated rules and platform
limits return a `*scantor.Error` of type `validation`.

## Errors and retries

| `run` returns | Error type | Effect |
|---|---|---|
| `scantor.Fatal(msg)`, `scantor.Fatalf(format, args...)` | `fatal` | the analysis fails now, without retries |
| `scantor.Retry(msg, delay)` | `retry` | another attempt after `delay` (0 = the scan's backoff), clamped to [1 s, backoff max]; counts toward `maxAttempts` |
| any other error, or a panic | `taskError` | another attempt after the backoff; a panic keeps its stack |
| a `*scantor.Error` of type `validation` (from files or templates) | `validation` | fails now |
| invalid config or result | `validation` | fails now; the issues name the paths |
| deadline exceeded | `timeout` | retried; the process is replaced |
| the process exits or runs out of memory | `crash` | retried; the process is replaced |

Errors wrapped with `%w` keep their type (`Fatalf("lookup %s: %w", ip, err)` stays fatal and still
matches `errors.Is(err, …)`). In `schedule`, `Fatal` and `validation` errors fail scheduling, while
other errors restart the scheduler with backoff. See [errors and retries](errors-and-retries.md) for
the scan-level view.

## Schedules and templates

A schedule returns an `iter.Seq2[AC, error]`. It must be deterministic: the same scan config and task
config always yield the same analysis configs in the same order, because the scheduler resumes after
a restart by replaying the stream and verifying it. Do anything slow or random in `run`.

```go
func schedule(ctx scantor.Context, sc ScanConfig, tc TaskConfig) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for n := range sc.Count {
			if !yield(AnalysisConfig{N: n}, nil) {
				return
			}
		}
	}
}
```

Templates are ready-made schedules (see [templates](templates.md)). Each has a package
`github.com/lonetis/scantor/connectors/go/templates/<name>` with `ScanConfig`, `AnalysisConfig` and
`Schedule`:

| Template | Package | Analysis config fields |
|---|---|---|
| `single` | `templates/single` | none (`scantor.Empty`) |
| `list` | `templates/list` | `Item`, `Index` |
| `range` | `templates/range`, package name `ranges` (`range` is a Go keyword) | `Value` |
| `repeat` | `templates/repeat` | `Iteration` |
| `tranco` | `templates/tranco` | `Domain`, `Rank` |
| `crux` | `templates/crux` | `Origin`, `Rank` |
| `cidr` | `templates/cidr` | `IP`, `Prefix`, `Version` |

Pass `Schedule` unwrapped, `scantor.Serve(tranco.Schedule, run)`, and the scheduler runs the template
itself: the scan's size is known up front and the scan page shows where the data came from. `run` then
takes the template's `AnalysisConfig`, and the scan config is the template's `ScanConfig`.

To filter or reshape a template, iterate it in your own schedule (wrapped). Embed the template's scan
config to keep its fields and add your own:

```go
type ScanConfig struct {
	tranco.ScanConfig
	SkipTLDs []string `json:"skipTlds,omitempty" jsonschema:"default=cn"`
}

func schedule(ctx scantor.Context, sc ScanConfig, tc TaskConfig) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for item, err := range tranco.Schedule(ctx, sc.ScanConfig, tc) {
			if err != nil {
				yield(AnalysisConfig{}, err)
				return
			}
			tld := item.Domain[strings.LastIndex(item.Domain, ".")+1:]
			if !slices.Contains(sc.SkipTLDs, tld) && !yield(AnalysisConfig{URL: "https://" + item.Domain + "/"}, nil) {
				return // stopping early cancels the template stream
			}
		}
	}
}
```

The items stream from the runtime while you consume them. Zero values in a template `ScanConfig` mean
the template's defaults (`tranco.ScanConfig{Limit: 100}` uses the latest list); the exception is
`End` of `range`, where 0 is a valid end. Template errors (for example a list that cannot be
downloaded) arrive as `*scantor.Error`; return them and scheduling is retried or failed accordingly.

## Develop, debug and publish

| Command | Does |
|---|---|
| `scantor validate .` | static checks, image build, describe and `go vet` exactly as on publish |
| `scantor dev run . --limit 5` | build and run locally (schedule, then up to 5 analyses); `--task-config`, `--scan-config` and `--analysis-config` take JSON; `--remote` runs on the platform |
| `scantor dev debug .` | build without optimisations and start one analysis under Delve on `localhost:2345` |
| `scantor push .` | upload and publish a revision |

To debug, run `scantor dev debug .` and start the scaffold's launch configuration "scantor: attach to
dev debug" (VS Code Go extension, remote attach to port 2345, sources mapped to `/task`); set
breakpoints before attaching. The `check` phase of a publish runs `go vet ./...`, so run it (and your
own `go test ./...`) before pushing. In the browser editor `scantor dev run` runs on the platform.

## Docker inside a task

Tasks with `defaults.privileged: true` run on Docker-in-Docker nodes and need the owner's
`canRunPrivileged` permission. The base image contains no Docker engine; install it in the Dockerfile
and keep the root user:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
```

The runtime starts the inner Docker daemon before your process; use the default socket. Test runs and
`scantor dev run` never run privileged, so do not touch Docker before `run`.
