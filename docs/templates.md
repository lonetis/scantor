# Templates

This document describes the internals of scan templates: reusable `schedule` implementations with
predefined scan config and analysis config types. Templates are implemented once in Go
(`internal/templates/<name>`), described by canonical schemas and fixtures in `schemas/templates/`, and
exposed to task code by typed proxies in every connector. The document covers the architecture, native
versus proxied execution, the resolve step and provenance, `expectedTotal` and estimates, determinism and
the scheduler's `tailHash`, data-source URLs, the exact configuration and semantics of every initial
template (`single`, `list`, `range`, `repeat`, `tranco`, `crux`, `cidr`), the fixture format, and how to
add a template. The authoring view is in [tasks](tasks.md) §5 and `docs/guide/templates.md`; the wire
format of proxied calls is in [protocol](protocol.md) §5.8.

## 1. Architecture

```
 task code                         connector                       runtime (Go, internal/templates)
 ─────────                         ─────────                       ───────────────────────────────
 schedule = tranco.schedule ─────► describe: {kind: template,      scheduler: Validate → Resolve →
   (unwrapped)                       template: tranco}  ─────────►  POST …/scheduler/resolved → Stream
                                                                     → publish (no connector process)

 def schedule(ctx, sc, tc):        proxy: send `template`  ──────►  Validate → Resolve (key call:<n>) →
   for item in tranco.schedule(…)  receive `templateItem`  ◄──────  Stream, credit-limited
       if keep(item): yield …      (native model instances)
```

| Piece | Location | Responsibility |
|---|---|---|
| implementation | `internal/templates/<name>/` | validation beyond JSON Schema, estimate, resolve, deterministic stream |
| registry | `internal/templates/registry.go` | name → implementation; checked against the embedded schema files at init |
| canonical schema | `schemas/templates/<name>.json` | `$defs.scanConfig`, `$defs.analysisConfig`, metadata `x-scantor-template` |
| fixtures | `schemas/templates/<name>.fixtures.json` | valid/invalid configs, resolutions and expected output for small inputs (§10) |
| connector proxies | `connectors/python/src/scantor/templates/<name>.py`, `connectors/js/src/templates/<name>.ts`, `connectors/go/templates/<name>/` (package `<name>`; `range` is package `ranges`, because `range` is a Go keyword) | typed `ScanConfig`, `AnalysisConfig` and a proxy `schedule`; about 20 lines each |
| CLI | `scantor templates list`, `scantor templates estimate` | listing and scan-size estimates for the orchestrator and users |

Rules:

- Template data (Tranco, CrUX, uploaded lists) is fetched only inside scheduler workers and local-mode
  containers (test runs, `scantor dev run`), never by the orchestrator process.
- The schema files are embedded in the binary through the root `embed.go`; the loader reads
  `schemas/templates/<name>.json` and skips `*.fixtures.json`. `GET /api/templates` maps a file to
  `{name, title, description, scanConfigSchema, analysisConfigSchema, example, resolves}`.
- Field names are single lowercase words where possible, camelCase otherwise, so Python and
  TypeScript casing never diverge.

### 1.1 Schema file format

`schemas/templates/<name>.json` is a JSON Schema document (draft 2020-12, `$id`
`https://scantor.dev/schemas/templates/<name>.json`) whose root has no assertions:

| Key | Meaning |
|---|---|
| `title`, `description` | display texts (UI cards, `listTemplates`) |
| `x-scantor-template.name` | template name (= file name), `^[a-z][a-z0-9]{0,31}$` |
| `x-scantor-template.version` | ordering-contract version (§6); currently 1 for all templates |
| `x-scantor-template.resolves` | true when Resolve pins non-deterministic inputs (`tranco`, `crux`) |
| `x-scantor-template.estimate` | `exact` or `upperBound` (§5) |
| `x-scantor-template.dataSources` | data-source keys used (§7) |
| `x-scantor-template.uploads` | true when a field references uploads (`list`) |
| `x-scantor-template.example` | `{scanConfig, analysisConfig}` for UI cards and docs |
| `$defs.scanConfig` | canonical scan config schema: closed object, every property has a `default` |
| `$defs.analysisConfig` | canonical analysis config schema: closed object |

