# Bundles

A **bundle** is one file that holds a ready revision as a Docker image, together with the scantor runtime
and the revision's defaults. Anyone with Docker can load it and run the revision on their own machine,
without an account, the platform or the CLI: the schedule and every analysis run in one container, and the
results end up as plain files in the current folder. A **bundle run** is one such `docker run`.

```sh
docker load -i echo-3-linux-amd64.bundle.tar.gz            # once
docker run --rm -v "$PWD:/work" localhost/scantor/echo:3    # every run
```

Use bundles to hand a task to a colleague, to reproduce a measurement on another network, or to keep a
revision runnable outside the platform. The first half of this guide is for the owner of the task, the
second half for the recipient of the file.

> **A bundle contains the complete task image, including every file of the task folder. Anyone with the
> file can run and inspect it.** Share bundles only with people who may see your code, and never put
> credentials into the task folder or its image.

## Create a bundle

### In the web UI

Open the revision page (**Tasks → your task → Revisions → the revision**) and choose **Bundle** in the
header, next to **Download source**. The dialog shows the warning above and **Create bundle**. Building a
bundle takes a while for large task images; the dialog shows the state and the elapsed time while it
waits. A ready bundle shows its platform, size, expiry, file name, SHA-256 and runtime version,
**Download bundle**, and the recipient's commands (load once, run, describe) to copy. A failed bundle
shows its error and **Try again**.

The button is disabled, with the reason as tooltip, while the revision is not ready and for privileged
revisions.

### With the CLI

```sh
scantor revisions bundle echo@3                    # create or reuse it, wait, download and verify it
scantor revisions bundle echo@latest --rebuild     # replace a ready bundle with a new one
scantor revisions bundle echo@3 --no-download      # wait until it is ready and show it, download nothing
scantor revisions bundle echo@3 --file - | docker load
```

`scantor revisions bundle` waits until the bundle is ready (at most `--timeout`), saves it in the current
directory under its file name `<task>-<number>-<os>-<arch>.bundle.tar.gz`, checks its size and SHA-256,
and prints the recipient's commands on stderr. `--file` saves it elsewhere (`-` writes it to stdout),
`--force` replaces an existing file, and `-o json` prints `{bundle, file}`. A bundle that fails exits with
code 3; a revision that is not ready or is privileged exits with code 2.

### What to know

- **One bundle per revision.** Creating it again returns the same bundle while it is being built or
  ready. **Try again** in the UI and `--rebuild` replace it; a failed or expired bundle is replaced on the
  next create. A bundle records the scantor version of the runtime inside it: after the platform was
  upgraded, the next create builds a new bundle with the new runtime. An existing bundle never changes,
  so runtime fixes reach a recipient only through a new bundle.
- **Retention.** A bundle is kept for a number of days that the operator of your instance sets; the
  dialog and `scantor revisions bundle --no-download` show when it expires. Afterwards, create it again.
  A download link is valid for 10 minutes; the web UI and the CLI fetch a fresh one when needed.
- **Size.** The file holds the whole task image, base image included, compressed with gzip: from tens to
  hundreds of MB. Bundles do not count toward your storage quota.
- **One platform.** A bundle runs natively on the platform of the revision image, which is the master's
  (`linux/amd64` or `linux/arm64`, in the file name). Other machines need emulation: Docker Desktop on
  Apple Silicon runs `amd64` images out of the box; on Linux, register QEMU once with
  `docker run --privileged --rm tonistiigi/binfmt --install all`. Emulated runs are slower.
- **Privileged revisions** (Docker inside the task) cannot be bundled.
- **No MCP tool.** Agents cannot create or download bundles; create them in the web UI or with the CLI.
- **What is inside.** The task image, the runtime at `/scantor/scantor`, and `/scantor/bundle.json`: the
  revision's schemas with their defaults, its secret and upload fields, its settings defaults and the
  limits of your instance (result, file and config sizes, the largest `processes`). A bundle contains no
  configs or secrets of your scans, no credentials, no addresses of your instance and no ids of your
  account: the recipient supplies the configs, and secret fields have no defaults.

## Run a bundle

### Requirements

