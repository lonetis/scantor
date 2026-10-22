# Templates

A template is a ready-made `schedule` with predefined scan config and analysis config types: give it a
scan config such as `{"list": "latest", "limit": 10000}` and it yields one analysis config per domain,
address, list item or number. scantor ships seven templates. They run inside the platform, pin their
inputs before the first analysis is created, and every connector exposes them as typed proxies, so a
task either uses a template as its schedule or wraps it in its own. This guide covers choosing, using,
wrapping and extending templates and describes every template in detail. How a schedule works in each
language is in the authoring guides for [Python](authoring-python.md#schedules-and-templates),
[TypeScript](authoring-typescript.md#schedules-and-templates),
[JavaScript](authoring-javascript.md#schedules-and-templates) and [Go](authoring-go.md#schedules-and-templates).

## Overview

| Template | One analysis per | Analysis config | Pins inputs | Size estimate (unwrapped) |
|---|---|---|---|---|
| [`single`](#single) | scan (exactly one) | `{}` | – | exact (1) |
| [`list`](#list) | item of an inline list and/or an uploaded file | `{item, index}` | – | exact |
| [`range`](#range) | integer of `start`, `start + step`, … below `end` | `{value}` | – | exact |
| [`repeat`](#repeat) | iteration `0 … times − 1` | `{iteration}` | – | exact |
| [`tranco`](#tranco) | domain of a [Tranco](https://tranco-list.eu) top list | `{domain, rank}` | list id | exact |
| [`crux`](#crux) | origin of a Chrome UX Report top list | `{origin, rank}` | month | upper bound |
| [`cidr`](#cidr) | IP address (or subnet) of CIDR ranges | `{ip, prefix, version}` | – | exact |

Every scan config field has a default, so `{}` is a valid scan config for every template. List the
templates with their schemas and examples in the web UI (**Templates**), with `scantor templates list`
or with the MCP tool `list_templates`.

## Using a template

A task uses a template in one of two ways.

| | Unwrapped | Wrapped |
|---|---|---|
| Task code | passes the template's proxy as its `schedule` | iterates the proxy inside its own `schedule` |
| Scan config and analysis config | exactly the template's | your own (usually the template's fields plus yours) |
| Scheduling | the platform runs the template natively, without starting your code | your schedule runs in a connector process and receives the items as a stream |
| Size estimate and confirmation at scan start | yes | no: the size is known once scheduling has finished |
| Use it for | the template as it is | filtering, reshaping, extending, combining |

### Unwrapped

Pass the proxy itself. `run` receives the template's analysis config, and the scan config is the
template's, so omit your own types or pass the template's.

| Language | Unwrapped schedule |
|---|---|
| Python | `scantor.Task(result=Result, schedule=templates.tranco.schedule, run=run)` with `run(ctx, analysis_config: templates.tranco.AnalysisConfig, task_config)` |
| TypeScript, JavaScript | `defineTask({ scanConfig: tranco.ScanConfig, analysisConfig: tranco.AnalysisConfig, result, schedule: tranco.schedule, run })` (both config entries may be omitted) |
| Go | `scantor.Serve(tranco.Schedule, run)` with `run(ctx scantor.Context, ac tranco.AnalysisConfig, tc TaskConfig)` |

`scantor init <dir> --language <language> --template <template>` (or the **New task** wizard, or the
MCP tool `create_task`) creates a task that uses the template unwrapped (for `single`, a task without a
schedule). The examples
[`sleep`](../../tasks/sleep) (Python, `repeat`), [`http-status`](../../tasks/http-status) (TypeScript,
`crux`) and [`reverse-dns`](../../tasks/reverse-dns) (Go, `cidr`) are unwrapped.

### Wrapped: filter, reshape and extend

Call the proxy inside your own schedule and yield your own analysis configs. To extend the template's
scan config, derive your scan config from the template's and add fields; the proxy sends only the
template's own fields. The examples below wrap `list`: they skip lines starting with `#`, turn every
item into a URL and add a scan config field `scheme`.

Python (`for` in a generator, or `async for` in an async generator):

```python
from collections.abc import Iterator
from typing import Literal

from pydantic import BaseModel, Field

import scantor
from scantor import templates


class ScanConfig(templates.list.ScanConfig):
    scheme: Literal["https", "http"] = Field(default="https", description="Scheme of the URLs.")


class AnalysisConfig(scantor.Config):
    url: str
    index: int


class Result(BaseModel):
    url: str


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    for item in templates.list.schedule(ctx, scan_config):
        if not item.item.startswith("#"):
            yield AnalysisConfig(url=f"{scan_config.scheme}://{item.item}/", index=item.index)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(url=analysis_config.url)


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
```

TypeScript (`for await` in an async generator; spread the template's shape to keep its fields):

```ts
import { config, defineTask, z } from "@scantor/connector";
import { list } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: config({ ...list.ScanConfig.shape, scheme: z.enum(["https", "http"]).default("https") }),
  analysisConfig: config({ url: z.string(), index: z.number().int() }),
  result: z.object({ url: z.string() }),
  async *schedule(ctx, scanConfig) {
    for await (const item of list.schedule(ctx, scanConfig)) {
      if (!item.item.startsWith("#")) yield { url: `${scanConfig.scheme}://${item.item}/`, index: item.index };
    }
  },
  run: (ctx, analysisConfig) => ({ url: analysisConfig.url }),
});
```

JavaScript is the same code in `main.js` with `// @ts-check` as its first line; the
[`power`](../../tasks/power) example wraps `range` this way.

Go (embed the template's `ScanConfig`; range over the `iter.Seq2` and pass errors on):

```go
type ScanConfig struct {
	list.ScanConfig
	Scheme string `json:"scheme" jsonschema:"enum=https,enum=http,default=https"`
}

type AnalysisConfig struct {
	URL   string `json:"url"`
	Index int64  `json:"index"`
}

func schedule(ctx scantor.Context, sc ScanConfig, tc scantor.Empty) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for item, err := range list.Schedule(ctx, sc.ScanConfig, tc) {
			if err != nil {
				yield(AnalysisConfig{}, err)
				return
			}
			if strings.HasPrefix(item.Item, "#") {
				continue
			}
			if !yield(AnalysisConfig{URL: sc.Scheme + "://" + item.Item + "/", Index: item.Index}, nil) {
				return // stopping early cancels the template stream
			}
		}
	}
}
```

Rules for wrapped templates, in every language:

- The items stream from the platform while you consume them. Leaving the loop early (`break`,
  `return`, or a `yield` that returns false in Go) stops the stream.
- Template errors, such as a list that cannot be downloaded or a scan config the template rejects, are
  raised at the next iteration. Let them propagate: scheduling is then retried or fails as described in
  [errors and retries](errors-and-retries.md#errors-in-schedule).
- A schedule may call several templates, or one template several times, one after the other. Each call
  is resolved and pinned on its own.
- Proxies work only in `schedule`; calling one in `run` fails with a `validation` error.
- Your schedule must stay deterministic: filter and map items, but do network requests and anything
  random in `run`.

## Starting scans with a template

The scan config is given when the scan starts: in the scan form of the web UI, with
`scantor scans start <task>@latest --scan-config '<json>'`, or with the MCP tool `start_scan`. It is
validated against the task's scan config schema and completed with the defaults.

**Size estimate.** For unwrapped templates the platform validates the scan config with the template's
own rules and estimates the number of analyses before the scan starts. The scan form shows the
estimate; on the command line run it yourself:

```sh
scantor templates estimate tranco --config '{"limit": 100000}'
# prints {"expectedTotal": 100000, "exact": true}
scantor templates estimate cidr --config '{"cidrs": ["10.0.0.0/8"]}'
# exits 2 with the issue: /maxAnalyses: cidrs expand to 16777216 analyses, above maxAnalyses 65536
```

A scan above the instance's confirmation threshold is refused with `confirmationRequired` until you
confirm it (`--confirm`, the checkbox in the form, or `"confirm": true`); a scan above the instance
maximum is refused with `scanTooLarge`. `scantor instance` shows the confirmation threshold.

**Pinned inputs.** Before the first analysis is created, every template records a resolution: the
concrete inputs (for example the Tranco list id that `latest` meant), where the data came from (source
URL, SHA-256 of the data, fetch time) and the exact number of analyses. The scan page shows it under
the scan settings. Resuming a paused scan and retrying failed analyses reuse the resolution, so they
see exactly the same data; when the data changed upstream since, scheduling fails with
`<source> content changed since resolution`. `scantor scans restart` starts a new scan and resolves
`latest` again.

**Local runs and test runs.** `scantor dev run --scan-config '{"limit": 3}' --limit 3` and test runs
fetch template data (Tranco, CrUX) from inside their container, exactly like a scan. Test runs can use
uploaded lists; `scantor dev run` cannot (use `scantor dev run --remote`).

## Template reference

Field names are the JSON names used in scan configs. In Python, multi-word fields are snake_case
attributes with the camelCase JSON name (`max_analyses` is `maxAnalyses`); in Go they are exported
struct fields (`MaxAnalyses`).

### `single`

Exactly one analysis with the analysis config `{}`. It is the schedule of every task that defines none.

| Config | Fields |
|---|---|
| scan config | none (`{}`) |
| analysis config | none (`{}`) |

### `list`

One analysis per item of an inline list and/or an uploaded newline-separated file, in order.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `items` | string[] | `[]` | ≤ 10 000 items of 1–4096 characters |
| `upload` | upload id or `null` | `null` | an upload of your own |
| `offset` | integer | `0` | ≥ 0: skip this many items of the combined sequence |
| `limit` | integer or `null` | `null` | ≥ 1: at most this many analyses; `null` = all |

Analysis config: `{item: string, index: integer}`.

- The sequence is the inline items, then the lines of the upload. Every item and line is trimmed of
  whitespace; empty ones are skipped and do not count.
- `index` is the 0-based position in that sequence **before** `offset`, so it stays the same when you
  change `offset` or `limit`.
- A line longer than 4096 bytes after trimming fails scheduling with a `validation` error.
- Example: `{"items": ["example.org", "example.net"]}` yields `{"item": "example.org", "index": 0}` and
  `{"item": "example.net", "index": 1}`.

Uploading a file: `scantor uploads create domains.txt` prints the upload id (in the web UI, the scan
form's upload field does the same), then start the scan with `--scan-config '{"upload": "<id>"}'`.
Uploads are content-addressed: uploading the same content again returns the same id. An upload cannot be
deleted while a scan references it.

### `range`

One analysis per integer, with Python `range` semantics.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `start` | integer | `0` | first value (inclusive) |
| `end` | integer | `10` | bound (exclusive) |
| `step` | integer | `1` | must not be 0; negative counts down |

Analysis config: `{value: integer}`. All values lie within ±(2^53 − 1). The number of analyses is
`max(0, ceil((end − start) / step))`. Example: `{"start": 1, "end": 11}` yields the values 1 to 10.
In Go the package is `templates/range` with the package name `ranges`, because `range` is a keyword.

### `repeat`

`times` analyses whose config is only the iteration number.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `times` | integer | `1` | ≥ 1 |

Analysis config: `{iteration: integer}`, from 0 to `times − 1`. Example: `{"times": 3}` yields the
iterations 0, 1 and 2. Useful for load tests, sampling and benchmarks.

### `tranco`

Domains of a Tranco research top list with their exact rank.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `list` | string | `"latest"` | `latest`, a date `YYYY-MM-DD` (the daily list of that date) or a list id such as `262W9` |
| `subdomains` | boolean | `false` | use the daily list that includes subdomains (only for `latest` and dates) |
| `offset` | integer | `0` | 0 … 999 999: skip the top `offset` entries |
| `limit` | integer | `1000` | 1 … 1 000 000; `offset + limit ≤ 1 000 000` |

Analysis config: `{domain: string, rank: integer}`, in rank order. Domains are registrable domains as
listed: no scheme, no `www.`. Example: `{"list": "latest", "limit": 1000}` yields `{"domain":
"google.com", "rank": 1}` first.

- `latest` and dates are pinned to an immutable list id before the first analysis, so all analyses of a
  scan (and its retries) use the same list. The daily list of a date exists from about 22:00 UTC of
  that date; an unavailable date fails scheduling with `no Tranco list for <date>`, an unknown id with
  `unknown Tranco list id <id>`.
- Tranco lists domains, not URLs. To fetch them over HTTP, build the URL yourself, in `run` or in a
  wrapped schedule as the [`origins`](../../tasks/origins) example does.

### `crux`

Origins of a Chrome UX Report top list from
[zakird/crux-top-lists](https://github.com/zakird/crux-top-lists), up to a rank bucket.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `country` | string | `"global"` | `global` or a lowercase ISO 3166-1 alpha-2 code (country lists exist from 202501) |
| `month` | string | `"latest"` | `latest` or `YYYYMM` |
| `bucket` | integer | `1000` | one of 1000, 5000, 10000, 50000, 100000, 500000, 1000000: include origins whose rank bucket is at most this value |

Analysis config: `{origin: string, rank: integer}`. `origin` is scheme and host without a trailing
slash; both `http://` and `https://` occur. `rank` is the CrUX rank bucket, not an exact rank: CrUX
publishes ranks only as buckets, and inside a bucket the order is fixed by the file. Example:
`{"country": "de", "bucket": 10000}` yields the German top 10 000 origins.

- `latest` is pinned to the newest month published in the last four months (CrUX publishes a month on
  the second Tuesday of the following month); none fails scheduling with `no CrUX list for <country>
  in the last 4 months`. A missing month fails with `CrUX list <country> <month> not found`.
- The estimate is an upper bound (`bucket`), because country lists can be shorter; the resolution
  replaces it with the exact count.

### `cidr`

One analysis per IP address, or per subnet, of IPv4 and IPv6 ranges.

| Scan config field | Type | Default | Constraints |
|---|---|---|---|
| `cidrs` | string[] | `["192.0.2.0/29"]` | 1–1000 CIDR ranges or single addresses |
| `exclude` | string[] | `[]` | ≤ 1000 ranges or addresses never to emit |
| `prefix` | integer or `null` | `null` | 0 … 128; `null` = one analysis per address, otherwise one per subnet of this length |
| `maxAnalyses` | integer | `65536` | 1 … 100 000 000: the scan is rejected when the expansion is larger |

Analysis config: `{ip: string, prefix: integer, version: 4 | 6}`: an address with prefix 32 or 128, or
the network address and length of a subnet. Example: `{"cidrs": ["192.0.2.0/30"]}` yields
`192.0.2.0` … `192.0.2.3`, each with `"prefix": 32, "version": 4`.

- Host bits are cleared, overlapping and adjacent ranges are merged, and addresses are emitted in
  ascending order, IPv4 before IPv6, each address at most once.
- Network, broadcast and reserved addresses are not skipped: what you list is scanned, minus
  `exclude`. In subnet mode a subnet that intersects an exclusion is skipped entirely.
- With `prefix`, every range must be at least as large as the subnet, and `prefix` must be ≤ 32 when
  any IPv4 range is present.
- `maxAnalyses` is a safety cap, never a truncation: a larger expansion fails validation at scan start
  (`/maxAnalyses: cidrs expand to <n> analyses, above maxAnalyses <m>`). Raise it deliberately.
- Zones (`fe80::1%eth0`) and IPv4-mapped IPv6 addresses are rejected.

## Template errors

| Situation | Error | When |
|---|---|---|
| scan config breaks a rule (for example `step` 0, `offset + limit` above 1 000 000, `maxAnalyses` exceeded) | 422 `configInvalid` with the issue paths | scan start (unwrapped); scheduling (wrapped) |
| unknown list id, unavailable date or month, unknown upload, line too long | `validation`, not retried | scheduling |
| data changed since the resolution (on resume or retry) | `validation`, not retried | scheduling |
| network error, upstream 5xx or 429, unexpected data format | `platform`, retried with the scan's backoff | scheduling |
| more analyses than the instance maximum | `validation`, not retried | scheduling |

Downloads retry network errors, 5xx and 429 twice before they fail. A failed schedule shows up as the
scan condition `schedulingFailed` (or `schedulerRestarting` while it is being retried); see
[errors and retries](errors-and-retries.md).