### 1.2 Go interface

```go
package templates // internal/templates

type Issue struct {
	Path    string `json:"path"`    // instance JSON pointer into the scan config
	Message string `json:"message"`
}

type Estimate struct {
	ExpectedTotal *int64 `json:"expectedTotal"` // nil = unknown
	Exact         bool   `json:"exact"`
}

type Resolution struct {
	ScanConfig    json.RawMessage `json:"scanConfig"`    // concrete inputs (e.g. list id instead of "latest")
	Provenance    map[string]any  `json:"provenance"`    // template-specific, §4
	ExpectedTotal *int64          `json:"expectedTotal"` // exact count when known after resolving
}

type Upload struct {
	URL    string // presigned GET
	SHA256 string
	Bytes  int64
	Lines  int64 // only known to Estimate (from the uploads collection)
}

type Env struct {
	DataSources map[string]string // "tranco", "crux" → base URL without trailing slash
	Uploads     map[string]Upload // upload id → access
	HTTP        *http.Client      // §7.2 policy
	TmpDir      string            // scratch space for downloaded data
	Now         func() time.Time  // injected for tests ("latest" resolution)
	UserAgent   string            // "scantor/<version> (+https://github.com/lonetis/scantor)"
}

type Template interface {
	Name() string
	// Validate checks the rules JSON Schema cannot express. cfg is schema-valid with defaults applied.
	Validate(cfg json.RawMessage) []Issue
	// Estimate counts analyses without network access (uploads: Env.Uploads[id].Lines).
	Estimate(cfg json.RawMessage, env Env) (Estimate, error)
	// Resolve pins non-deterministic inputs, fetches what the stream needs and computes provenance.
	Resolve(ctx context.Context, env Env, cfg json.RawMessage) (Resolution, error)
	// Stream yields analysis configs for a resolution, in the template's contractual order (§6).
	Stream(ctx context.Context, env Env, res Resolution) iter.Seq2[json.RawMessage, error]
}
```

Errors returned by `Resolve` and `Stream` are `*runtime.Error` values with a ScantorError `type`
(`validation` for bad or unavailable inputs, `platform` for network, upstream or format failures) and
`retryable` (§8). An error about one scan config field carries its JSON pointer in `Details["path"]`; a
rejected scan config carries `Details["issues"]` (`[{path, message}]`). The package re-exports the
helpers `IssuesError`, `ErrorPath` and `ErrorIssues` that build and read them, so the runtime and
`scantor templates estimate` need only `internal/templates`.

## 2. Lifecycle in a scan

1. **Scan start** (orchestrator, [api](api.md) §5.1). ajv validates the scan config against the revision
   schema, which for unwrapped templates is the canonical schema. For template schedules the orchestrator
   then runs `scantor templates estimate <name> --config - [--upload <id>=<lines>]…` (subprocess, no
   network): exit 0 prints `{"expectedTotal": n | null, "exact": bool}`; exit 2 prints `{"issues":
   [{path, message}]}`, which becomes 422 `configInvalid` with those issues (for example `cidr`
   `/maxAnalyses`). The estimate drives `confirmationRequired` (`SCANTOR_SCAN_CONFIRM_THRESHOLD`) and
   `scanTooLarge` (`SCANTOR_MAX_ANALYSES_PER_SCAN`); `stats.expectedTotal` starts as the estimate.
2. **Scheduler bootstrap**: `scheduler.resolved` (stored resolutions by key), `scheduler.uploads`
   (presigned GET per referenced upload) and `scheduler.dataSources` ([api](api.md) §8.1).
3. **Unwrapped template** (`revision.schedule.kind == "template"`): the scheduler spawns **no connector
   process**. Key `schedule`: if `resolved.schedule` exists it is used as is; otherwise Validate (defence
   in depth), Resolve, then `POST /api/runtime/scheduler/resolved {epoch, key: "schedule", template,
   scanConfig, provenance, expectedTotal}`. When the response says `stored: false` (another scheduler of
   the same epoch race), the returned resolution replaces the local one and its data is re-fetched by
   Stream. Then Stream and publish ([runtime](runtime.md)). For key `schedule` the orchestrator copies
   `expectedTotal` to `stats.expectedTotal`.
