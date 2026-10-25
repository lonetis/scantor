# CLI reference

<!-- Generated from the cobra command tree by `just docs` (hidden command `scantor docs cli`); do not edit. -->

The `scantor` CLI authors, validates, publishes and runs tasks and inspects scans and results. It is a
single binary (release downloads for Linux and macOS) and also runs through the Docker shim `scantor.sh`.

- **Credentials** come only from `SCANTOR_URL` and `SCANTOR_TOKEN` (an API key from "CLI & MCP access" in the web
  UI). The other variables the CLI reads are listed in the CLI section of `.env.example`.
- **Output**: human-readable by default; `-o json` prints JSON on stdout (one document, or one object per line
  for streams such as `scans watch` and `revisions logs`). Progress and errors go to stderr; in JSON mode
  errors are printed as `{"error": {code, message, exitCode, …}}`. Human output shows control characters
  escaped (`\x1b`), so task-controlled text cannot drive the terminal; raw content (`tasks files cat`,
  `scans worker logs`) keeps its exact bytes in a pipe or file, and `-o json` always carries the exact text.
- **Exit codes**:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | analyses failed: `dev run`, and the waiting scan commands (`scans start --wait`, `scans get --wait`, `scans watch`) when the scan failed, was cancelled, paused by the circuit breaker, or completed with failed or lost analyses |
| 2 | invalid input: usage, configuration, task content, configs, requests the platform rejected (4xx except 408, 426 and 429) |
| 3 | platform failure: Docker, network, orchestrator errors (5xx), rate limits (429), request timeouts (408), version mismatches (426), timeouts, interrupts |


## scantor

Run scanning tasks at scale

### Synopsis

scantor runs user-defined scanning tasks at large scale. The CLI authors, validates, publishes and runs tasks and inspects scans and results.

Credentials come only from SCANTOR_URL and SCANTOR_TOKEN.

```
scantor [flags]
```

### Options

```
  -h, --help            help for scantor
  -o, --output format   output format: human or json (default human)
  -v, --version         version for scantor
```

### SEE ALSO

