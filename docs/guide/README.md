# scantor user guides

| Guide | Read it to |
|---|---|
| [Authoring in Python](authoring-python.md), [TypeScript](authoring-typescript.md), [JavaScript](authoring-javascript.md), [Go](authoring-go.md) | write a task: config and result types, `schedule` and `run`, the context, files, errors, type checking, local runs and debugging |
| [Templates](templates.md) | use the built-in schedules (`single`, `list`, `range`, `repeat`, `tranco`, `crux`, `cidr`): their scan and analysis configs, and how to use, wrap, filter and extend them |
| [Manifest](manifest.md) | write `scantor.yaml`: fields, scan defaults, sizing workers and the checks run on publish |
| [Scripts](scripts.md) | evaluate the results and files of your scans with a Python script that runs on the master: the script folder and manifest, `scantor.script` (typed analysis streams, files, parallelism, outputs, checkpoints and resume, secrets), sample runs, limits, and running scripts from the web UI, the CLI and MCP |
| [Errors and retries](errors-and-retries.md) | understand error types, attempts and backoff, timeouts, crashes, name resolution in workers, scan safeguards, retrying failed analyses, where errors show up and push notifications |
| [CLI reference](cli.md) | look up every `scantor` command and flag (generated from the CLI) |
| [MCP](mcp.md) | connect Claude Code or another MCP client, and let an agent author, run and analyse scans and write and run scripts |
| [Remote nodes](remote-nodes.md) | add Docker hosts as nodes, also behind firewalls: tokens, TLS, private networks, egress rules, Docker-in-Docker, the node's DNS resolver, daemon overrides and troubleshooting |
| [Bundles](bundles.md) | share a revision as one file that runs with only Docker: create and download a bundle, then load and run it anywhere, with configs, local files, settings, the results directory, exit codes and a hardened command |

These guides are embedded into the `scantor` binary and the orchestrator image. The MCP server serves
them as resources (`scantor://guide/…`) and through `get_authoring_guide`.