4. **Wrapped template** (custom schedule calling a proxy): the n-th `template` request of a schedule
   request uses key `call:<n>`; same Validate → Resolve → record → Stream sequence, with items sent as
   `templateItem` under credit flow control ([protocol](protocol.md) §6.2). An invalid scan config is
   answered with `error` type `validation` and raised in user code. `expectedTotal` of wrapped calls is
   recorded in the resolution but not copied to the scan (user code may filter).
5. **Resume** (new scheduler, `epoch + 1`): stored resolutions are reused, Stream re-fetches data and
   verifies the recorded `sha256` (mismatch → `validation`: `<source> content changed since resolution`),
   and the runtime replays and verifies the checkpoint (§6).
6. **Local mode** (test runs, `dev run`): the same steps without the API; resolutions are emitted as
   `resolved` events ([tasks](tasks.md) §11.3).

## 3. Native and proxied execution

| Aspect | Unwrapped (native) | Wrapped (proxied) |
|---|---|---|
| Task code | `schedule=<template>.schedule` with the template's own types | a custom schedule that iterates `<template>.schedule(ctx, scanConfig)` |
| describe | `{kind: "template", template: "<name>"}`; canonical schemas substituted ([tasks](tasks.md) §7) | `{kind: "custom"}`; the task's own schemas |
| Scheduler | runtime only; no connector process | connector process; items stream from the runtime into user code and back as `analysis` |
| Resolution key | `schedule` | `call:<n>` |
| Scan-start estimate | yes | no (custom schedule) |

Proxy behaviour, identical in every connector:

- `schedule(ctx, scanConfig, taskConfig?)`: the third parameter is accepted and ignored, so the proxy
  can be passed unwrapped (called with three arguments) and called wrapped with two.
- The proxy serialises only the canonical fields of `scanConfig` (a subclass, an embedding struct or an
  object with extra keys is fine), sends `template` with initial credit 256, parses every `templateItem`
  with the native `AnalysisConfig` model, grants credit 128 after every 128 consumed items, and sends
  `templateCancel` when iteration stops early.
- Python: the returned object supports both `__iter__` and `__aiter__`, so it works in sync and async
  generators. TypeScript/JavaScript: an `AsyncIterable`. Go: `iter.Seq2[AnalysisConfig, error]`.
- Unwrapped detection: Python attribute `__scantor_template__ = "<name>"` on the proxy function;
  TypeScript property `Symbol.for("scantor.template")`; Go: the function symbol belongs to package
  `github.com/lonetis/scantor/connectors/go/templates/<name>` (for `range` the import path ends in
  `templates/range` and the package is named `ranges`).

## 4. Resolve and provenance

Resolve turns a scan config into a **resolution** `{scanConfig, provenance, expectedTotal}` before the
first item is published. The resolved `scanConfig` replaces every non-deterministic input with a concrete
one; `provenance` records where the data came from. Stored in `scans.scheduling.resolved.<key>` together
with `template` and `at` ([data model](data-model.md) §4.5.2), shown on the scan page, and reused on
every resume.

| Template | Resolved `scanConfig` | `provenance` | `expectedTotal` |
|---|---|---|---|
| `single` | effective config | `{}` | 1 |
| `list` | effective config | `{inlineItems, upload: {id, sha256, bytes, lines} \| null}` | exact |
| `range` | effective config | `{}` | exact |
| `repeat` | effective config | `{}` | exact |
| `tranco` | `list` = the concrete list id | `{listId, date, sourceUrl, sha256, fetchedAt}` | exact (rows received) |
| `crux` | `month` = the concrete month | `{country, month, sourceUrl, sha256, fetchedAt}` | exact (rows within the bucket) |
| `cidr` | effective config | `{}` | exact |

`sha256` is the hex SHA-256 of the **decoded** data (the CSV text after HTTP content decoding and gzip
decompression), so it is independent of transport compression. `fetchedAt` is ISO 8601 UTC.