- Docker Engine 25 or newer, or a current Docker Desktop. Podman should work but is not tested.
- A machine of the bundle's platform (the file name says which), or emulation (above).
- Network access only if the task needs it ([templates and data sources](#templates-and-data-sources)).

### Load once

```sh
sha256sum echo-3-linux-amd64.bundle.tar.gz      # compare with the SHA-256 the owner gives you
docker load -i echo-3-linux-amd64.bundle.tar.gz
```

This loads the image `localhost/scantor/<task>:<number>`. The `localhost/` prefix keeps Docker from
pulling an image of the same name from a registry if you forget to load the file: the run then fails with
an error such as "Unable to find image" instead.

### Run

Run each bundle in a folder of its own, mounted at `/work`, the only mount a bundle needs:

```sh
mkdir echo-runs && cd echo-runs
docker run --rm -v "$PWD:/work" localhost/scantor/echo:3
```

Without flags, the bundle runs the revision's schedule with the default configs and every analysis it
produces, then writes the results to `results/<UTC time>/` in the folder. `--help` prints the flags and
examples with the image's name:

```sh
docker run --rm localhost/scantor/echo:3 --help
```

The mount depends on your shell:

| Shell | Mount |
|---|---|
| bash, zsh (Linux, macOS, WSL) | `-v "$PWD:/work"` |
| PowerShell | `-v "${PWD}:/work"` |
| cmd | `-v "%cd%:/work"` |
| Git Bash | `-v "$PWD:/work"`, with `MSYS_NO_PATHCONV=1` in front of `docker run` |

Without a mount, the bundle stops before it starts (exit code 2) and prints the `-v` option it needs:
results written inside the container would be lost.

### Flags

The flags mirror those of a scan.

| Flag | Meaning |
|---|---|
| `--task-config <json>` | the task config: inline JSON, `@file` (a path relative to `/work`) or `-` (stdin, which needs `docker run -i`) |
| `--scan-config <json>` | the scan config, in the same forms; a string at an upload field is the path of a file ([below](#files-at-upload-fields)) |
| `--analysis-config <json>` | run `run` once (seq 0) with this analysis config and skip the schedule |
| `--settings <json>` | settings ([below](#settings)), in the same forms |
| `--processes <n>` | analyses that run at the same time; overrides `processes` of `--settings` |
| `--limit <n>` | take at most n analyses from the schedule; `0` or no flag runs the whole schedule |
| `--total-timeout <duration>` | stop the run after this time, for example `2h30m`; `0` or no flag is no limit |
| `--out <dir>` | the run directory, relative to `/work`; it must not exist or must be empty. Default: `results/<UTC time>` |
| `--log-tails <which>` | which lines of `results.jsonl` keep the end of the analysis log: `failed` (default), `all` or `none` |
| `--describe` | print the bundle, the effective configs and settings, the schemas and the recommended limits, then exit |
| `-o json` | print the events as NDJSON instead of the human output (with `--describe`: one JSON document) |
| `--help` | print the flags |

At most one flag may read stdin.

### Configs

A config flag gives the whole config; every field you leave out takes the default of the task's schema,
as in a scan:

```sh
docker run --rm -v "$PWD:/work" localhost/scantor/http-title:2 \
  --task-config '{"timeoutSeconds": 10}' --scan-config @scan.json --processes 4 --limit 100
docker run --rm -i -v "$PWD:/work" localhost/scantor/http-title:2 --task-config - < task.json
```

The configs and settings are checked before anything runs. Each problem is printed as `path: message`,
the run exits with code 2 and writes nothing. For a task that uses a template unwrapped, the scan config
is the template's ([templates](templates.md)). `--describe` shows the schemas and the configs that a run
would use.

### Files at upload fields

Where a scan on the platform takes the id of an uploaded file, for example the `upload` field of the
`list` template, a bundle run takes the path of a file in the mounted folder:

```sh
printf 'example.org\nexample.com\n' > domains.txt
docker run --rm -v "$PWD:/work" localhost/scantor/http-title:2 --scan-config '{"upload": "domains.txt"}'
```

Relative paths are relative to `/work`; absolute paths inside the container work too. The file is hashed
before the run and recorded in `run.json`. An upload id of the platform cannot be read outside it: a
UUID at an upload field exits with code 2. `--describe` lists the upload fields.

### Secrets

Secret fields have no defaults in a bundle; pass them in the configs. `--describe` lists them, and every
file and output of the run shows them as `***`; a secret that fails a check of the schema, such as a
pattern, is reported with the rule it breaks, never with its value. A config whose secret is `***` itself
is refused (exit code 2), so masked output cannot be passed back by mistake. Prefer `@file` or stdin to inline JSON for
configs with secrets: other users of the machine can read command lines. The task's code can still print
or return a secret in a field that is not secret, as on the platform.

### Settings

`--settings` takes an object with any of these fields; the others keep the revision's settings defaults
(`backoff` is merged field by field):

| Setting | Allowed values |
|---|---|
| `processes` | 1 to the largest value of the instance the bundle comes from |
| `timeoutMs` | per analysis, 1 000 to 86 400 000 |
| `maxAttempts` | 1 to 20 |
| `backoff` | `initialMs` and `maxMs` 1 000 to 86 400 000 (`initialMs` ≤ `maxMs`), `factor` 1 to 10, `jitter` true or false |
| `maxAnalysesPerProcess` | 1 to 1 000 000 |

`workers`, `nodeSelector` and `privileged` do not exist in a bundle run, which is one container, and
`resources` is set with `docker run --cpus` and `--memory`: each of them exits with code 2. Retries happen
in the same container with the backoff of the settings, as in a scan; a retry that waits keeps its
process meanwhile. A task with its own schedule runs it in one more process beside the `processes` that
run analyses.

### Describe

```sh
docker run --rm localhost/scantor/echo:3 --describe
docker run --rm localhost/scantor/echo:3 --describe -o json | jq .recommended
docker run --rm -v "$PWD:/work" localhost/scantor/http-title:2 --describe --scan-config @scan.json
```

`--describe` needs no mount (except for `@file` values) and writes nothing. It prints the revision,
image, language, platform and schedule; the effective task, scan and analysis configs with secrets
masked; the effective settings; the secret and upload fields; the schemas of the task config and the
scan config; the recommended CPUs and memory with the [hardened command](#hardened-run); and the problems
of the given flags. It exits with code 2 when there are problems. With `-o json` it prints
`{bundle, taskConfig, scanConfig, analysisConfig, settings, schemas, secretPaths, uploadPaths,
recommended: {cpus, memoryBytes, dockerFlags}, issues}`.

### Results

Every run writes a new run directory, `results/<UTC time>/` (for example `results/20261120T090000Z/`,
with `-2`, `-3`, … when it exists, also for runs that start at the same time in one folder) or `--out`.
Nothing is resumed: a second run starts from the beginning.

| Path | Content |
|---|---|
| `results.jsonl` | one line per finished analysis, in the order they finished (not by `seq`), written while the run goes on |
| `files/<seq>/<file id>/<name>` | the files the analyses stored |
| `run.json` | what ran: the bundle, the effective configs and settings, `limit`, the files of upload fields, the template resolutions, and at the end the summary, the reason and the exit code |

A line of `results.jsonl`:

```json
{"at":"2026-11-20T09:00:02.210Z","seq":0,"status":"succeeded","attempt":1,"config":{},"result":{"echo":"Hello, World!"},"error":null,"files":[],"logTail":"","attempts":[],"timings":{"scheduledAt":"2026-11-20T09:00:02.100Z","startedAt":"2026-11-20T09:00:02.101Z","finishedAt":"2026-11-20T09:00:02.200Z","durationMs":99}}
```

- `status` is `succeeded` or `failed`; a failed line has `error` `{type, message, retryable, phase,
  attempt, stack?, details?, at}` with the types of [errors and retries](errors-and-retries.md), plus
  `cancelled` for analyses that a stop interrupted.
- `files[]` are `{id, name, size, sha256, contentType, path}`, with `path` relative to the run directory.
- `logTail` is the end of the analysis log, kept by default only on failed lines (`--log-tails`);
  `attempts[]` keeps the earlier attempts with their errors and log ends.
- Secrets are `***` in `config` and `result`.

`run.json` is rewritten while the run goes on (every 30 s and on each template resolution) and once at the
end. While the run is still going, `reason` and `exitCode` are `null`; at the end `reason` is `done`,
`limit` (the `--limit` was reached), `scheduleFailed`, `startFailed`, `timeout`, `interrupted` or
`outputFailed` (the run directory could not be written), and `summary` is `{analyses, succeeded, failed}`.

Read them with `jq`:

```sh
cd results/20261120T090000Z
jq '{reason, exitCode, summary}' run.json
jq -c 'select(.status == "succeeded") | {seq, result}' results.jsonl
jq -r 'select(.status == "failed") | [.seq, .error.type, .error.message] | @tsv' results.jsonl
jq -s 'group_by(.status) | map({status: .[0].status, analyses: length})' results.jsonl
jq -s 'sort_by(.seq) | .[] | .result' results.jsonl > results-by-seq.json
jq -r '.files[].path' results.jsonl
```

### Output

The human output (stdout) is a start line with the revision, platform, schedule, processes, limit and run
directory, the template resolutions, a progress line every 10 seconds (elapsed time, done, succeeded,
failed, running, rate and the share of the expected total when it is known), the first 10 failures, and a
summary with the paths and the exit code. Output of the task's code outside analyses and errors of the
run go to stderr; the log of each analysis is not printed (`results.jsonl` keeps its end).

With `-o json`, stdout carries one JSON event per line, secrets masked: `start`, `resolved`, `scheduled`,
`log`, `attempt`, `result`, `error` and, last, `end` with the reason, the summary and the exit code. A
bundle run streams: analyses run while the schedule still produces them, so `result` events and lines of
`results.jsonl` appear long before a large schedule ends.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | every analysis succeeded (also when the schedule produced none) |
| 1 | at least one analysis failed, or the schedule failed |
| 2 | invalid flags, configs, settings or run directory, or the task's code does not start |
| 3 | platform failure: the run was interrupted or reached `--total-timeout`, the task's code failed to start three times in a row during the run, the run directory could not be written, an environment variable is invalid, or the image is no bundle |

### Stop a run

Ctrl-C (also `docker kill -s INT`) or `docker stop` ends the run at once: the analyses in progress are
recorded as failed with error type `cancelled`, the analyses not yet started are dropped, `run.json` gets
`reason: "interrupted"`, and the exit code is 3. `--total-timeout` ends a run the same way with reason
`timeout`. A stopped run cannot be resumed; start a new one, with `--limit` or a smaller scan config if
needed.

### File ownership

On Linux with rootful Docker, the bundle runs as root and gives every file it creates to the owner of the
mounted folder, so the results belong to you. With rootless Docker and Docker Desktop they belong to you
anyway. When the task image runs as another user, the mounted folder must be writable by that user, or
run the bundle as yourself:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" localhost/scantor/echo:3
```

### Templates and data sources

Templates `single`, `range`, `repeat`, `cidr` and `list` (inline items or a file at its upload field)
need no network. `tranco` and `crux` download their lists when the run starts. The same holds for a task
that wraps one of them in its own schedule. These variables point them at other sources, for example a
mirror (`http` or `https`; an invalid value exits with code 3):

```sh
docker run --rm -v "$PWD:/work" -e SCANTOR_TRANCO_URL=https://tranco.mirror.example \
  -e SCANTOR_CRUX_URL=https://crux.mirror.example -e SCANTOR_CRUX_CACHE_URL=https://crux-cache.mirror.example \
  localhost/scantor/top-sites:4
```

Without them, a bundle run uses the public sources. Behind an intercepting proxy, pass its CA
certificates (PEM) for these downloads with `-e SCANTOR_CA_CERT="$(cat proxy-ca.pem)"`. The task's own
code never sees `SCANTOR_CA_CERT`: it trusts what its image trusts.

### Hardened run

A bundle run is not sandboxed like a worker on the platform: no egress rules apply and the container has
Docker's default privileges unless you restrict them. This command keeps only what the bundle needs to
write your results, and bounds processes, CPUs and memory:

```sh
docker run --rm -v "$PWD:/work" \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --pids-limit 4096 --cpus 1 --memory 768m \
  localhost/scantor/echo:3
```

`--describe` prints this command with the recommended `--cpus` and `--memory` for the settings you pass:
the per-process resources of the revision times the processes (one more for a task with its own
schedule), plus 256 MiB. Add `--cap-add NET_RAW` only for tasks that need raw sockets (for example
ping), and `--network none` for tasks that need no network.

### Security advice

- Run only bundles from people you trust, and check the SHA-256 they give you before `docker load`.
- The task's code can read and change everything in `/work`: run each bundle in a folder of its own,
  never in your home directory or a folder with other data.
- The code can reach your network and the internet unless you pass `--network none`.
- Remove the image when you no longer need it: `docker image rm localhost/scantor/echo:3`.

### Troubleshooting

| Message | Cause and fix |
|---|---|
| `Unable to find image 'localhost/scantor/…'`, `pull access denied` | the file was not loaded: `docker load -i <file>` |
| `exec format error`, a platform warning | the bundle is for another architecture: enable emulation ([what to know](#what-to-know)) |
| `… is inside the container, so the results would be lost` | no mount: add `-v "$PWD:/work"` (see the shell table) |
| `… is not empty; every run needs a new or empty directory` | `--out` names a directory with files, or another run started in it: choose another one |
| `permission denied` in `/work` | the image runs as another user: use `--user "$(id -u):$(id -g)"` or make the folder writable |
| `… is a platform upload id` | an upload field holds an upload id: give the path of a file in the folder |
| `… is the mask "***" of a secret` | the config was copied from masked output: give the secret itself |