* [scantor analyses](#scantor-analyses)	 - Inspect and query the analyses of a scan
* [scantor completion](#scantor-completion)	 - Generate the autocompletion script for the specified shell
* [scantor dev](#scantor-dev)	 - Run and debug a task folder
* [scantor export](#scantor-export)	 - Export the analyses of a scan as JSONL or CSV
* [scantor exports](#scantor-exports)	 - Manage background exports of scan results
* [scantor files](#scantor-files)	 - Download the files attached to analyses
* [scantor init](#scantor-init)	 - Create a task folder from a scaffold
* [scantor instance](#scantor-instance)	 - Show the orchestrator's version, URLs, features and limits
* [scantor jobs](#scantor-jobs)	 - Inspect background jobs (deletions, retries, exports, builds)
* [scantor node](#scantor-node)	 - Run the node daemon that runs workers on this Docker host
* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)
* [scantor push](#scantor-push)	 - Upload a task folder and publish a revision
* [scantor revisions](#scantor-revisions)	 - Publish and inspect task revisions
* [scantor scans](#scantor-scans)	 - Start, follow and control scans
* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files
* [scantor templates](#scantor-templates)	 - List the templates and estimate scan sizes
* [scantor uploads](#scantor-uploads)	 - Upload list files for scans of the list template
* [scantor validate](#scantor-validate)	 - Run every publish check on a task folder with local Docker
* [scantor version](#scantor-version)	 - Print the scantor version
* [scantor whoami](#scantor-whoami)	 - Show the account of SCANTOR_TOKEN


## scantor analyses

Inspect and query the analyses of a scan

```
scantor analyses [flags]
```

### Options

```
  -h, --help   help for analyses
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor analyses aggregate](#scantor-analyses-aggregate)	 - Run a MongoDB aggregation over the analyses of a scan
* [scantor analyses get](#scantor-analyses-get)	 - Show one analysis
* [scantor analyses list](#scantor-analyses-list)	 - List the analyses of a scan by seq
* [scantor analyses query](#scantor-analyses-query)	 - Query the analyses of a scan with a MongoDB filter


## scantor analyses aggregate

Run a MongoDB aggregation over the analyses of a scan

### Synopsis

Run a MongoDB aggregation pipeline (a JSON array of stages) over the analyses of a scan. Allowed stages: $match, $project, $addFields, $set, $unset, $group, $sort, $limit, $skip, $count, $unwind, $bucket, $bucketAuto, $sortByCount, $facet, $replaceRoot, $replaceWith and $sample. Pipelines that reference secret config values are rejected. Humans get one compact JSON document per line. Filters, projections, sorts and pipelines are MongoDB documents given inline, as @file or as - (stdin); they always apply to this scan only. Operators that execute code or read other collections ($where, $function, $lookup, $out, …) are rejected.

```
scantor analyses aggregate <scan> [flags]
```

### Examples

```
  scantor analyses aggregate 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --pipeline '[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]'
```

### Options

```
  -h, --help              help for aggregate
      --limit int         maximum number of output documents (≤ the instance limit)
      --pipeline string   aggregation pipeline (JSON array, @file or -)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor analyses](#scantor-analyses)	 - Inspect and query the analyses of a scan


## scantor analyses get

Show one analysis

### Synopsis

Show one analysis, addressed as &lt;scanId&gt;-&lt;seq&gt;: status, config, result, error, attempts, files and log tail. Download its files with 'scantor files get'.

```
scantor analyses get <analysis> [flags]
```

### Examples

```
  scantor analyses get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42
```

### Options

```
  -h, --help   help for get
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor analyses](#scantor-analyses)	 - Inspect and query the analyses of a scan


## scantor analyses list

List the analyses of a scan by seq

### Synopsis

List the analyses of a scan in schedule order (seq ascending). Resume a listing with --after-seq (the last seq printed). --fields limits the returned fields to dot paths.

```
scantor analyses list <scan> [flags]
```

### Examples

```
  scantor analyses list 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --status failed
  scantor analyses list 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --after-seq 999 --limit 1000 -o json
```

### Options

```
      --after-seq int    start after this seq
      --fields strings   return only these fields (dot paths, comma-separated)
  -h, --help             help for list
      --limit int        maximum number of analyses (server default 50, max 1000)
      --status strings   only analyses with these statuses (pending, retrying, succeeded, failed, lost, cancelled)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor analyses](#scantor-analyses)	 - Inspect and query the analyses of a scan


## scantor analyses query

Query the analyses of a scan with a MongoDB filter

### Synopsis

Find analyses of a scan with a MongoDB filter, optionally with a projection and a sort. Results are sorted by seq unless --sort is given; continue an unsorted query with --after-seq (the cursor it printed). Humans get one compact JSON document per line. Filters, projections, sorts and pipelines are MongoDB documents given inline, as @file or as - (stdin); they always apply to this scan only. Operators that execute code or read other collections ($where, $function, $lookup, $out, …) are rejected.

```
scantor analyses query <scan> [flags]
```

### Examples

```
  scantor analyses query 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --filter '{"result.status": {"$gte": 500}}' --projection '{"config": 1, "result.status": 1}'
  scantor analyses query 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --filter @filter.json --limit 1000 -o json
```

### Options

```
      --after-seq int       continue after this seq (unsorted queries)
      --filter string       MongoDB filter (JSON object, @file or -; default {})
  -h, --help                help for query
      --limit int           maximum number of documents (server default 20, max 1000)
      --projection string   MongoDB projection (JSON object, @file or -)
      --sort string         MongoDB sort (JSON object, @file or -)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor analyses](#scantor-analyses)	 - Inspect and query the analyses of a scan


## scantor completion

Generate the autocompletion script for the specified shell

### Synopsis

Generate the autocompletion script for scantor for the specified shell.
See each sub-command's help for details on how to use the generated script.


### Options

```
  -h, --help   help for completion
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor completion bash](#scantor-completion-bash)	 - Generate the autocompletion script for bash
* [scantor completion fish](#scantor-completion-fish)	 - Generate the autocompletion script for fish
* [scantor completion powershell](#scantor-completion-powershell)	 - Generate the autocompletion script for powershell
* [scantor completion zsh](#scantor-completion-zsh)	 - Generate the autocompletion script for zsh


## scantor completion bash

Generate the autocompletion script for bash

### Synopsis

Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

	source &lt;(scantor completion bash)

To load completions for every new session, execute once:

#### Linux:

	scantor completion bash &gt; /etc/bash_completion.d/scantor

#### macOS:

	scantor completion bash &gt; $(brew --prefix)/etc/bash_completion.d/scantor

You will need to start a new shell for this setup to take effect.


```
scantor completion bash
```

### Options

```
  -h, --help              help for bash
      --no-descriptions   disable completion descriptions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor completion](#scantor-completion)	 - Generate the autocompletion script for the specified shell


## scantor completion fish

Generate the autocompletion script for fish

### Synopsis

Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

	scantor completion fish | source

To load completions for every new session, execute once:

	scantor completion fish &gt; ~/.config/fish/completions/scantor.fish

You will need to start a new shell for this setup to take effect.


```
scantor completion fish [flags]
```

### Options

```
  -h, --help              help for fish
      --no-descriptions   disable completion descriptions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor completion](#scantor-completion)	 - Generate the autocompletion script for the specified shell


## scantor completion powershell

Generate the autocompletion script for powershell

### Synopsis

Generate the autocompletion script for powershell.

To load completions in your current shell session:

	scantor completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.


```
scantor completion powershell [flags]
```

### Options

```
  -h, --help              help for powershell
      --no-descriptions   disable completion descriptions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor completion](#scantor-completion)	 - Generate the autocompletion script for the specified shell


## scantor completion zsh

Generate the autocompletion script for zsh

### Synopsis

Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

	echo "autoload -U compinit; compinit" &gt;&gt; ~/.zshrc

To load completions in your current shell session:

	source &lt;(scantor completion zsh)

To load completions for every new session, execute once:

#### Linux:

	scantor completion zsh &gt; "${fpath[1]}/_scantor"

#### macOS:

	scantor completion zsh &gt; $(brew --prefix)/share/zsh/site-functions/_scantor

You will need to start a new shell for this setup to take effect.


```
scantor completion zsh [flags]
```

### Options

```
  -h, --help              help for zsh
      --no-descriptions   disable completion descriptions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor completion](#scantor-completion)	 - Generate the autocompletion script for the specified shell


## scantor dev

Run and debug a task folder

```
scantor dev [flags]
```

### Options

```
  -h, --help   help for dev
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor dev debug](#scantor-dev-debug)	 - Run a task folder under a debugger and wait for your IDE to attach
* [scantor dev run](#scantor-dev-run)	 - Build and run a task folder (locally, or as a platform test run)


## scantor dev debug

Run a task folder under a debugger and wait for your IDE to attach

### Synopsis

Like 'dev run' on local Docker, with one connector process started by the base image's debug command (debugpy, the Node inspector or Delve; Go is built with SCANTOR_GCFLAGS="all=-N -l"), timeouts disabled, and the debugger port published on 127.0.0.1. The scaffold's launch configuration 'scantor: attach to dev debug' attaches to it. Debugging needs local Docker, so it is not available with SCANTOR_DEV_MODE=remote (exit 3).

```
scantor dev debug [dir] [flags]
```

### Examples

```
  scantor dev debug
  scantor dev debug ./echo --analysis-config '{}'
```

### Options

```
      --analysis-config string   run once with this analysis config and skip schedule: JSON, @file or - (stdin)
  -h, --help                     help for debug
      --limit int                maximum number of analyses taken from the schedule (default 1)
      --max-attempts int         attempts per analysis (default 1)
      --scan-config string       scan config: JSON, @file or - (stdin)
      --task-config string       task config: JSON, @file or - (stdin)
      --timeout duration         per-analysis timeout, for example 30s (default: the manifest's)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor dev](#scantor-dev)	 - Run and debug a task folder


## scantor dev run

Build and run a task folder (locally, or as a platform test run)

### Synopsis

Build the task folder on the local Docker daemon (as validate, without the type check), describe it, validate the configs against its schemas with defaults filled, and run it in the runtime's local mode: schedule (at most --limit analyses), then run. Nothing is bind-mounted; files the task produces are copied to .scantor/out/&lt;timestamp&gt;/files/ in the folder.

With --remote, or SCANTOR_DEV_MODE=remote (set in the editor), the run is a test run on the platform: outside the editor the folder is first uploaded into the task's workspace without publishing (--force replaces unpublished workspace changes), then the test run is followed and its files are downloaded.

Events are printed as they happen; with -o json one JSON object per line (local: the runtime's local-mode events; remote: {"type": &lt;event&gt;, "data": &lt;payload&gt;} per test-run event). Exit codes: 0 all analyses succeeded, 1 some failed, 2 invalid task or configs, 3 platform failure.

```
scantor dev run [dir] [flags]
```

### Examples

```
  scantor dev run
  scantor dev run ./echo --task-config '{"text": "hi"}' --limit 2
  scantor dev run --analysis-config @analysis.json -o json
  scantor dev run --remote
```

### Options

```
      --analysis-config string   run once with this analysis config and skip schedule: JSON, @file or - (stdin)
      --force                    with --remote: replace unpublished changes of the platform workspace
  -h, --help                     help for run
      --limit int                maximum number of analyses taken from the schedule (default 5)
      --max-attempts int         attempts per analysis (default 1)
      --remote                   run a test run on the platform instead of local Docker
      --scan-config string       scan config: JSON, @file or - (stdin)
      --task-config string       task config: JSON, @file or - (stdin)
      --timeout duration         per-analysis timeout, for example 30s (default: the manifest's)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor dev](#scantor-dev)	 - Run and debug a task folder


## scantor export

Export the analyses of a scan as JSONL or CSV

### Synopsis

Export the analyses of a scan, sorted by seq, as JSON Lines (whole analysis documents or the --fields projection) or CSV. Secret config values are masked.

By default the export streams directly to --file or stdout; this works up to the instance's inline limit. Larger exports run in the background with --background: the command prints the export, or with --wait (implied by --file) waits until it is ready and downloads it. Background exports are kept for a limited time; see 'scantor exports'.

```
scantor export <scan> [flags]
```

### Examples

```
  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f > results.jsonl
  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --format csv --status succeeded --fields seq,config,result --file results.csv
  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --background --file results.jsonl
```

### Options

```
      --after-seq int      start after this seq
      --background         run the export as a background job (for large scans)
      --fields strings     fields to export (dot paths, comma-separated; CSV columns)
  -f, --file string        write the export to this file (- = stdout)
      --filter string      MongoDB filter (JSON object, @file or -)
      --force              overwrite an existing file
      --format string      jsonl or csv (default "jsonl")
  -h, --help               help for export
      --status strings     only analyses with these statuses (comma-separated)
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the background export is ready (implied by --file)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor exports

Manage background exports of scan results

```
scantor exports [flags]
```

### Options

```
  -h, --help   help for exports
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor exports delete](#scantor-exports-delete)	 - Delete a background export
* [scantor exports get](#scantor-exports-get)	 - Show or download a background export
* [scantor exports list](#scantor-exports-list)	 - List background exports


## scantor exports delete

Delete a background export

### Synopsis

Delete a background export and its file before it expires.

```
scantor exports delete <export> [flags]
```

### Options

```
  -h, --help   help for delete
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor exports](#scantor-exports)	 - Manage background exports of scan results


## scantor exports get

Show or download a background export

### Synopsis

Show a background export. With --wait the command waits until it is ready or failed; with --file it also downloads the export (implies --wait).

```
scantor exports get <export> [flags]
```

### Examples

```
  scantor exports get 8c1f6d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f --file results.jsonl
```

### Options

```
  -f, --file string        write the export to this file (- = stdout)
      --force              overwrite an existing file
  -h, --help               help for get
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the export is ready or failed
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor exports](#scantor-exports)	 - Manage background exports of scan results


## scantor exports list

List background exports

### Synopsis

List your background exports, newest first.

```
scantor exports list [flags]
```

### Examples

```
  scantor exports list --scan 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for list
      --limit int       maximum number of items (server default 50, max 200)
      --scan string     only exports of this scan
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor exports](#scantor-exports)	 - Manage background exports of scan results


## scantor files

Download the files attached to analyses

```
scantor files [flags]
```

### Options

```
  -h, --help   help for files
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor files get](#scantor-files-get)	 - Download a file of an analysis


## scantor files get

Download a file of an analysis

### Synopsis

Download a file attached to an analysis (addressed as &lt;scanId&gt;-&lt;seq&gt;) by its file id, as listed by 'scantor analyses get'. The file is saved under its recorded name in the current directory unless --file names another path (- writes to stdout). Size and SHA-256 are verified; an existing file is only replaced with --force.

```
scantor files get <analysis> <file> [flags]
```

### Examples

```
  scantor files get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42 0c2d8a7b-4c3d-4e1f-9a3b-4c5d6e7f5e1f
  scantor files get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42 0c2d8a7b-4c3d-4e1f-9a3b-4c5d6e7f5e1f --file - | less
```

### Options

```
  -f, --file string   write the file to this file (- = stdout)
      --force         overwrite an existing file
  -h, --help          help for get
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor files](#scantor-files)	 - Download the files attached to analyses


## scantor init

Create a task folder from a scaffold

### Synopsis

Create a task folder from the scaffold of a language and a template. The folder publishes unchanged.

dir defaults to ./&lt;name&gt;; --name defaults to the slugified base name of dir; --template defaults to single (use a template name or "custom" for a custom schedule). An existing non-empty directory is refused.

```
scantor init [dir] [flags]
```

### Examples

```
  scantor init echo --language python
  scantor init --name origins --language typescript --template crux
```

### Options

```
      --description string   task description
  -h, --help                 help for init
      --language string      task language (go, javascript, python, typescript)
      --name string          task name (default: the slugified base name of dir)
      --template string      template name or "custom" (default "single")
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor instance

Show the orchestrator's version, URLs, features and limits

### Synopsis

Show the version of the orchestrator at SCANTOR_URL, its public, editor and MCP URLs, the CLI image, the enabled features and the instance limits (maximum workers per scan, processes per worker, result and file sizes, the scan confirmation threshold).

```
scantor instance [flags]
```

### Options

```
  -h, --help   help for instance
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor jobs

Inspect background jobs (deletions, retries, exports, builds)

```
scantor jobs [flags]
```

### Options

```
  -h, --help   help for jobs
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor jobs get](#scantor-jobs-get)	 - Show a background job
* [scantor jobs list](#scantor-jobs-list)	 - List background jobs


## scantor jobs get

Show a background job

### Synopsis

Show a background job. With --wait the command waits until the job has succeeded, failed or been cancelled, and exits with code 3 unless it succeeded.

```
scantor jobs get <job> [flags]
```

### Examples

```
  scantor jobs get d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a --wait
```

### Options

```
  -h, --help               help for get
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the job has finished
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor jobs](#scantor-jobs)	 - Inspect background jobs (deletions, retries, exports, builds)


## scantor jobs list

List background jobs

### Synopsis

List your background jobs, newest first: revision builds, test runs, scan deletions, retry-failed runs, exports, task deletions and (admins) user purges.

```
scantor jobs list [flags]
```

### Examples

```
  scantor jobs list
  scantor jobs list --kind scanDelete --state running
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for list
      --kind string     only jobs of this kind (revisionBuild, testRun, scanDelete, scanRetryFailed, export, taskDelete, userPurge)
      --limit int       maximum number of items (server default 50, max 200)
      --state string    only jobs in this state (queued, running, succeeded, failed, cancelled)
      --user string     only jobs of this user id (admins)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor jobs](#scantor-jobs)	 - Inspect background jobs (deletions, retries, exports, builds)


## scantor node

Run the node daemon that runs workers on this Docker host

### Synopsis

Run the node daemon. It registers with the orchestrator at SCANTOR_URL, long-polls the workers assigned to this node and runs them as containers on the local Docker engine (Docker socket required). Remote nodes authenticate with SCANTOR_NODE_TOKEN; the master's built-in node sets SCANTOR_NODE_BUILTIN=true. Configuration comes only from the environment (see .env.example).

On SIGTERM the daemon stops and leaves its workers running; the next daemon adopts them.

```
scantor node [flags]
```

### Options

```
  -h, --help   help for node
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor node healthcheck](#scantor-node-healthcheck)	 - Check that the node daemon reported its status recently


## scantor node healthcheck

Check that the node daemon reported its status recently

### Synopsis

Exit 0 when the node daemon's last successful status report is younger than three status intervals, and 1 otherwise. It reads /tmp/scantor-node.status inside the daemon container and is the container healthcheck of the node service.

```
scantor node healthcheck [flags]
```

### Options

```
  -h, --help   help for healthcheck
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor node](#scantor-node)	 - Run the node daemon that runs workers on this Docker host


## scantor nodes

Manage the nodes that run workers (admins)

```
scantor nodes [flags]
```

### Options

```
  -h, --help   help for nodes
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor nodes create](#scantor-nodes-create)	 - Create a remote node and print its token and join command
* [scantor nodes delete](#scantor-nodes-delete)	 - Delete a node
* [scantor nodes events](#scantor-nodes-events)	 - List the timeline of a node
* [scantor nodes get](#scantor-nodes-get)	 - Show a node
* [scantor nodes join](#scantor-nodes-join)	 - Print the commands that start a node's daemon
* [scantor nodes list](#scantor-nodes-list)	 - List nodes
* [scantor nodes token](#scantor-nodes-token)	 - Rotate or revoke a node's token
* [scantor nodes update](#scantor-nodes-update)	 - Change a node's name, pool, labels, worker cap or cordon
* [scantor nodes workers](#scantor-nodes-workers)	 - List the workers placed on a node


## scantor nodes create

Create a remote node and print its token and join command

### Synopsis

Create a remote node record and print its node token (shown only once) with a docker run command and a Docker Compose file that start the node daemon on the node host. The node stays pending until its daemon says hello. Admins only.

```
scantor nodes create <name> [flags]
```

### Examples

```
  scantor nodes create scan-eu-1 --pool remote --label region=eu --max-workers 8
```

### Options

```
  -h, --help                help for create
      --label stringArray   label key=value (repeatable)
      --max-workers int     maximum number of workers on the node (default: what the daemon reports)
      --pool string         node pool scans select with nodeSelector.pool (server default "shared")
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes delete

Delete a node

### Synopsis

Delete a node: its token is revoked, its workers become lost and are replaced elsewhere, and the record is removed. The built-in node cannot be deleted. A node is addressed by its id or its name.

```
scantor nodes delete <node> [flags]
```

### Options

```
  -h, --help   help for delete
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes events

List the timeline of a node

### Synopsis

List the events of a node, newest first: hellos, state changes, lost workers and more. A node is addressed by its id or its name.

```
scantor nodes events <node> [flags]
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for events
      --limit int       maximum number of items (server default 50, max 200)
      --type string     only events of this type
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes get

Show a node

### Synopsis

Show a node: state, endpoint profile, pool, labels, reported host info and instance lease. A node is addressed by its id or its name.

```
scantor nodes get <node> [flags]
```

### Examples

```
  scantor nodes get scan-eu-1
```

### Options

```
  -h, --help   help for get
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes join

Print the commands that start a node's daemon

### Synopsis

Print the docker run command and the Docker Compose file that start the node daemon of a node, with the token replaced by ${SCANTOR_NODE_TOKEN} (the token itself is only shown when the node is created or its token rotated). A node is addressed by its id or its name.

```
scantor nodes join <node> [flags]
```

### Options

```
  -h, --help   help for join
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes list

List nodes

### Synopsis

List every node with its state, pool, architecture, worker usage and last heartbeat. Admins only.

```
scantor nodes list [flags]
```

### Examples

```
  scantor nodes list --state online
```

### Options

```
  -h, --help           help for list
      --pool string    only nodes of this pool
      --state string   only nodes in this state (pending, online, offline, revoked)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes token

Rotate or revoke a node's token

```
scantor nodes token [flags]
```

### Options

```
  -h, --help   help for token
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)
* [scantor nodes token revoke](#scantor-nodes-token-revoke)	 - Revoke a node's token
* [scantor nodes token rotate](#scantor-nodes-token-rotate)	 - Replace a node's token


## scantor nodes token revoke

Revoke a node's token

### Synopsis

Revoke a node's token: the node becomes revoked, its workers become lost immediately and registry pulls are denied. Rotate the token to bring it back. Not allowed for the built-in node. A node is addressed by its id or its name.

```
scantor nodes token revoke <node> [flags]
```

### Options

```
  -h, --help   help for revoke
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes token](#scantor-nodes-token)	 - Rotate or revoke a node's token


## scantor nodes token rotate

Replace a node's token

### Synopsis

Replace a node's token and print the new one (shown only once) with the join command. The running daemon is rejected from then on until it is restarted with the new token; a revoked node becomes pending again. Not allowed for the built-in node. A node is addressed by its id or its name.

```
scantor nodes token rotate <node> [flags]
```

### Options

```
  -h, --help   help for rotate
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes token](#scantor-nodes-token)	 - Rotate or revoke a node's token


## scantor nodes update

Change a node's name, pool, labels, worker cap or cordon

### Synopsis

Change a node. --label replaces all labels (repeat it for several); --clear-labels removes them all. --cordoned stops new workers from being placed on the node (--cordoned=false lifts it); running workers stay. A node is addressed by its id or its name.

```
scantor nodes update <node> [flags]
```

### Examples

```
  scantor nodes update scan-eu-1 --cordoned
  scantor nodes update scan-eu-1 --pool remote --label region=eu --label gpu=false --no-max-workers
```

### Options

```
      --clear-labels        remove every label
      --cordoned            stop placing new workers on the node
  -h, --help                help for update
      --label stringArray   label key=value; replaces all labels (repeatable)
      --max-workers int     maximum number of workers on the node
      --name string         new name
      --no-max-workers      use the worker cap the daemon reports
      --pool string         new pool
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor nodes workers

List the workers placed on a node

### Synopsis

List the workers whose node is this node, with their scan, role and state. A node is addressed by its id or its name.

```
scantor nodes workers <node> [flags]
```

### Examples

```
  scantor nodes workers scan-eu-1 --state running
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for workers
      --limit int       maximum number of items (server default 50, max 200)
      --state strings   only workers in these states (comma-separated)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor nodes](#scantor-nodes)	 - Manage the nodes that run workers (admins)


## scantor push

Upload a task folder and publish a revision

### Synopsis

Pack the task folder locally and upload it (docs/tasks.md §13): the manifest name selects or creates the task, the upload replaces its platform workspace, and a revision is published and built on the server unless --no-publish is given. The upload fails with workspaceDirty when the platform workspace has changes that were never published or synced (for example editor edits); --force replaces them.

Inside the editor (SCANTOR_WORKSPACE set and the folder inside it) the folder already is the workspace, so push only publishes a revision. With --wait the command waits for the build and exits 2 when the revision failed on its content, 3 on a platform failure.

```
scantor push [dir] [flags]
```

### Examples

```
  scantor push
  scantor push ./echo -m "add greeting option" --wait
  scantor push --no-publish
```

### Options

```
      --force              replace a platform workspace with unpublished changes
  -h, --help               help for push
  -m, --message string     revision message
      --no-publish         only update the platform workspace; publish no revision
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the revision is built (ready or failed)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor revisions

Publish and inspect task revisions

```
scantor revisions [flags]
```

### Options

```
  -h, --help   help for revisions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor revisions get](#scantor-revisions-get)	 - Show a revision
* [scantor revisions list](#scantor-revisions-list)	 - List the revisions of a task
* [scantor revisions logs](#scantor-revisions-logs)	 - Print the build log of a revision
* [scantor revisions publish](#scantor-revisions-publish)	 - Publish the task's workspace as a new revision


## scantor revisions get

Show a revision

### Synopsis

Show a revision: state, source, image, described schedule, settings defaults and structured errors. With --wait the command waits until the revision is ready or failed. A failed build exits with code 2 when the task content is invalid (pack, static, build, describe or check errors) and 3 when it failed for a platform reason (push, platform). A revision is addressed as &lt;task&gt;@&lt;number&gt;, &lt;task&gt;@latest (the newest ready revision), &lt;task&gt;@&lt;revisionId&gt; or &lt;task&gt; (= &lt;task&gt;@latest).

```
scantor revisions get <task>[@<revision>] [flags]
```

### Examples

```
  scantor revisions get echo@3
  scantor revisions get echo@latest -o json
```

### Options

```
  -h, --help               help for get
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the revision is ready or failed
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor revisions](#scantor-revisions)	 - Publish and inspect task revisions


## scantor revisions list

List the revisions of a task

### Synopsis

List the revisions of a task, newest first. A task is addressed by its name or its id.

```
scantor revisions list <task> [flags]
```

### Examples

```
  scantor revisions list echo --state ready
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for list
      --limit int       maximum number of items (server default 50, max 200)
      --state string    only revisions in this state (queued, building, ready, failed)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor revisions](#scantor-revisions)	 - Publish and inspect task revisions


## scantor revisions logs

Print the build log of a revision

### Synopsis

Print the build log of a revision: one entry per task-pipeline event (pack, static checks, image build, describe, type check, push), ending with the result. --follow keeps printing new entries until the build has finished. With -o json every entry is printed as one JSON object per line. A revision is addressed as &lt;task&gt;@&lt;number&gt;, &lt;task&gt;@latest (the newest ready revision), &lt;task&gt;@&lt;revisionId&gt; or &lt;task&gt; (= &lt;task&gt;@latest).

```
scantor revisions logs <task>[@<revision>] [flags]
```

### Examples

```
  scantor revisions logs echo@4
  scantor revisions logs echo@5 --follow
```

### Options

```
      --after-line int   start after this line number
      --follow           keep printing new entries until the build has finished
  -h, --help             help for logs
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor revisions](#scantor-revisions)	 - Publish and inspect task revisions


## scantor revisions publish

Publish the task's workspace as a new revision

### Synopsis

Snapshot the task's current workspace on the platform and build it into a new numbered revision. When a queued, building or ready revision with the same content exists, that revision is returned instead. With --wait the command waits for the build. A failed build exits with code 2 when the task content is invalid (pack, static, build, describe or check errors) and 3 when it failed for a platform reason (push, platform). To publish a local folder, use 'scantor push'. A task is addressed by its name or its id.

```
scantor revisions publish <task> [flags]
```

### Examples

```
  scantor revisions publish echo --message "add greeting option" --wait
```

### Options

```
  -h, --help               help for publish
  -m, --message string     revision message
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the revision is built (ready or failed)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor revisions](#scantor-revisions)	 - Publish and inspect task revisions


## scantor scans

Start, follow and control scans

```
scantor scans [flags]
```

### Options

```
  -h, --help   help for scans
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor scans cancel](#scantor-scans-cancel)	 - Cancel a scan
* [scantor scans conditions](#scantor-scans-conditions)	 - List why a scan is not progressing
* [scantor scans delete](#scantor-scans-delete)	 - Delete a finished scan with its results
* [scantor scans events](#scantor-scans-events)	 - List the timeline of a scan
* [scantor scans get](#scantor-scans-get)	 - Show a scan
* [scantor scans inflight](#scantor-scans-inflight)	 - List the analyses running right now
* [scantor scans list](#scantor-scans-list)	 - List scans
* [scantor scans pause](#scantor-scans-pause)	 - Pause a running scan
* [scantor scans restart](#scantor-scans-restart)	 - Start a new scan with the same revision, configs and settings
* [scantor scans resume](#scantor-scans-resume)	 - Resume a paused scan
* [scantor scans retry-failed](#scantor-scans-retry-failed)	 - Run the failed and lost analyses of a scan again
* [scantor scans scale](#scantor-scans-scale)	 - Change the workers or processes of a scan
* [scantor scans start](#scantor-scans-start)	 - Start a scan of a revision
* [scantor scans watch](#scantor-scans-watch)	 - Follow a scan's progress until it finishes
* [scantor scans worker](#scantor-scans-worker)	 - Inspect one worker of a scan
* [scantor scans workers](#scantor-scans-workers)	 - List the workers of a scan


## scantor scans cancel

Cancel a scan

### Synopsis

Cancel a creating, running or paused scan: its queue and workers are removed and analyses that have not finished become cancelled. Results already recorded are kept. This cannot be undone; restart the scan to run it again.

```
scantor scans cancel <scan> [flags]
```

### Options

```
  -h, --help   help for cancel
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans conditions

List why a scan is not progressing

### Synopsis

List the scan's conditions: typed status entries such as workersPending, crashLoop, imagePullFailed, brokerAlarm or breakerTripped that explain why it is not progressing.

```
scantor scans conditions <scan> [flags]
```

### Options

```
  -h, --help   help for conditions
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans delete

Delete a finished scan with its results

### Synopsis

Delete a completed, failed or cancelled scan: its analyses, files, exports and events are removed by a background job. With --wait the command waits for the job.

```
scantor scans delete <scan> [flags]
```

### Examples

```
  scantor scans delete 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --wait
```

### Options

```
  -h, --help               help for delete
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the deletion has finished
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans events

List the timeline of a scan

### Synopsis

List the events of a scan, newest first: state changes, worker placement, crashes, retries and more.

```
scantor scans events <scan> [flags]
```

### Examples

```
  scantor scans events 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --limit 20
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for events
      --limit int       maximum number of items (server default 50, max 200)
      --type string     only events of this type
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans get

Show a scan

### Synopsis

Show a scan: state, progress, analysis counts, scheduling, workers, settings and conditions. With --wait the command waits until the scan has settled (finished or paused).

Exit codes when waiting: 0 completed without failed or lost analyses, 1 completed with failed or lost analyses, failed, cancelled or paused by the circuit breaker, 2 invalid input, 3 platform error.

```
scantor scans get <scan> [flags]
```

### Examples

```
  scantor scans get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
  scantor scans get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --wait --timeout 2h -o json
```

### Options

```
  -h, --help               help for get
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the scan has settled (finished or paused)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans inflight

List the analyses running right now

### Synopsis

List the analyses the scan's workers are executing right now, as reported by their last state polls.

```
scantor scans inflight <scan> [flags]
```

### Options

```
  -h, --help   help for inflight
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans list

List scans

### Synopsis

List your scans, newest first. Deleted scans are omitted unless --state names deleting or deleted. Admins see every user's scans and may filter with --user.

```
scantor scans list [flags]
```

### Examples

```
  scantor scans list --state running,paused
  scantor scans list --task origins -o json
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for list
      --limit int       maximum number of items (server default 50, max 200)
      --state strings   only scans in these states (comma-separated: creating, running, paused, completed, failed, cancelled, deleting, deleted)
      --task string     only scans of this task (name or id)
      --user string     only scans of this user id (admins)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans pause

Pause a running scan

### Synopsis

Pause a running scan: its workers finish their current analyses within the drain grace and stop; queued analyses stay queued until the scan is resumed.

```
scantor scans pause <scan> [flags]
```

### Options

```
  -h, --help   help for pause
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans restart

Start a new scan with the same revision, configs and settings

### Synopsis

Start a new scan that clones a scan: same revision, same effective configs (including secrets) and settings, optionally with a new name and other workers or processes. The original scan is not changed. Template inputs such as "latest" lists are resolved again.

```
scantor scans restart <scan> [flags]
```

### Examples

```
  scantor scans restart 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --workers 8
```

### Options

```
  -h, --help            help for restart
      --name string     name of the new scan
      --processes int   connector processes per worker of the new scan
      --workers int     number of runner workers of the new scan
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans resume

Resume a paused scan

### Synopsis

Resume a paused scan (paused by you or by the circuit breaker): workers are placed again and an unfinished schedule continues from its checkpoint.

```
scantor scans resume <scan> [flags]
```

### Options

```
  -h, --help   help for resume
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans retry-failed

Run the failed and lost analyses of a scan again

### Synopsis

Run every failed or lost analysis that has a stored config again, in a new round. Cancelled analyses are never retried (restart the scan instead). Allowed once scheduling has finished; the scan returns to running. Follow it with 'scantor scans watch'.

```
scantor scans retry-failed <scan> [flags]
```

### Examples

```
  scantor scans retry-failed 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
```

### Options

```
  -h, --help   help for retry-failed
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans scale

Change the workers or processes of a scan

### Synopsis

Change the number of runner workers and/or connector processes per worker of a creating, running or paused scan. Changes apply live: workers are added or drained, processes are resized in place.

```
scantor scans scale <scan> [flags]
```

### Examples

```
  scantor scans scale 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --workers 8 --processes 4
```

### Options

```
  -h, --help            help for scale
      --processes int   connector processes per worker
      --workers int     number of runner workers
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans start

Start a scan of a revision

### Synopsis

Start a scan of a ready revision. A revision is addressed as &lt;task&gt;@&lt;number&gt;, &lt;task&gt;@latest (the newest ready revision), &lt;task&gt;@&lt;revisionId&gt; or &lt;task&gt; (= &lt;task&gt;@latest). A bare revision id works too.

The task and scan configs are JSON objects given inline, as @file or as - (stdin); they are validated against the revision's schemas and completed with their defaults. A list file for the list template is uploaded with 'scantor uploads create' and referenced by its id. Settings not given come from the task's manifest defaults; --settings takes a partial settings object (timeoutMs, maxAttempts, backoff, resources, maxAnalysesPerProcess, nodeSelector), and --workers and --processes override it.

Scans whose estimated size exceeds the instance's confirmation threshold need --confirm. With --wait the command waits until the scan has settled (finished or paused) and prints it.

Exit codes when waiting: 0 completed without failed or lost analyses, 1 completed with failed or lost analyses, failed, cancelled or paused by the circuit breaker, 2 invalid input, 3 platform error.

```
scantor scans start [revision] [flags]
```

### Examples

```
  scantor scans start echo@latest
  scantor scans start origins@3 --scan-config '{"list":"latest","limit":100000}' --workers 4 --confirm
  scantor scans start --revision power@2 --task-config @task-config.json --wait
```

### Options

```
      --confirm              confirm a scan above the instance's confirmation threshold
  -h, --help                 help for start
      --name string          scan name (≤ 100 characters)
      --processes int        connector processes per worker
      --revision string      revision to scan (alternative to the argument)
      --scan-config string   scan config: JSON object, @file or - (stdin)
      --settings string      partial scan settings: JSON object, @file or - (stdin)
      --task-config string   task config: JSON object, @file or - (stdin)
      --timeout duration     give up waiting after this duration (0 = no limit)
      --wait                 wait until the scan has settled (finished or paused)
      --workers int          number of runner workers
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans watch

Follow a scan's progress until it finishes

### Synopsis

Print a scan's progress until it is completed, failed or cancelled, or until the circuit breaker pauses it (a scan you paused is watched until it is resumed and finishes). Humans get one progress line, rewritten in place on a terminal; with -o json every change is printed as one Scan object per line (NDJSON). Interrupting the command does not affect the scan.

Exit codes when waiting: 0 completed without failed or lost analyses, 1 completed with failed or lost analyses, failed, cancelled or paused by the circuit breaker, 2 invalid input, 3 platform error.

```
scantor scans watch <scan> [flags]
```

### Examples

```
  scantor scans watch 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
  scantor scans watch 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f -o json | jq -c .progress
```

### Options

```
  -h, --help                help for watch
      --interval duration   time between updates (default 2s)
      --timeout duration    give up after this duration (0 = no limit)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor scans worker

Inspect one worker of a scan

```
scantor scans worker [flags]
```

### Options

```
  -h, --help   help for worker
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans
* [scantor scans worker logs](#scantor-scans-worker-logs)	 - Print the log tail of a worker


## scantor scans worker logs

Print the log tail of a worker

### Synopsis

Ask the worker's node for a fresh tail of the worker container's log and print it. The command waits up to --max-wait (at most 30s) for the node to answer; if it does not, the last tail collected earlier is printed with a warning. On a terminal, control characters in the log are shown escaped (\x1b); into a pipe or file the bytes are unchanged.

```
scantor scans worker logs <scan> <worker> [flags]
```

### Examples

```
  scantor scans worker logs 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f 9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d --tail-bytes 262144
```

### Options

```
  -h, --help                help for logs
      --max-wait duration   how long to wait for a fresh tail (≤ 30s) (default 30s)
      --tail-bytes int      bytes of log to fetch (server default 65536, max 262144)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans worker](#scantor-scans-worker)	 - Inspect one worker of a scan


## scantor scans workers

List the workers of a scan

### Synopsis

List the scheduler and runner workers of a scan with their node, state, processes and restarts.

```
scantor scans workers <scan> [flags]
```

### Examples

```
  scantor scans workers 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --state running,backoff
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for workers
      --limit int       maximum number of items (server default 50, max 200)
      --state strings   only workers in these states (comma-separated)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor scans](#scantor-scans)	 - Start, follow and control scans


## scantor tasks

Manage tasks and their workspace files

```
scantor tasks [flags]
```

### Options

```
  -h, --help   help for tasks
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor tasks create](#scantor-tasks-create)	 - Create a task from a scaffold
* [scantor tasks delete](#scantor-tasks-delete)	 - Delete a task with its revisions, images and test runs
* [scantor tasks files](#scantor-tasks-files)	 - Read and change the files of a task's workspace
* [scantor tasks get](#scantor-tasks-get)	 - Show a task
* [scantor tasks import-git](#scantor-tasks-import-git)	 - Import tasks from a git repository
* [scantor tasks list](#scantor-tasks-list)	 - List tasks
* [scantor tasks pull](#scantor-tasks-pull)	 - Fast-forward a git-imported task to its remote


## scantor tasks create

Create a task from a scaffold

### Synopsis

Create a task on the platform and scaffold its workspace for a language and a template ("custom" for a hand-written schedule). Edit it in the browser editor, with 'scantor tasks files' or locally (see 'scantor init' and 'scantor push').

```
scantor tasks create <name> [flags]
```

### Examples

```
  scantor tasks create echo --language python
  scantor tasks create origins --language typescript --template tranco --description "HTTP origins of the Tranco list"
```

### Options

```
      --description string   short description
  -h, --help                 help for create
      --language string      task language (python, typescript, javascript, go)
      --template string      schedule template, or "custom" (server default "single")
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor tasks delete

Delete a task with its revisions, images and test runs

### Synopsis

Delete a task: its workspace folder, revisions, snapshots, task images and test runs are removed by a background job. Fails while a scan of the task is not finished. A task is addressed by its name or its id.

```
scantor tasks delete <task> [flags]
```

### Examples

```
  scantor tasks delete echo --wait
```

### Options

```
  -h, --help               help for delete
      --timeout duration   give up waiting after this duration (0 = no limit)
      --wait               wait until the deletion has finished
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor tasks files

Read and change the files of a task's workspace

```
scantor tasks files [flags]
```

### Options

```
  -h, --help   help for files
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files
* [scantor tasks files cat](#scantor-tasks-files-cat)	 - Print a file of a task's workspace or of a revision
* [scantor tasks files ls](#scantor-tasks-files-ls)	 - List the files of a task's workspace or of a revision
* [scantor tasks files put](#scantor-tasks-files-put)	 - Write files into a task's workspace
* [scantor tasks files rm](#scantor-tasks-files-rm)	 - Delete a file or folder of a task's workspace


## scantor tasks files cat

Print a file of a task's workspace or of a revision

### Synopsis

Print one file of the task's workspace, or of a published revision with --revision. The content is written as raw bytes into a pipe or file; on a terminal, control characters are shown escaped (\x1b). The API returns at most 1 MiB of a file. With -o json the response object (with base64 content for binary files) is printed instead.

```
scantor tasks files cat <task> <path> [flags]
```

### Examples

```
  scantor tasks files cat echo main.py
  scantor tasks files cat echo scantor.yaml --revision latest
```

### Options

```
  -h, --help              help for cat
      --revision string   read from a revision's snapshot instead of the workspace
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks files](#scantor-tasks-files)	 - Read and change the files of a task's workspace


## scantor tasks files ls

List the files of a task's workspace or of a revision

### Synopsis

List the files below a folder of the task's workspace (default: the task root), or of a published revision with --revision (a number, "latest" or an id). At most 5000 entries are returned.

```
scantor tasks files ls <task> [path] [flags]
```

### Examples

```
  scantor tasks files ls echo
  scantor tasks files ls echo src --recursive=false
  scantor tasks files ls echo --revision 3
```

### Options

```
  -h, --help              help for ls
      --recursive         include subfolders (default true)
      --revision string   list a revision's snapshot instead of the workspace
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks files](#scantor-tasks-files)	 - Read and change the files of a task's workspace


## scantor tasks files put

Write files into a task's workspace

### Synopsis

Write one or more files into the task's workspace (at most 200 per call). Each argument is a task-relative path, optionally followed by =&lt;source&gt;: a local file, or - for stdin. Without a source, the local file with the same relative path is uploaded. Text files are sent as UTF-8, other files as base64. Writes never publish a revision.

```
scantor tasks files put <task> <path>[=<source>]... [flags]
```

### Examples

```
  scantor tasks files put echo main.py scantor.yaml
  scantor tasks files put echo main.py=./build/main.py
  cat main.py | scantor tasks files put echo main.py=-
```

### Options

```
  -h, --help   help for put
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks files](#scantor-tasks-files)	 - Read and change the files of a task's workspace


## scantor tasks files rm

Delete a file or folder of a task's workspace

### Synopsis

Delete one file of the task's workspace, or a folder with --recursive. Deletions never publish a revision.

```
scantor tasks files rm <task> <path> [flags]
```

### Examples

```
  scantor tasks files rm echo old.py
  scantor tasks files rm echo testdata --recursive
```

### Options

```
  -h, --help        help for rm
  -r, --recursive   delete a folder with its content
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks files](#scantor-tasks-files)	 - Read and change the files of a task's workspace


## scantor tasks get

Show a task

### Synopsis

Show a task with its source, cached workspace status and latest revisions. A task is addressed by its name or its id.

```
scantor tasks get <task> [flags]
```

### Examples

```
  scantor tasks get echo
```

### Options

```
  -h, --help   help for get
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor tasks import-git

Import tasks from a git repository

### Synopsis

Clone an https git repository on the platform and import the task folder below --path. When several task folders exist, the candidates are listed and nothing is imported until you choose them with --select. Private repositories need a git credential (created in the web UI), passed with --credential.

```
scantor tasks import-git <url> [flags]
```

### Examples

```
  scantor tasks import-git https://github.com/example/scans --path tasks/echo
  scantor tasks import-git https://github.com/example/scans --select tasks/echo --select tasks/power
```

### Options

```
      --credential string   id of a git credential for private repositories
  -h, --help                help for import-git
      --path string         folder inside the repository to search (server default ".")
      --ref string          branch, tag or commit (server default "HEAD")
      --select strings      import these candidate folders (repeatable)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor tasks list

List tasks

### Synopsis

List your tasks, newest first. Admins see every user's tasks and may filter with --user.

```
scantor tasks list [flags]
```

### Examples

```
  scantor tasks list
  scantor tasks list --language python -o json
```

### Options

```
      --cursor string     continue a previous listing (the cursor it printed)
  -h, --help              help for list
      --language string   only tasks of this language
      --limit int         maximum number of items (server default 50, max 200)
      --search string     only tasks whose name or description contains this text
      --user string       only tasks of this user id (admins)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor tasks pull

Fast-forward a git-imported task to its remote

### Synopsis

Fetch the git source of an imported task and replace its workspace folder when the remote is a fast-forward. Fails with gitDiverged when the workspace has local changes since the last import or pull, or when the remote history diverged; --force replaces the folder anyway. Pull never publishes a revision. A task is addressed by its name or its id.

```
scantor tasks pull <task> [flags]
```

### Examples

```
  scantor tasks pull echo
```

### Options

```
      --force   replace the workspace folder even with local changes or a diverged remote
  -h, --help    help for pull
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor tasks](#scantor-tasks)	 - Manage tasks and their workspace files


## scantor templates

List the templates and estimate scan sizes

```
scantor templates [flags]
```

### Options

```
  -h, --help   help for templates
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor templates estimate](#scantor-templates-estimate)	 - Validate a scan config and estimate the number of analyses
* [scantor templates list](#scantor-templates-list)	 - List the templates


## scantor templates estimate

Validate a scan config and estimate the number of analyses

### Synopsis

Apply the template's defaults to a scan config, validate it (JSON Schema and the template's semantic rules) and estimate the number of analyses without network access.

The scan config is given with --config (alias --scan-config) as inline JSON, @file or - for stdin; without it the defaults apply. Referenced uploads need --upload &lt;id&gt;=&lt;lines&gt;.

The output is always JSON on stdout, because the orchestrator runs this command at scan start:
  exit 0: {"expectedTotal": n | null, "exact": bool}
  exit 2: {"issues": [{"path": &lt;JSON pointer&gt;, "message": ...}]}
  exit 3: internal failure

```
scantor templates estimate <template> [flags]
```

### Examples

```
  scantor templates estimate cidr --config '{"cidrs": ["10.0.0.0/16"]}'
  echo '{"upload": "7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c"}' | scantor templates estimate list --config - --upload 7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c=10000
```

### Options

```
      --config string        scan config: inline JSON, @file or - (stdin)
  -h, --help                 help for estimate
      --scan-config string   alias of --config
      --upload stringArray   line count of a referenced upload, as <id>=<lines> (repeatable)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor templates](#scantor-templates)	 - List the templates and estimate scan sizes


## scantor templates list

List the templates

### Synopsis

List the built-in templates with their scan and analysis config schemas.

With -o json the output is {"items": [...]} with the fields of GET /api/templates (name, title, description, scanConfigSchema, analysisConfigSchema, example, resolves) plus version, estimate, dataSources and uploads.

```
scantor templates list [flags]
```

### Options

```
  -h, --help   help for list
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor templates](#scantor-templates)	 - List the templates and estimate scan sizes


## scantor uploads

Upload list files for scans of the list template

```
scantor uploads [flags]
```

### Options

```
  -h, --help   help for uploads
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
* [scantor uploads create](#scantor-uploads-create)	 - Upload a newline-separated list file
* [scantor uploads delete](#scantor-uploads-delete)	 - Delete an uploaded file
* [scantor uploads get](#scantor-uploads-get)	 - Show an uploaded file
* [scantor uploads list](#scantor-uploads-list)	 - List uploaded files


## scantor uploads create

Upload a newline-separated list file

### Synopsis

Upload a newline-separated list file (- reads stdin). Every non-empty line, trimmed, becomes one analysis of a list-template scan that references the upload by id in its scan config. Uploads are content-addressed: uploading the same content again returns the existing upload.

```
scantor uploads create <file> [flags]
```

### Examples

```
  scantor uploads create domains.txt
  scantor scans start origins@latest --scan-config '{"upload": "<upload id>"}'
```

### Options

```
  -h, --help          help for create
      --name string   display name (default: the file name)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor uploads](#scantor-uploads)	 - Upload list files for scans of the list template


## scantor uploads delete

Delete an uploaded file

### Synopsis

Delete an uploaded list file. Fails while a scan references it.

```
scantor uploads delete <upload> [flags]
```

### Options

```
  -h, --help   help for delete
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor uploads](#scantor-uploads)	 - Upload list files for scans of the list template


## scantor uploads get

Show an uploaded file

### Synopsis

Show an uploaded list file: name, size, line count, SHA-256 and when a scan last used it.

```
scantor uploads get <upload> [flags]
```

### Options

```
  -h, --help   help for get
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor uploads](#scantor-uploads)	 - Upload list files for scans of the list template


## scantor uploads list

List uploaded files

### Synopsis

List your uploaded list files, newest first.

```
scantor uploads list [flags]
```

### Options

```
      --cursor string   continue a previous listing (the cursor it printed)
  -h, --help            help for list
      --limit int       maximum number of items (server default 50, max 200)
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor uploads](#scantor-uploads)	 - Upload list files for scans of the list template


## scantor validate

Run every publish check on a task folder with local Docker

### Synopsis

Run the checks a publish runs, on the local Docker daemon: pack, static checks (manifest, required files, Dockerfile policy), image build, describe and type check. The image is tagged scantor-dev/&lt;name&gt;:&lt;hash&gt; and never pushed. Privileged tasks are accepted locally; publishing checks the permission on the server.

The pipeline events are printed as they happen; with -o json one JSON object per line. Exit codes: 0 valid, 2 invalid task content, 3 platform failure (for example Docker unreachable).

Validating needs local Docker, so it is not available with SCANTOR_DEV_MODE=remote (the editor, exit 3): there 'scantor dev run' builds and tests the task on the platform, and 'scantor push' publishes it with every check.

```
scantor validate [dir] [flags]
```

### Examples

```
  scantor validate
  scantor validate ./echo -o json
```

### Options

```
  -h, --help   help for validate
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor version

Print the scantor version

### Synopsis

Print the version, commit and image prefix this binary was built with.

```
scantor version [flags]
```

### Options

```
  -h, --help   help for version
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale


## scantor whoami

Show the account of SCANTOR_TOKEN

### Synopsis

Show which orchestrator the CLI talks to (SCANTOR_URL) and the account the API key in SCANTOR_TOKEN belongs to. Useful to check the CLI configuration.

```
scantor whoami [flags]
```

### Options

```
  -h, --help   help for whoami
```

### Options inherited from parent commands

```
  -o, --output format   output format: human or json (default human)
```

### SEE ALSO

* [scantor](#scantor)	 - Run scanning tasks at scale