## 5. Estimates and `expectedTotal`

| Template | `estimate` kind | Estimate (no network) |
|---|---|---|
| `single` | exact | 1 |
| `list` | exact | min(`limit`, max(0, inline items + upload lines − `offset`)) |
| `range` | exact | `len(range(start, end, step))` |
| `repeat` | exact | `times` |
| `tranco` | exact | `limit` (every Tranco list has 1 000 000 rows) |
| `crux` | upperBound | `bucket` (country lists may be shorter) |
| `cidr` | exact | number of addresses or subnets after merging and exclusions |

The resolution's `expectedTotal` is exact for every template and replaces the estimate in
`stats.expectedTotal`; progress and ETA use it ([api](api.md) §2).

## 6. Determinism, ordering contract and `tailHash`

- The scheduler checkpoints `{confirmed, tailHash}` where `tailHash = "sha256:" + hex(SHA-256(canonical
  JSON of analysis config confirmed − 1))`. Canonical JSON is RFC 8785 (JCS): sorted keys, no whitespace,
  ECMAScript number formatting, UTF-8. On resume the runtime regenerates and discards items 0…N−2 and
  verifies the hash of item N−1; a mismatch fails scheduling with `schedule() is not deterministic`
  ([runtime](runtime.md)).
- Templates are deterministic by construction: Stream depends only on the resolution and on data whose
  `sha256` is verified. They never read clocks, random numbers or environment after Resolve.
- **Ordering contract**: for a given resolved scan config and data hash, a template yields the same
  sequence of analysis configs in every runtime version (remote nodes may run a newer runtime than the one
  that started the scan). A change to order, item content or the meaning of a field requires a new
  template name; `x-scantor-template.version` documents the contract revision and is never bumped for an
  existing name.
- Compatible evolution: new scan config fields must be optional with a default that preserves the old
  behaviour, and analysis configs may only gain fields that old connector models tolerate (a closed
  model would reject them), so in practice analysis configs never change.

## 7. Data sources

### 7.1 URLs

| Key | Variable (orchestrator, CLI) | Upstream base URL | Used by |
|---|---|---|---|
| `tranco` | `SCANTOR_TRANCO_URL` | `https://tranco-list.eu` | `tranco` |
| `crux` | `SCANTOR_CRUX_URL` | `https://raw.githubusercontent.com/zakird/crux-top-lists/main` | `crux` |

The orchestrator passes them to schedulers in bootstrap (`scheduler.dataSources`) and to test runs in the
local-mode input; the CLI reads the same variables for `scantor dev run` and otherwise uses compiled-in
defaults equal to the `.env.example` defaults (the variables are documented only there). Tests and the
scaffold matrix point them at the fixtures server, which mirrors exactly the endpoints of §9.5 and §9.6
(paths, query strings, content types, CRLF/LF line endings and gzip) under its base URLs
([testing](testing.md) §7.9). Data-source URLs are not scan config fields.

### 7.2 HTTP policy

- `User-Agent: scantor/<version> (+https://github.com/lonetis/scantor)`; TLS verification always on
  (`SCANTOR_CA_CERT` is honoured); no cookies; redirects followed up to 5 hops.
- Timeouts: 10 s to connect, 10 minutes per request ([runtime](runtime.md) §11.2).
- Retries: network errors, 5xx and 429 get 3 tries in total, with 2 s and 4 s between them (a
  `Retry-After` header wins, capped at 60 s); afterwards the error is `platform`, retryable (the scheduler
  restarts with backoff, [runtime](runtime.md) §11.9). Tranco `/api/*` requests are spaced at least 1 s
  apart (upstream rate limit).
- Size caps: 64 MiB per download, 256 MiB decoded (gzip bomb protection); exceeding them is a `platform`
  error, not retryable. Uploaded lists are capped at their recorded `bytes` (≤ `SCANTOR_MAX_UPLOAD_BYTES`,
  which may exceed 64 MiB) instead, both raw and decoded; the 64 MiB / 256 MiB caps apply to Tranco, CrUX
  and uploads of unknown size.
- Downloaded data is cached in `Env.TmpDir` keyed by URL for the lifetime of the scheduler process, so
  Resolve and Stream download once. Concurrent callers for the same URL share one download, which runs
  detached from the caller that started it: a caller whose context ends (a wrapped template call that
  user code stops early) returns its own cancellation, the others keep waiting, and the download is
  cancelled only when no caller waits any more.

## 8. Errors

| Situation | ScantorError `type` | `retryable` | Phase |
|---|---|---|---|
| semantic validation failure (Validate) | `validation` | false | `schedule` (scan start: 422 `configInvalid`) |
| unknown list id, unavailable date or month, unknown upload | `validation` | false | `schedule` |
| network error, timeout, 5xx/429 after retries | `platform` | true | `schedule` |
| unexpected data format (wrong CSV header, non-contiguous Tranco ranks, unsorted CrUX buckets) | `platform` | true | `schedule` |
| data changed since resolution (sha256 mismatch on resume) | `validation` | false | `schedule` |
| size caps exceeded | `platform` | false | `schedule` |
| analysis count above `SCANTOR_MAX_ANALYSES_PER_SCAN` while streaming | `validation` | false | `schedule` |

Unwrapped: a non-retryable error fails scheduling; a retryable one counts as a scheduler restart.
Wrapped: the error is sent to the connector and raised in user code ([protocol](protocol.md) §5.8).

## 9. Initial templates

Defaults make `{}` a valid scan config for every template. "Effective" values below are after defaults.

### 9.1 `single`

The default schedule when a task defines none.

| Config | Fields |
|---|---|
| ScanConfig | none (`{}`) |
| AnalysisConfig | none (`{}`) |

Stream: exactly one `{}`. Validate: nothing. Estimate: 1, exact.

### 9.2 `list`

One analysis per item of an inline list and/or an uploaded newline-separated file.

ScanConfig:

| Field | Type | Default | Constraints | Meaning |
|---|---|---|---|---|
| `items` | string[] | `[]` | ≤ 10 000 items, each 1–4096 characters | inline items |
| `upload` | uuid \| null | `null` | `"x-scantor": "upload"`; must be an upload of kind `list` owned by the scan owner | uploaded list |
| `offset` | integer | 0 | ≥ 0 | skip this many items of the combined sequence |
| `limit` | integer \| null | `null` | ≥ 1 | at most this many analyses; null = all |

AnalysisConfig: `{item: string (1–4096), index: integer ≥ 0}`.

Semantics:

- Combined sequence: the inline items, then the lines of the upload. Each item or line is trimmed of ASCII
  whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`; Unicode spaces such as NBSP count as content); empty
  results are skipped and do not count. The uploads collection's `lines` uses the same rule ([data
  model](data-model.md) §4.10; Go `internal/templates/list` and the orchestrator's upload line counter
  implement exactly this set, so whoever changes one changes the other), so the estimate is exact.
- `index` is the 0-based position in the combined sequence before `offset`, so it is stable across
  different `offset`/`limit` values.
- A line longer than 4096 bytes after trimming → `validation` (`line <n> of upload exceeds 4096 bytes`).
- Resolve downloads the upload through its presigned URL, verifies `sha256` against the upload record,
  and counts items. Uploads are immutable (content-addressed), so `list` needs no pinning.
- Scan start: `uploadIds` must exist and be owned (404 otherwise, [api](api.md) §5.1); `deleteUpload`
  answers 409 `uploadInUse` while a scan references it.

### 9.3 `range`

One analysis per integer, Python `range` semantics.

ScanConfig: `start` integer (default 0), `end` integer (default 10, exclusive), `step` integer (default
1), all within ±(2^53 − 1). Validate: `step ≠ 0` (`/step: must not be 0`). AnalysisConfig: `{value:
integer}`. Stream: `start, start + step, …` while `< end` (step > 0) or `> end` (step < 0). Count:
`max(0, ceil((end − start) / step))`.

### 9.4 `repeat`

ScanConfig: `times` integer ≥ 1 (default 1). AnalysisConfig: `{iteration: integer ≥ 0}`. Stream:
`iteration = 0 … times − 1`. Count: `times`.

### 9.5 `tranco`

Domains of a Tranco research top list with their exact rank.

ScanConfig:

| Field | Type | Default | Constraints | Meaning |
|---|---|---|---|---|
| `list` | string | `"latest"` | `latest`, `YYYY-MM-DD`, or a list id `[0-9A-Z]{4,6}` | which list |
| `subdomains` | boolean | `false` | – | for `latest` and dates: the variant including subdomains |
| `offset` | integer | 0 | 0 … 999 999 | skip the top `offset` entries |
| `limit` | integer | 1000 | 1 … 1 000 000; `offset + limit ≤ 1 000 000` (Validate, path `/limit`) | number of domains |

AnalysisConfig: `{domain: string (1–253), rank: integer 1…1 000 000}`; domains are registrable domains as
listed (no scheme, no `www.`).

Resolve (base = `tranco` data source):

| `list` | Request | Result |
|---|---|---|
| `latest` | `GET {base}/api/lists/date/latest?subdomains=<bool>` | JSON: `list_id`; date = `configuration.endDate` |
| `YYYY-MM-DD` | `GET {base}/daily_list_id?date=<date>&subdomains=<bool>` | text body = list id; 503 or body `null` → `validation`: `no Tranco list for <date>`; date = the input |
| list id | `GET {base}/api/lists/id/<id>` | 404 → `validation`: `unknown Tranco list id <id>`; date = `configuration.endDate` |

Then `GET {base}/download/<listId>/<offset + limit>`: CSV without header, CRLF line endings, rows
`rank,domain`. Parsing: split on `\n`, strip `\r`, skip empty lines, split each row at the first comma;
ranks must be 1, 2, 3, … (otherwise `platform`: `unexpected Tranco CSV at line <n>`). Resolution:
`scanConfig.list` = the list id, `provenance = {listId, date, sourceUrl: <download URL>, sha256,
fetchedAt}`, `expectedTotal = max(0, rows − offset)` capped at `limit`.

Stream: rows `offset + 1 … offset + limit` in rank order → `{domain, rank}`.

Lists are immutable once published; the daily list of a date exists from about 22:00 UTC of that date,
which is why `latest` is resolved through the metadata endpoint instead of computing a date.

### 9.6 `crux`

Origins of a Chrome UX Report top list up to a rank bucket, from `zakird/crux-top-lists` (global since
202102, 238 countries since 202501).

ScanConfig:

| Field | Type | Default | Constraints | Meaning |
|---|---|---|---|---|
| `country` | string | `"global"` | `global` or lowercase ISO 3166-1 alpha-2 | which list |
| `month` | string | `"latest"` | `latest` or `YYYYMM` | which month |
| `bucket` | integer | 1000 | one of 1000, 5000, 10000, 50000, 100000, 500000, 1000000 | include origins whose rank bucket ≤ this value (the explicit cap of the scan) |

AnalysisConfig: `{origin: string (1–2048), rank: integer (a bucket value)}`; origins are scheme + host
without trailing slash; `http://` and `https://` both occur.

Resolve (base = `crux` data source; path `data/global` for `global`, else `data/country/<country>`):

- `latest`: `HEAD {base}/<path>/<YYYYMM>.csv.gz` for the current UTC month and the three months before it,
  newest first; the first `200` wins; none → `validation`: `no CrUX list for <country> in the last 4
  months`. (CrUX publishes a month on the second Tuesday of the following month.)
- A given month: no probe; a `404` on download → `validation`: `CrUX list <country> <month> not found`.
- `GET {base}/<path>/<month>.csv.gz`, gunzip, header `origin,rank`, LF line endings. Rows are ordered by
  bucket (random order inside a bucket, fixed by the file). Buckets must be valid and non-decreasing
  (otherwise `platform`). `expectedTotal` = rows with rank ≤ `bucket`. Provenance `{country, month,
  sourceUrl, sha256, fetchedAt}`; `scanConfig.month` = the concrete month.

Stream: rows in file order until the first rank greater than `bucket` → `{origin, rank}`.

### 9.7 `cidr`

One analysis per IP address, or per subnet, of IPv4/IPv6 ranges.

ScanConfig:

| Field | Type | Default | Constraints | Meaning |
|---|---|---|---|---|
| `cidrs` | string[] | `["192.0.2.0/29"]` (TEST-NET-1) | 1–1000 entries | CIDR ranges or single addresses |
| `exclude` | string[] | `[]` | ≤ 1000 entries | ranges or addresses never to emit |
| `prefix` | integer \| null | `null` | 0 … 128 | null = per address; otherwise one analysis per subnet of this length |
| `maxAnalyses` | integer | 65 536 | 1 … 100 000 000 | required safety cap: the scan is rejected when the expansion is larger |

AnalysisConfig: `{ip: string, prefix: integer 0…128, version: 4 | 6}`: the address (prefix 32 or 128),
or the network address and length of a subnet.

Validate (issues with paths):

- every entry parses as an IPv4/IPv6 prefix or address (`/cidrs/<i>`, `/exclude/<i>`); zones and
  IPv4-mapped IPv6 addresses are rejected;
- with `prefix`: every range is at least as large as the subnet (`prefix ≥` each range's length), and
  `prefix ≤ 32` when any IPv4 range is present (`/prefix`);
- the exact count is ≤ `maxAnalyses` (`/maxAnalyses`: `cidrs expand to <n> analyses, above maxAnalyses
  <m>`).

Stream:

1. Clear host bits of every input, merge overlapping and adjacent ranges per family.
2. Iterate IPv4 ranges in ascending address order, then IPv6.
3. Per-address mode: emit every address not contained in an exclusion of the same family.
   Subnet mode: emit every aligned subnet of length `prefix` that does not intersect any exclusion.
4. Text form: dotted quad for IPv4, RFC 5952 for IPv6 (Go `netip.Addr.String()`).

There is no implicit skipping of network, broadcast or reserved addresses: what is listed is scanned,
minus `exclude`.

## 10. Fixtures

`schemas/templates/<name>.fixtures.json`:

| Key | Content |
|---|---|
| `template` | template name |
| `scanConfig.valid[]` | `{name, input, effective}`: `input` is schema-valid and passes Validate; `effective` is `input` with defaults applied |
| `scanConfig.invalid[]` | `{name, input, kind, path}`: `kind: "schema"` = rejected by the canonical schema (and by native connector models); `kind: "semantic"` = accepted by the schema, rejected by Validate (and by Resolve when the issue is data-dependent, e.g. an unknown upload) at `path` |
| `analysisConfig.valid[]` / `invalid[]` | `{name, input}` / `{name, input, path}`: inputs accepted / rejected by the canonical schema and by native models |
| `cases[]` | `{name, scanConfig, now?, http?, uploads?, estimate, resolution?, analyses?, complete?, error?}` |

Case fields:

| Field | Meaning |
|---|---|
| `scanConfig` | input; defaults are applied first |
| `now` | the clock for `latest` resolution (ISO 8601) |
| `http[]` | `{method, path, status, contentType, body, encoding}` served by a fake server at the data-source base URL; `path` includes the exact query string; `encoding: "gzip"` means the server gzips `body`. A `HEAD` request for a path with a `GET` entry answers `200`; every other request answers `404`. |
| `uploads[]` | `{id, content, lines}` served at presigned-style URLs; `sha256` and `bytes` are computed from `content` |
| `estimate` | expected `{expectedTotal, exact}` |
| `resolution` | expected `{scanConfig, provenance, expectedTotal}`; `fetchedAt` is not compared; `${tranco}` and `${crux}` in strings stand for the data-source base URLs |
| `analyses` | expected stream output; `complete: true` = the whole stream, `false` = a prefix |
| `error` | instead of `resolution`/`analyses`: `{type, retryable, contains}` expected from Resolve or Stream |

Consumers:

- **Go unit tests** (`internal/templates/<name>`): for every fixture, schema acceptance/rejection,
  `ApplyDefaults(input) == effective`, Validate issues at the given paths, Estimate, Resolve and Stream
  against the fake server, and determinism (two streams yield identical sequences and identical
  `tailHash`es).
- **Connector conformance** ([protocol](protocol.md) §12, cases D5 and T4): native models accept and
  reject the fixture configs and describe matches the canonical properties, types and defaults.
- **Scaffold matrix** ([testing](testing.md)): `scantor dev run --limit 2` for every language × template
  with `SCANTOR_TRANCO_URL`/`SCANTOR_CRUX_URL` pointing at a fixture server.

## 11. Adding a template

1. `schemas/templates/<name>.json`: closed `scanConfig` with a default on every property, closed
   `analysisConfig`, metadata (`version: 1`, `resolves`, `estimate`, `dataSources`, `uploads`, `example`).
   Prefer single-word field names. Every non-determinism (time, "latest", remote data) must be pinned by
   Resolve.
2. `schemas/templates/<name>.fixtures.json`: valid/invalid configs, at least one case per code path,
   error cases for every `validation` error.
3. `internal/templates/<name>/`: implement `Template`; register it in `internal/templates/registry.go`;
   unit tests driven by the fixtures.
4. Connector proxies (`ScanConfig`, `AnalysisConfig`, `schedule`) in `connectors/python`, `connectors/js`
   and `connectors/go`, plus conformance fixture `template-<name>` and an entry in `template-models`.
5. Scaffold entries `scaffolds/<language>/entry/<name>.<ext>.tmpl` for every language.
6. A new data source: a variable `SCANTOR_<SOURCE>_URL` in `.env.example`, a `scheduler.dataSources` key
   in bootstrap, and the local-mode input.
7. Document it in §9 here and in `docs/guide/templates.md`.

Changing an existing template follows §6: additive optional scan config fields only; anything else is a
new template.

## 12. Decisions made in this document

Accepted by the lead (round 1 rulings):

1. **Template semantics fixed here**: `single` has no parameters; `list` combines inline items and one
   upload, trims and skips empty items, `index` counts before `offset`; `range` is exclusive of `end`;
   `repeat` defaults to 1; `tranco` uses `/download/<id>/<offset+limit>` and resolves `latest` via the
   metadata API; `crux` reads only `zakird/crux-top-lists` (≤ 1M) with an explicit `bucket` cap;
   `cidr` merges and sorts ranges, supports a subnet mode via `prefix`, has a default `maxAnalyses` of
   65 536 and rejects (never truncates) larger expansions.
2. **Every template has a Resolve step** and records a resolution (also non-resolving ones, for uniform
   provenance and an exact `expectedTotal`).
3. **`sha256` is computed over decoded data**, and resume verifies it.
4. **Scan-start semantic validation** goes through `scantor templates estimate` (exit 2 with issues →
   422 `configInvalid`).
5. **Ordering contract**: template output order is frozen per name; incompatible changes need a new name.
6. **HTTP policy constants** (§7.2) are fixed, not configurable.

## 13. Future extensions

| Extension | How the design accommodates it |
|---|---|
| CrUX beyond 1M origins: a `crux-cache` source reading `lonetis/crux-cache` chunks (up to ~18M origins, buckets 5M/10M/all) | a new data source key (§11 step 6) and a `source` scan config field defaulting to today's `zakird/crux-top-lists` behaviour; buckets extend the enum additively |
| Tranco full list (> 1M) | `limit` maximum can grow with the `/download/<id>/full` endpoint; additive |
| Seeded sampling inside a CrUX bucket, CIDR shuffling | new optional fields (`seed`, `shuffle`) defaulting to today's order |
| Deduplication in `list` | an optional `dedupe` field; the hash set lives in the scheduler |
| Global or per-user exclusion lists | an upload kind referenced by `cidr`/`list`, or an orchestrator-level list passed in bootstrap |
| `from-scan` template (results of a previous scan) | a template whose Resolve pins a scan id and filter; data fetched through a runtime API |
| `repeat` as a modifier of other templates | wrapping already composes templates in user code |
| `ctx.memo` | user schedules get the same pinning mechanism through `scheduling.resolved` keys |
| `ctx.expectTotal` | wrapped schedules could report totals; resolutions already carry `expectedTotal` |
| More templates (DNS zones, certificate transparency, ASN prefixes) | §11 checklist; no connector protocol change |
