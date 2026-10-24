# Security model

This document is scantor's threat model and mitigations catalogue. It states what scantor protects and what it
does not, who the attackers are and what they control, and where the trust boundaries lie. For every
mitigation it gives a stable id, the rule, the place where it is implemented and the test that keeps it true.
It also specifies the generated authorization-matrix test, lists the security fixture corpora, and covers
residual risks, operator guidance and credential rotation. Identity and credential formats are defined in
[auth](auth.md), agent-specific controls in [mcp](mcp.md), the components and trust zones in
[architecture](architecture.md) §6, and limits in [data model](data-model.md) §8. A mitigation changes only
together with its test.

## 1. Goals and non-goals

| # | Goal |
|---|---|
| G1 | **Tenant isolation.** A user can neither read nor change another user's tasks, workspace, revisions, images, test runs, scans, analyses, files, exports, uploads, credentials, API keys or editor. Only admins see everything. |
| G2 | **Platform integrity.** User code (task code, Dockerfiles, workspace content, editor extensions, git repositories) cannot reach infrastructure root credentials, the Docker socket, admin power, the dashboard origin or other tenants. |
| G3 | **Credential containment.** Every machine credential is least-privilege, bound to one identity, revocable, and derived or hashed rather than stored. `writeOnly` config values are never shown back. |
| G4 | **Secure by default.** A fresh install exposes nothing beyond loopback and refuses to start publicly with development secrets. |
| G5 | **Bounded resource use.** No single request, user, scan or task can exhaust shared master resources: broker, database, disk, CPU or the ingestor. |
| G6 | **Agent safety.** LLM agents get least privilege by default and are told which content is untrusted. |

| Non-goal | Consequence |
|---|---|
| Protecting scan targets from scantor's users | scantor is a scanning platform. Users choose targets, and operators are responsible for acceptable use. Events record who started which scan. |
| Isolating scans from the operator of the node they run on | A node sees everything about the scans placed on it ([architecture](architecture.md) §6.2, Z3). Only add nodes you trust like the master. |
| Defending against malicious admins or a compromised master host | Admins hold all power by design. The master host holds all secrets. |
| Kernel-level container escapes | Docker isolation (namespaces, seccomp, capabilities) is the boundary. Privileged/DinD tasks explicitly weaken it (§6.9). |
| A guaranteed nonce-based script CSP for the SPA in v1 | `script-src` uses a per-request nonce only where that works reliably in Nuxt 4 SPA mode; otherwise the SPA relies on Vue's escaping and the no-`v-html` rule (HDR-1, HDR-5). |

## 2. Assets

| Asset | Location | Impact if lost |
|---|---|---|
| `SCANTOR_SECRET` and every HKDF-derived key | orchestrator and built-in node env | forge worker tokens, AMQP passwords, cookies, registry tokens; decrypt credentials |
| Infrastructure root credentials (MongoDB app/root, RabbitMQ admin, RustFS root keys) | orchestrator env, infra containers | read and write all tenant data |
| Docker sockets | orchestrator and built-in node on the master; node daemons on nodes | root on that host |
| Sessions, API keys, OAuth tokens | browsers, CLI env, MCP clients; hashed in better-auth collections | act as the user |
| Task source and images | workspaces volume, `snapshots/` in S3, registry | intellectual property and baked-in secrets |
| `writeOnly` config values, git tokens | encrypted in `scans.secrets`, `testRuns.secrets`, `credentials` | third-party credentials of users |
| Results, files, logs, exports | MongoDB `analyses`, S3 | potentially sensitive data collected from targets |
| Node tokens, worker tokens, per-scan AMQP credentials | nodes, worker env, bootstrap responses | impersonate nodes or workers; inject results |
| Availability | master disk, RabbitMQ, MongoDB, ingestor | every tenant stalls |

## 3. Actors

| Actor | Capabilities assumed |
|---|---|
| **A1 anonymous internet attacker** | reaches every public endpoint: dashboard, editor origin, `/mcp`, registry host, S3 host, AMQPS (with Traefik). Can send arbitrary headers, including `X-Forwarded-For`. Learns hostnames from DNS and CT logs. |
| **A2 malicious user** | has an account. Fully controls task code, Dockerfiles, manifests, workspace files (symlinks, FIFOs, huge files), configs, uploaded archives, git repositories they import, file names and result content. Uses the UI, API, CLI, MCP and the editor terminal. Knows other users' ids (ids are not secrets). |
| **A3 malicious content** | scanned web content, imported third-party repositories, package registries. Controls results, logs, file contents and build output, and therefore attempts prompt injection, XSS and CSV injection. |
| **A4 compromised worker** | A2's code running in a worker, or A3 exploiting a task. Has the worker token, the per-scan AMQP credentials, presigned URLs and the worker's network position. |
| **A5 malicious or compromised remote node** | runs the node daemon with a valid node token and controls the node's Docker host. |
| **A6 hijacked agent** | an LLM agent acting under a user's MCP grant whose behaviour is steered by A3 content. |
| **A7 network attacker** | sits between remote nodes and the master. |
| Trusted | admins, the master host operator, the GitHub Actions supply chain of scantor's own images (pinned versions and digests). |

## 4. Trust boundaries

```
           A1/A2 browsers, CLI, MCP clients                    A5 remote nodes  ◄── A7 ──►
                │ B1 cookies/CSRF  B2 API keys/OAuth/MCP                │ B6 node token, registry, AMQP, S3
                ▼                                                       ▼
 ┌───────── Z0 platform core ───────────────────────────────────────────────────────────────────┐
 │ orchestrator ── B7 query engine ── MongoDB      RabbitMQ      RustFS      registry            │
 │      │  B3 task pipeline (Dockerfile, build, describe/check)                                  │
 │      │  B4 workspace helpers / editor proxy                                                   │
 │      │  B9 data → agents (MCP)                                                                │
 └──────┼──────────────────────────────────────────────▲────────────▲──────────▲────────────────┘
        ▼                                              │ B5 worker token, scan AMQP user, presigned
 ┌──── Z2 user code (master) ─────────────────────┐    │
 │ builds (RUN), describe/check, helpers, editors, │────┘
 │ test runs, master workers                       │        Z1 admin tools ── B8 forwardAuth / admin bind
 └─────────────────────────────────────────────────┘
```

| Boundary | Crossing | Main controls |
|---|---|---|
| B1 | browser ↔ dashboard | host-only session cookie, CSRF origin check, security headers, no credentialed CORS (§6.12, §6.18) |
| B2 | API/MCP clients ↔ API | typed principals, operation registry, ownership 404s, scopes (§6.12, §6.13) |
| B3 | user files → builds | Dockerfile policy, build isolation and limits, label rules (§6.1, §6.2) |
| B4 | user files → orchestrator | workspace helpers, path rules, separate editor origin (§6.3, §6.4) |
| B5 | worker → platform | worker token, per-scan AMQP user, ingestor rules, presign rules (§6.6, §6.7) |
| B6 | node → master | node token, registry grants, transport security (§6.7, §6.14) |
| B7 | user → MongoDB | recursive query allowlist, read-only query user, `--noscripting` (§6.5) |
| B8 | admin → infra GUIs | forwardAuth tools cookie, admin bind address (§6.10) |
| B9 | data → agents | `untrusted_data`, scopes, size caps (§6.13) |

## 5. Threat summary

| # | Threat | Actor | Mitigations |
|---|---|---|---|
| T01 | Image labels make Traefik route the dashboard host to a user container (credential and OAuth-code phishing) | A2 | LBL-1…5 |
| T02 | Dockerfile reads other tenants' images, host-loopback services or cloud metadata, poisons shared caches, or runs a custom frontend | A2 | BLD-1…11 |
| T03 | Archive or workspace symlinks, `..` paths or git CVEs read or write outside the user's folder in the orchestrator | A2, A3 | WS-1…9 |
| T04 | Workspace JavaScript or an extension in the editor rides the dashboard session; another user reaches a victim's editor | A2, A3 | ED-1…10 |
| T05 | Query or aggregation escapes the scan scope (`$lookup`, `$unionWith`, `$facet`), runs server-side JS, or injects operators | A2 | Q-1…8 |
| T06 | A worker writes analyses or files of another scan, or stalls the shared ingestor with poison | A4 | ING-1…7 |
| T07 | A stolen or misused machine credential reaches user routes, other scans or other nodes' work | A4, A5 | MC-1…10 |
| T08 | Worker reaches platform services, other tenants, cloud metadata or the node LAN; fork bombs | A4 | SB-1…7 |
| T09 | Privileged/DinD task gets root on the master or a shared node | A2 | PRIV-1…5 |
| T10 | Admin GUIs or data stores exposed to the internet behind weak credentials | A1 | GUI-1…8 |
| T11 | Default secrets in production; first-admin setup takeover | A1 | CFG-1…8 |
| T12 | Session theft, CSRF, sign-up abuse, brute force, banned users keeping access, IP spoofing against rate limits | A1, A2 | AUTH-1…10 |
| T13 | Prompt injection steers an agent; consent phishing through malicious redirect URIs; SSRF through client metadata | A3, A6, A1 | MCP-1…9 |
| T14 | Plaintext or unverified transport leaks node tokens, registry and AMQP credentials | A7 | TLS-1…6 |
| T15 | Downloaded files render as HTML on a scantor origin; header injection; CSV formula injection | A3 | DL-1…5 |
| T16 | Secrets in configs leak through APIs, exports, MCP or logs | A2, A6 | SEC-1…7 |
| T17 | Noisy neighbour exhausts broker, database, disk, CPU or the API | A2, A4 | RES-1…12 |
| T18 | Clickjacking of consent and setup pages; MIME sniffing; XSS through rendered results | A1, A3 | HDR-1…6 |

## 6. Mitigations catalogue

Columns: **Implementation** = where the rule lives; **Test** = what keeps it true. Paths under `tests/` follow
the layout of [testing](testing.md) §2: Playwright specs in `tests/<project>/` (`api`, `ui`, `e2e`, `mcp`,
`authz`, `security`), run by `just test`, and shared data tables in `tests/corpora/`, which the Go and vitest
unit tests read too. `*_test.go` files sit next to the Go code; vitest files live under `orchestrator/test/`.
All unit tests run in containers.

### 6.1 Container labels and Traefik route hijack (T01)

Docker copies an image's `LABEL`s into its containers. A container labelled
`com.docker.compose.project=scantor` and `traefik.http.routers.x.rule=Host(...)` would pass Traefik's provider
constraint and could take over the dashboard host. This was verified on traefik v3.7 and Docker 29.9.

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| LBL-1 | Every container scantor creates (kinds `worker`, `helper`, `build`, `testRun`, `editor`, `egressHelper`) and every network it creates (kind `network`: `scantor-egress`, `scantor-workers`) gets run-time labels from one function, which override image labels with the same key: `traefik.enable=false`, `com.docker.compose.project=scantor-managed`, `com.docker.compose.service=`, `scantor.managed=true`, `scantor.kind=<kind>`, and identity labels (`scantor.worker`, `scantor.scan`, `scantor.user`, `scantor.node`, `scantor.spec-hash`, and `scantor.op` on helpers) ([architecture](architecture.md) §7). | Go `internal/container` (`ManagedLabels()`), TS `orchestrator/server/utils/labels.ts` (`managedLabels()`); both read the fixed key set and kinds from `schemas/managed-labels.json` | `internal/container` unit tests and `orchestrator/test/utils/labels.test.ts` against the shared file; Go integration test `internal/container` `TestInjectionHardeningAndLabelOverride` (an image with hostile labels built by the test, [testing](testing.md) §4.1); `tests/security/hostile-labels.spec.ts` |
| LBL-2 | Static validation rejects `LABEL` keys matching `^(traefik\.\|com\.docker\.compose\.\|scantor\.)` (case-insensitive; rule D9 of [tasks](tasks.md) §8.2) and any `LABEL` key containing `$`, because ARG expansion would bypass the pattern. | `internal/taskpipe/dockerfile` | `internal/taskpipe` unit tests over `tests/corpora/dockerfile-policy/`; `tests/security/hostile-labels.spec.ts` |
| LBL-3 | After the build, the image's effective labels (`ImageInspect` → `Config.Labels`, including inherited ones) are checked against the same pattern; a hit fails the revision (`phase: "build"`). This catches keys produced by expansion and anything the static parser misses. | `internal/taskpipe` (build phase) | `internal/taskpipe` integration test (`//go:build integration`) `TestIntegrationInheritedLabels`: forbidden labels inherited from the base image pass the static check, fail in phase `build`, and the image is removed |
| LBL-4 | Traefik's Docker provider uses `exposedByDefault=false` and a constraint on the compose project label of the scantor stack. Managed containers carry `scantor-managed`, so they never match even with a forged `traefik.enable=true`. | Traefik CLI flags in the compose files ([deployment](deployment.md) §7.1) | `tests/security/compose-lint.spec.ts` (parses the compose files); `tests/security/hostile-labels.spec.ts` (the test stack runs Traefik): requests to the dashboard host still reach the orchestrator |
| LBL-5 | The node daemon and the orchestrator recognise their containers only by labels they set (`scantor.managed=true` plus `scantor.node`/`scantor.kind`) **and** the name prefix (`scantor-w-`, `scantor-h-`, `scantor-b-`, `scantor-t-`, `scantor-editor-`, `scantor-netpol-`). Image labels are never trusted for identity, and `docker compose down` of the stack never touches them (project differs). | `internal/node/reconcile.go`, `orchestrator/server/services/reconciler/containers.ts` | `internal/node/reconcile_test.go` (a container with copied labels but a foreign name is ignored) |

### 6.2 Untrusted Dockerfile builds (T02)

All task images are built by BuildKit on the master's Docker daemon, which holds every task image and fetches
`ADD` URLs from the host network namespace. The policy is implemented once in Go with BuildKit's own parser
(`github.com/moby/buildkit/frontend/dockerfile/parser` plus `instructions.Parse`). It runs in
`scantor task check-static`, so `scantor validate` locally and publishing on the server give identical
verdicts. The rules themselves are D1–D11 of [tasks](tasks.md) §8.2; the rows below map them to this
threat and add the checks that run outside the static parser.

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| BLD-1 | `ARG SCANTOR_BASE` is declared before the first `FROM` without a default, and the final stage is `FROM ${SCANTOR_BASE}` (or `$SCANTOR_BASE`), directly or through earlier stage names; no `--platform` (D3, D4, D6). | `internal/taskpipe/dockerfile` | `internal/taskpipe` unit tests over `tests/corpora/dockerfile-policy/` |
| BLD-2 | Every image reference in `FROM`, `COPY --from` and `RUN --mount=…,from=` is an earlier stage name or index, `${SCANTOR_BASE}`, or a literal reference without `$` that is not a bare image id. Its registry host is not `localhost`, `*.localhost`, `host.docker.internal`, an IP literal in a loopback, private, link-local, unique-local or unspecified (`0.0.0.0`, `::`) range, the registry service name `registry` (any port), the host of `SCANTOR_REGISTRY_PUBLIC_HOST` or the host of `SCANTOR_PUBLIC_URL`. Its repository path does not start with `tasks/` on any host (D5). | same | corpus; `tests/security/dockerfile-policy.spec.ts` (`COPY --from=localhost:<port>/tasks/<other task>` is rejected with `file`/`line` and never yields the victim's files) |
| BLD-3 | Parser directives `# syntax=` and `# check=` are rejected, because custom frontends get full LLB access (D2). So are `BUILDKIT_*` build arguments (D10). | same | corpus |
| BLD-4 | `ADD` sources are local paths only: no `http(s)://`, `git@`, `git://` or `*.git` sources, no `--checksum`, no `--keep-git-dir` (D7). Users fetch with `RUN curl`, which runs in the build container's network namespace. | same | corpus; `tests/security/dockerfile-policy.spec.ts` |
| BLD-5 | `RUN --mount` types `cache`, `secret` and `ssh` are rejected in v1, so tenants share no caches. `type=bind` and `type=tmpfs` are allowed; `from=` is checked by BLD-2 (D8). | same | corpus |
| BLD-6 | `RUN --network=` other than `default` and any `RUN --security=` are rejected (D8). The daemon does not grant these entitlements anyway; the policy makes the failure explicit and early. | same | corpus |
| BLD-7 | The Dockerfile itself may not use `ONBUILD` or `VOLUME` (D11). In addition, external images used by earlier stages must carry no `ONBUILD` triggers: `scantor task build` pulls each literal reference before building and inspects `Config.OnBuild`, and a non-empty value fails the revision (`phase: "build"`). Inherited triggers are invisible to the static parser and could contain `ADD <url>`. | `internal/taskpipe` (build phase) | `tests/security/dockerfile-policy.spec.ts` with a locally built `ONBUILD` fixture image |
| BLD-8 | No registry credentials are passed to builds. `SCANTOR_BASE` is pre-pulled and pinned by digest, and the orchestrator's push credential is used only for the final push. A build therefore cannot pull from the platform registry. | `internal/taskpipe` (build phase, [tasks](tasks.md) §9.4) | `tests/security/dockerfile-policy.spec.ts` (`FROM <public registry host>/tasks/x` fails the policy; with the policy bypassed in a unit test, the build has no credentials) |
| BLD-9 | Build limits: `SCANTOR_BUILD_TIMEOUT` (build cancelled), `SCANTOR_BUILD_CONCURRENCY` (FIFO, shared with test-run builds), `SCANTOR_MAX_IMAGE_BYTES` (image inspect before push), `SCANTOR_TASK_MAX_PACK_BYTES` (context), and cache pruning to `SCANTOR_BUILD_CACHE_MAX_BYTES` after builds ([tasks](tasks.md) §9.10). | `internal/taskpipe`, jobs runner | vitest pipeline-driver tests with a fake `scantor task build` (build timeout, image-size cap) and `internal/taskpipe` integration tests ([testing](testing.md) §4.2, §8.3) |
| BLD-10 | Describe and check containers (`scantor-b-*`) run with the worker hardening profile (SB-1) without added capabilities, `--network none`, the timeout `SCANTOR_DESCRIBE_TIMEOUT`, managed labels and the injected runtime, and never privileged ([tasks](tasks.md) §9.5). | `internal/taskpipe` using `internal/container` | `internal/taskpipe` unit test (asserts the HostConfig); `tests/e2e/privileged.spec.ts` |
| BLD-11 | `RUN` steps on the master use the daemon's build network. The egress deny list (SB-4) applies to it. Host-published ports are bound to `SCANTOR_BIND_ADDRESS`/`SCANTOR_ADMIN_BIND_ADDRESS`, whose shipped values are loopback addresses (CFG-3), so they are unreachable from bridge networks. Draft images for test runs go through the same pipeline and are never pushed. | compose bind addresses ([deployment](deployment.md)); node egress helper ([nodes](nodes.md) §9) | `tests/security/sandbox.spec.ts` (a `RUN` that connects to `169.254.169.254` fails when `egressDenyApplied` is true) |

### 6.3 Workspace helpers, archives and git (T03)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| WS-1 | The orchestrator process never reads or writes workspace content. The `scantor-workspaces` volume is not mounted into the orchestrator. Every operation (`init`, `purge`, `list`, `read`, `write-files`, `delete-files`, `scaffold`, `extract`, `git-clone`, `git-pull`, `commit`, `discard`, `snapshot`) runs as `scantor workspace <op>` in a throwaway helper container ([editor](editor.md) §9). | `orchestrator/server/services/helpers/`, `internal/workspace/` | `tests/security/compose-lint.spec.ts` (no workspace volume on the orchestrator) |
| WS-2 | Helper profile ([editor](editor.md) §9.2): scantor image; `--user 1000:1000`; only the volume subpath `<userId>` of `scantor-workspaces` mounted (`list`/`read --archive`: no volume); `--network none` (git operations: `scantor-egress`); `--read-only` with a small `noexec` tmpfs `/tmp`; `--cap-drop ALL`; `no-new-privileges`; `SCANTOR_HELPER_PIDS_LIMIT`, `SCANTOR_HELPER_MEMORY_LIMIT`, 1 CPU; killed and removed after `SCANTOR_HELPER_TIMEOUT`; managed labels (`kind=helper`, `scantor.op`). Data moves only over stdin/stdout. Only `init` and `purge` run as root (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`) with the whole `scantor-workspaces` and `scantor-editor-home` volumes; they create or remove one validated `<userId>` directory and never read content. | `orchestrator/server/services/helpers/runner.ts` | `orchestrator/test/services/helpers/runner.test.ts` (container spec snapshot per operation) |
| WS-3 | Path rules for requests, archives and file maps ([editor](editor.md) §9.5): relative, `/`-separated, valid UTF-8; no NUL, backslash or leading `/`; no empty, `.` or `..` segments; segments ≤ 255 bytes, path ≤ 1024 bytes, depth ≤ 32; nothing inside `.scantor-staging` (422 `invalidPath` with `details.path`). Archives contain only regular files and directories (no symlinks, hardlinks, devices or FIFOs; duplicates rejected). Modes are normalised to 0644/0755. `SCANTOR_TASK_MAX_FILES`, `SCANTOR_TASK_MAX_BYTES` (uncompressed, counted while streaming, which stops gzip bombs) and `SCANTOR_WORKSPACE_MAX_BYTES` apply. Writes never pass through a symlink: every existing component is checked with `lstat`, and files are opened through Go's `os.Root` at the task folder, so nothing outside it is reachable. | `internal/workspace/` | `internal/workspace` unit tests over `tests/corpora/tar-slip/` and `tests/corpora/paths/`; `tests/security/tar-slip.spec.ts` |
| WS-4 | Snapshot/pack stores symlinks as symlinks and never dereferences them (BuildKit resolves them inside the context root). Entries are deterministic. `.git/` and `.scantor/` are excluded. `SCANTOR_TASK_MAX_PACK_BYTES` applies. | `internal/taskpipe/pack.go` | `internal/taskpipe/pack_test.go` (a `ln -s /proc/self/environ x` workspace is rejected, because absolute symlinks are pack errors ([tasks](tasks.md) §9.2), and the target is never read; in-tree relative symlinks are packed as symlinks) |
| WS-5 | Browsing (`listTaskFiles`, `readTaskFile`) reads through the helper (`lstat` only: symlinks are listed as `type: "symlink"` and never followed; reading one is `invalidPath`) or, with `revision`, from the immutable snapshot through `list --archive`/`read --archive`. Content is capped at 1 MiB. | `internal/workspace/` | `tests/security/tar-slip.spec.ts` (path cases of `tests/corpora/paths/` through `readTaskFile`: a symlink to `/etc/passwd` is listed, not read) |
| WS-6 | Git ([editor](editor.md) §9.7): `https://` only; no userinfo and no leading `-`; the host must resolve only to public addresses (not loopback, private, link-local, CGNAT or ULA) unless `SCANTOR_GIT_ALLOW_PRIVATE=true`, and the validated address is pinned with `http.curloptResolve`, so DNS rebinding cannot switch hosts. git runs with `protocol.file.allow=never`, `http.followRedirects=false`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, no submodules, `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0` and no system or global config, as a shallow fetch of one ref inside the helper on `scantor-egress` (no platform services, inter-container traffic disabled, egress deny list applies). | `internal/workspace/` (git), `orchestrator/server/api/tasks/import-git.post.ts` (URL pre-check) | vitest unit test of the git URL pre-check (private host; the test stack sets `SCANTOR_GIT_ALLOW_PRIVATE=true`, [testing](testing.md) §4.2, §8.1); `tests/api/git.spec.ts` (userinfo, `ext::`, `file://`, leading `-`, redirect not followed) |
| WS-7 | Git tokens are stored only in `credentials.secretEnc` (AES-256-GCM, HKDF label `credentials`, AAD `credentials:<_id>:secretEnc`). The API is write-only (`last4` shown). Tokens reach git only through `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://<host>/.extraheader` and `GIT_CONFIG_VALUE_0=Authorization: Basic <b64>` for the exact host, and are redacted in errors (`gitFailed`) and logs. | `orchestrator/server/utils/crypto.ts`, `internal/workspace/` (git) | `tests/api/git.spec.ts` (the imported task folder contains no `.git` and no token; error messages redacted) |
| WS-8 | Template data sources (Tranco, CrUX, uploaded lists) are fetched only inside scheduler workers, never by the orchestrator. Uploaded lists are served to the scheduler by presigned GET. | `internal/templates/`, bootstrap ([api](api.md) §8.1) | `internal/templates/*_test.go` (fixture servers) |
| WS-9 | Uploads (`uploadTask`, `createUpload`) stream under their own caps (`SCANTOR_TASK_MAX_PACK_BYTES`, `SCANTOR_MAX_UPLOAD_BYTES`) and are never buffered whole in memory; a streamed body is not read past its cap (`ByteCap`) and gets 413 with `Connection: close`, so the connection holding its unread rest carries no further request. | `orchestrator/server/api/tasks/upload.post.ts`, `uploads/index.post.ts`, `orchestrator/server/utils/byte-cap.ts` | `tests/e2e/limits.spec.ts` |

### 6.4 Editor isolation (T04)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| ED-1 | The editor is served on its own origin, `SCANTOR_EDITOR_URL` (`editor.<domain>` with Traefik, `SCANTOR_EDITOR_PORT` without), by a dedicated HTTP listener on orchestrator container port 3001 that runs outside Nitro ([editor](editor.md) §8.1). It accepts only the editor host (421 otherwise) and serves only `/_auth` and the proxy. The dashboard listener (3000) answers 421 for the editor host and has no editor routes. The orchestrator refuses to start when both URLs have the same origin (CFG-2). | editor listener plugin (`orchestrator/server/plugins/`), `orchestrator/server/services/editor/`; `00.request.ts` (421 on the dashboard listener) | `tests/security/editor-isolation.spec.ts` (`/api/*` on the editor origin never reaches the API; the editor host on the dashboard listener and a foreign host on the editor listener → 421) |
| ED-2 | Login handoff by a 60 s single-use `sec_` code and a host-only signed `scantor_editor` cookie bound to `editors.startedAt` ([auth](auth.md) §12, [editor](editor.md) §8.3–8.4). The proxy strips `cookie`, `authorization`, `proxy-authorization`, `x-api-key`, every `x-scantor-*` and the forwarding headers, and removes `Set-Cookie` from responses. WebSocket upgrades require `Origin` = editor origin. | `orchestrator/server/services/editor/` (proxy and WebSocket relay) | `orchestrator/test/services/editor/proxy.test.ts` (a fake upstream on a unix socket receives none of the stripped headers; `Set-Cookie` removed); `editor-isolation.spec.ts` (foreign-Origin upgrade → 403; codes are single use; cookies stop working after the editor stops) |
| ED-3 | code-server listens only on a unix socket (`--socket /run/scantor-editor/code.sock --socket-mode 600`) in volume `scantor-editor-sockets` (subpath `<userId>` in the editor, whole at `/run/scantor/editor-sockets` in the orchestrator). No editor process listens on any network. Editors join `scantor-sandbox`, which has no mongo, mongo-express, registry or Traefik. | editor manager ([editor](editor.md) §4) | `editor-isolation.spec.ts` (from a master worker, connecting to the editor container's IP on 8080 fails) |
| ED-4 | Only the owner can open an editor. Editor routes always act on the caller's own editor, and admins read files through the API. | `orchestrator/server/api/editor/*` | `tests/authz/matrix.spec.ts` |
| ED-5 | Workspace trust stays on (no `--disable-workspace-trust`). `--disable-proxy` is set. Machine settings set `task.allowAutomaticTasks: "off"` and disable telemetry. | `editor/` settings, editor manager | `editor-isolation.spec.ts` (checks the container command and settings file) |
| ED-6 | No Docker socket. The only mounts are the user's subpaths of `scantor-editor-home` (home), `scantor-workspaces` (workspace) and `scantor-editor-sockets` (socket directory). The container runs as 1000:1000 with a read-only rootfs (tmpfs `/tmp`), `CapDrop ALL`, `no-new-privileges`, the `SCANTOR_EDITOR_*` pids, memory and CPU limits, restart policy `no` and managed labels. | editor manager | `orchestrator/test/services/editor/manager.test.ts` (container spec) |
| ED-7 | The editor gets a dedicated `editor` API key (`sk_scantor_editor_…`), minted on every start with lifetime `SCANTOR_EDITOR_API_KEY_TTL` and deleted on stop, ban or deletion; the reaper stops the editor 5 minutes before the key expires. The key never has admin power and cannot create editor sessions or API keys ([auth](auth.md) §5.6, §8.3). | `orchestrator/server/utils/principal.ts`, editor manager | `tests/authz/matrix.spec.ts` (an admin's editor key on admin routes → 403 `adminRequired`) |
| ED-8 | The editor listener sends `Content-Security-Policy: frame-ancestors 'self' <dashboard origin>` (HDR-4; `'self'` because code-server frames its own origin). The dashboard trusts neither the editor origin for CSRF nor any origin for credentialed CORS. | editor listener, `10.auth.ts`, `orchestrator/server/utils/auth.ts` | `editor-isolation.spec.ts` (POST to the dashboard API with `Origin: <editor origin>` and a session cookie → 403) |
| ED-9 | Cookies are not isolated by port, so on `localhost` the dashboard cookie also reaches the editor port, and editor JavaScript can toss cookies to sibling hosts. The proxy's cookie stripping (ED-2), the origin checks (ED-8) and host-only, `HttpOnly` cookies make this harmless for confidentiality. Login CSRF through cookie tossing remains a residual risk (§9). | – | `editor-isolation.spec.ts` (a request to the editor origin carrying only the dashboard session cookie is not authenticated) |
| ED-10 | Safe socket connect: the user controls their socket directory and could replace `code.sock` with a symlink to the Docker socket or another user's socket. The proxy opens the path with `O_PATH \| O_NOFOLLOW`, requires `fstat` to report a socket owned by uid 1000, and connects through `/proc/self/fd/<n>`, so only that inode is reached ([editor](editor.md) §8.5). | `orchestrator/server/services/editor/` | `orchestrator/test/services/editor/socket.test.ts`; `editor-isolation.spec.ts` (a symlinked `code.sock` is refused) |

### 6.5 Query API injection (T05)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| Q-1 | Recursive stage allowlist (`$match`, `$project`, `$addFields`, `$set`, `$unset`, `$group`, `$sort`, `$limit`, `$skip`, `$count`, `$unwind`, `$bucket`, `$bucketAuto`, `$sortByCount`, `$facet`, `$replaceRoot`, `$replaceWith`, `$sample` with size ≤ 10 000), applied inside `$facet` and every sub-pipeline; a `$facet` nested in a `$facet` is rejected. | `orchestrator/server/services/query/validator.ts` | `orchestrator/test/services/query/validator.test.ts` over `tests/corpora/query-injection/cases.json` |
| Q-2 | Rejected anywhere, as a key at any depth in filter, projection, sort or pipeline: `$where`, `$function`, `$accumulator`, `$lookup`, `$graphLookup`, `$unionWith`, `$out`, `$merge`, `$documents`, `$collStats`, `$indexStats`, `$currentOp`, `$listSessions`, `$planCacheStats`, `$changeStream`, `$search`, `$vectorSearch` → 400 `queryRejected` with `details.path`. | same | same corpus |
| Q-3 | Scope is always `{$and: [{scanId}, {userId: <scan owner>}, <user filter>]}`, and every pipeline starts with that `$match`. Object spread is never used, so `{"scanId": {"$ne": null}}` in the user filter only narrows. | `orchestrator/server/services/query/` | `tests/security/query-injection.spec.ts` (user B, on B's own scan, with escape attempts never sees A's documents) |
| Q-4 | `mongod --noscripting`: no server-side JavaScript, even if the validator had a bug. | mongo command in compose ([deployment](deployment.md)) | `query-injection.spec.ts`: the test connects to MongoDB directly as `scantor_query` (password derived from the test stack's `SCANTOR_SECRET`). A `$where` find fails because scripting is disabled, and an `insertOne` fails as unauthorized. |
| Q-5 | User queries run on a second `MongoClient` authenticated as `scantor_query` (role `read` on the application database only; password from HKDF `mongo-query`), with `maxTimeMS` = `SCANTOR_QUERY_MAX_TIME` (a duration; 504 `queryTimeout`), `allowDiskUse: false`, an appended `$limit` of `SCANTOR_QUERY_MAX_DOCS`, a streamed byte cap, and `SCANTOR_USER_MAX_CONCURRENT_QUERIES` per user (429). | `orchestrator/server/utils/mongo.ts`, query service | `query-injection.spec.ts`; `tests/e2e/limits.spec.ts` |
| Q-6 | Pipelines that reference a `writeOnly` path of the scan (`secretPaths`) are rejected (400 `queryRejected`), because aggregation output cannot be masked; filters, sorts and projection expressions that reference one are rejected too, so they cannot work as an oracle. Query and plain projection results are masked. | query service (`orchestrator/server/services/query/secrets.ts`), `orchestrator/server/utils/secrets.ts` | `tests/security/secrets-masking.spec.ts` |
| Q-7 | Every request body, query string and path parameter on every route is parsed by a strict zod schema (unknown keys rejected, ids `z.uuid()`, bounded strings). Request objects are never placed into MongoDB filters outside the query API. | every route; `orchestrator/server/utils/zod.ts` | `tests/authz/openapi-lint.spec.ts` (every operation with a body declares a schema); fuzz cases in `tests/authz/matrix.spec.ts` (`{"$ne": null}` as an id → 404) |
| Q-8 | Export filters use the same validator, and run as background jobs on the same query client. | `orchestrator/server/services/exports/` | `query-injection.spec.ts` |

### 6.6 Ingestor and runtime trust boundary (T06)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| ING-1 | Scan identity comes only from the broker-validated AMQP `user_id` (`scan-<scanId>`). RabbitMQ rejects publishes whose `user_id` differs from the authenticated user. Topic permissions limit each scan user to routing key `^<scanId>$`. Messages without `user_id`, or whose routing key differs from the `user_id` scan, are rejected and recorded as event `security.ingestRejected`. | `orchestrator/server/services/ingestor/`, topology ([queue](queue.md)) | `tests/security/cross-scan.spec.ts` (with scan A's credentials: routing key B refused by the broker; spoofed `user_id` closes the channel; a message without `user_id` → `security.ingestRejected` and no document) |
| ING-2 | `_id = <scanIdFromUserId>-<seq>` with `seq` an integer, 0 ≤ seq < 2^53. Every write filters on `{_id, scanId}`. Documents are built field by field from an allowlist with type checks; message bodies are never spread or `$set`. A body field `scanId` is ignored. | ingestor `build-document.ts` | `tests/security/cross-scan.spec.ts` (a body claiming scan B lands only under A; negative or fractional seq rejected); `orchestrator/test/services/ingestor/build-document.test.ts` |
| ING-3 | `round` must be ≤ `scan.round`. Results for unknown, `deleting` or `deleted` scans are acked and dropped. Guarded upserts ([data model](data-model.md) §6.3) keep stale duplicates from overwriting newer state. | ingestor | `tests/security/cross-scan.spec.ts` |
| ING-4 | Size limits: RabbitMQ `max_message_size` 4 MiB, a result message ≤ 2 MiB, results ≤ `SCANTOR_MAX_RESULT_BYTES`, analysis configs ≤ `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES`. Any unprocessable message is recorded as a failed analysis (`validation`, or `platform` with phase `ingest`) where possible, then acked. `scantor.results.ingest` has delivery limit 3 and dead-letters to `scantor.dead.ingest`, so poison never stalls other tenants. | ingestor, broker config | `tests/e2e/limits.spec.ts` (oversized result → analysis `failed`/`validation`); `tests/security/cross-scan.spec.ts` (ingestion of other scans continues) |
| ING-5 | Uploads: `POST /api/runtime/uploads/presign` takes the scan from the worker token. The server generates file ids and keys (`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`), checks `seq` against the scan, enforces size and count limits and the per-user quota, and signs `Content-Type` and `Content-Length`. User file names are only metadata and a sanitised last segment. | `orchestrator/server/api/runtime/uploads/presign.post.ts` | `tests/api/runtime-api.spec.ts` (path-like names stay inside the scan prefix; a larger PUT than signed fails) |
| ING-6 | Node reports (`postNodeStatus`, `postWorkerLogs`) are accepted only for workers assigned to the reporting node and for open log request ids; other entries are ignored and logged. | `orchestrator/server/api/node/*` | `tests/api/node-api.spec.ts` (status and logs for workers of another node are ignored) |
| ING-7 | Runtime- and node-reported texts (errors, log tails, stderr tails) are size-bounded ([data model](data-model.md) §8) and stored and rendered as plain text. | runtime, node API, UI | `tests/e2e/limits.spec.ts`; `tests/ui/scan-results.spec.ts` (HDR-5) |

### 6.7 Machine credentials and the node trust model (T07)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| MC-1 | Typed principals, prefix binding and the operation registry ([auth](auth.md) §5): node tokens work only on `/api/node/*` and the registry token route, worker tokens only on `/api/runtime/*`, user credentials only elsewhere. | `orchestrator/server/middleware/10.auth.ts` | `tests/authz/matrix.spec.ts`; `tests/api/node-api.spec.ts`, `tests/api/runtime-api.spec.ts` |
| MC-2 | Node tokens: 32 random bytes, SHA-256 at rest, shown once, rotatable and revocable. Revocation marks the node's workers `lost` at once and denies registry pulls ([auth](auth.md) §10.1). | `orchestrator/server/utils/node-tokens.ts` | `tests/api/nodes.spec.ts` (rotate, revoke); `tests/api/registry-token.spec.ts` (revoked node → 401) |
| MC-3 | Worker tokens: HMAC-derived, never stored, bound to (scan, role, node), valid only in active worker states. Runners cannot call scheduler routes. The runtime removes the token from connector environments ([auth](auth.md) §10.2). | `orchestrator/server/utils/worker-tokens.ts`, `internal/runtime/` (process spawn) | `tests/api/runtime-api.spec.ts` (runner on scheduler routes → 403, stopped worker → 401); `tests/security/sandbox.spec.ts` (a fixture task that prints its environment shows no token) |
| MC-4 | Per-scan RabbitMQ users: HMAC password (never stored), configure `^$`, write `^scantor\.(analyses\|results)$`, read `^scantor\.scan\.<scanId>$`, topic write `^<scanId>$`, connection and channel limits, no management tags. Deleted when the scan ends or is cancelled, which force-closes connections. A boot sweep deletes `scan-*` users without an active scan. | reconciler topology ([queue](queue.md)) | `tests/e2e/lifecycle.spec.ts` (user and queue gone after cancel); `tests/security/sandbox.spec.ts` (the management API rejects the scan user) |
| MC-5 | Registry: native token auth, no `/v2` proxy. Nodes get `pull` only on `tasks/<taskId>` repositories of their active assignments; only the orchestrator credential can push, delete or list the catalog. ES256 tokens are valid 300 s ([auth](auth.md) §10.4). | `orchestrator/server/services/registry/token.ts` | `tests/api/registry-token.spec.ts` (token for node N1 omits a repository assigned only to N2) |
| MC-6 | Node instance lease (a second daemon with the same token gets 409 `nodeInstanceConflict`; a restart on the same engine takes the lease over) and a version window (426 `incompatibleVersion`) ([nodes](nodes.md) §5.2). | node API | `tests/api/node-api.spec.ts` |
| MC-7 | Trust statement: a node sees everything about the scans placed on it (configs including secrets, worker tokens, per-scan AMQP credentials). Separate users or sensitivity levels with node `pool`s and scan `nodeSelector`s. The node creation dialog and the remote-nodes guide state this. | UI, `docs/guide/remote-nodes.md` | – |
| MC-8 | Node daemons pass registry credentials per pull (`X-Registry-Auth`) and never write them to the host's Docker configuration. | `internal/node/images.go` | `internal/node/images_test.go` |
| MC-9 | The built-in node's token is derived from `SCANTOR_SECRET`. The built-in daemon already holds the master's Docker socket, so this adds no exposure. | `internal/keys`, boot upsert | `internal/keys` unit tests over `tests/corpora/keys-vectors.json` |
| MC-10 | Credentials are never logged. Both loggers redact the `authorization`, `x-api-key`, `x-scantor-internal-auth`, `x-scantor-setup-token`, `cookie` and `set-cookie` headers, token-shaped substrings (`sk_scantor_…`, `snt_…`, `swt_…`, `sst_…`, `spk_…`, `sic_…`, `sec_…`), passwords in `amqp(s)://user:pass@` URLs, `X-Amz-Signature` query values, the `/setup?token=` query and git `extraheader` values. The one deliberate exception is the `[setup]` boot line of [auth](auth.md) §7.2, which carries the setup link and is written through a dedicated unredacted logger call (the token is single-purpose, in memory only, and void once a user exists). | `orchestrator/server/utils/redact.ts`, Go `internal/redact` | `orchestrator/test/utils/redact.test.ts`, `internal/redact` unit tests |
| MC-11 | MongoDB keeps no slow-operation log (`--slowOpSampleRate 0`): such a line carries the whole command, including the session token of a better-auth session insert or lookup, and MongoDB Community cannot redact it. | mongo command in compose ([deployment](deployment.md) §4.3) | `tests/security/compose-lint.spec.ts` (the rule fails without the flag); `tests/chaos/chaos.spec.ts` SEC-024 (no live session token in any container log, the MongoDB log included) |

### 6.8 Worker sandbox and egress (T08)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| SB-1 | Hardening profile (one function, used for workers, describe/check and test-run containers; [nodes](nodes.md) §6.3): `CapDrop: [ALL]` plus `CapAdd` from `SCANTOR_WORKER_CAP_ADD`, a subset of the allowlist `NET_BIND_SERVICE`, `NET_RAW` (the daemon rejects anything else; describe/check add none); `SecurityOpt: [no-new-privileges:true]` with Docker's default seccomp and AppArmor profiles; `PidsLimit` = `SCANTOR_NODE_PIDS_LIMIT` for workers (a node-daemon variable), the fixed 256 of [tasks](tasks.md) §9.5 for describe/check containers and the fixed 4096 for test-run containers ([tasks](tasks.md) §11.2), which run analyses like a worker; memory and `NanoCpus` from the assignment, never above the node's totals; `Init: true`; a fixed `nofile` ulimit; rotated `local` logs; no volume, bind or socket mounts. Worker scratch space is the runtime work root `/tmp/scantor` on the container's writable layer, with no tmpfs at `/tmp` ([runtime](runtime.md) §7.1). DinD modes differ only as listed in [nodes](nodes.md) §6.9 (PRIV-*). | `internal/container` (hardening profile) | `tests/security/sandbox.spec.ts` (inspects a running worker's HostConfig) |
| SB-2 | `processes` per worker is capped at `SCANTOR_MAX_PROCESSES_PER_WORKER` in the API and again in the runtime. Container memory is processes × per-process memory + 256 MiB. Connector processes get `oom_score_adj=1000` and their own process group, which is killed on timeout. | API validation, `internal/runtime/` (process pool) | `tests/e2e/limits.spec.ts`; `internal/runtime` unit tests |
| SB-3 | Networks: master workers join `scantor-sandbox` (only orchestrator, rabbitmq and rustfs attached); remote workers join the node-created `scantor-workers` bridge; test runs join `scantor-egress`; describe/check use `none` ([architecture](architecture.md) §6.1). | `internal/node/`, jobs runner | `tests/security/sandbox.spec.ts` (the `netprobe` fixture task cannot open TCP to `mongo:27017`, `registry:5000` or `mongo-express:8081`) |
| SB-4 | Egress deny list `SCANTOR_NODE_EGRESS_DENY` (its shipped value must cover the cloud metadata ranges `169.254.0.0/16` and `fd00:ec2::254/128`, checked by `tests/security/env-example.spec.ts`) enforced through `DOCKER-USER` drop rules by a one-shot `NET_ADMIN` host-network helper (`scantor-netpol-<nodeId>`) on every node. It is best effort: when it cannot be applied, the daemon logs a warning and reports `egressDenyApplied: false`, and the UI shows it on the node. Operators of internet-only nodes add RFC 1918 ranges. | `internal/node/netpol.go` | `tests/security/sandbox.spec.ts` (connecting to `169.254.169.254` fails; skipped with a warning when the test host reports `egressDenyApplied: false`) |
| SB-5 | From a master worker, the platform is reachable only as: `/api/runtime/*` with its worker token; AMQP with its scan user (the management API returns 401 for untagged users); RustFS through presigned URLs only. | network layout, MC-* | `tests/security/sandbox.spec.ts` |
| SB-6 | Image hygiene: pull by digest; remove (not only stop) unassigned containers; prune unreferenced task images after `SCANTOR_NODE_IMAGE_RETENTION`. Leftover containers cannot be reused to read another scan's data. | `internal/node/` | `internal/node/reconcile_test.go` |
| SB-7 | Guidance: run nodes with user-namespace remapping where possible; on cloud nodes set the IMDSv2 hop limit to 1. | `docs/guide/remote-nodes.md` | – |

### 6.9 Privileged and Docker-in-Docker tasks (T09)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| PRIV-1 | Three opt-ins are required: the manifest `defaults.privileged: true`; the user flag `canRunPrivileged` (admin-set, `false` for new users); and a node with `SCANTOR_NODE_DIND=sysbox` or `privileged`. The shipped value for every node, including the built-in node, must be `disabled` (checked by `env-example.spec.ts`). Placement matches the DinD mode, and unplaceable workers stay `pending` with reason `dindUnavailable`. | task pipeline, scan start, placement ([auth](auth.md) §6.2, [nodes](nodes.md) §6.9, §12) | `tests/e2e/privileged.spec.ts` |
| PRIV-2 | `sysbox` (runtime `sysbox-runc`, no `Privileged` flag) is the preferred mode: DinD without host root. `privileged` means root on the node host. Its `.env.example` comment states that enabling it on the master makes every allowed user root on the platform. DinD workers (both `sysbox` and `privileged`) get `SCANTOR_DIND=1`, and the runtime starts the inner `dockerd` that the task image must contain ([runtime](runtime.md)); no other worker ever gets a Docker daemon. | `internal/node/dind.go`, `.env.example` | `internal/node` unit tests (container spec per mode); `tests/security/env-example.spec.ts` |
| PRIV-3 | Describe/check containers, test runs, workspace helpers and editors are never privileged, whatever the manifest says. | `internal/taskpipe`, jobs runner, helper runner, editor manager | `internal/taskpipe` unit test (describe/check HostConfig); `tests/e2e/privileged.spec.ts` (a test run of a privileged task runs unprivileged) |
| PRIV-4 | Enforced at publish (static error), `startScan`, `restartScan`, `resumeScan` and `retryFailedAnalyses` (403 `privilegedNotAllowed`). | see [auth](auth.md) §6.2 | `tests/e2e/privileged.spec.ts` |
| PRIV-5 | Tasks, revisions and scans show a "privileged" badge; admins see which users hold `canRunPrivileged`. | UI ([ui](ui.md)) | `tests/ui/scans.spec.ts` (privileged warning and badge) |

### 6.10 Admin GUIs and data stores (T10)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| GUI-1 | With Traefik, every admin GUI (Traefik dashboard, RabbitMQ management, mongo-express, RustFS console) sits behind `forwardAuth` with the admin-only `scantor_tools` cookie ([auth](auth.md) §11), and still has its own credentials. Only the four tool hosts are accepted; browser navigations without a valid cookie are redirected to `createToolsSession`, everything else gets 401. | compose labels, `orchestrator/server/api/tools/*` | `tests/api/tools.spec.ts` (no cookie, expired, non-admin, banned within 30 s, foreign `X-Forwarded-Host` → 401; `Accept: text/html` without a valid cookie → 302 to `/api/tools/session?target=…`; valid → 200); `tests/ui/admin-tools.spec.ts` |
| GUI-2 | Without Traefik, admin GUIs and MongoDB publish ports only on `SCANTOR_ADMIN_BIND_ADDRESS`, whose shipped value is a loopback address (reach them through an SSH tunnel). | compose ([deployment](deployment.md)) | `tests/security/compose-lint.spec.ts` |
| GUI-3 | The MongoDB TCP router stays off unless `SCANTOR_EXPOSE_MONGO=true` (the shipped value must be `false`). When enabled, it requires TLS through Traefik and a read-only analytics user. Direct MongoDB access bypasses per-user scoping and is admin-only; the docs say so. | compose, boot ([deployment](deployment.md)) | `tests/security/compose-lint.spec.ts`; `tests/security/env-example.spec.ts` |
| GUI-4 | mongo-express runs read-only (`ME_CONFIG_OPTIONS_READONLY` from `SCANTOR_MONGO_EXPRESS_READONLY`, whose shipped value must be `true`). That option only hides its write controls, so read-only mongo-express also connects as the read-only analytics user and MongoDB refuses every write; the root URL is removed from its process environment before it starts. It has its own credentials (`-insecure-dev` in development, so CFG-2 applies), and is bound to the admin address and behind forwardAuth. It is unmaintained and renders attacker-influenced data, so it must never face the internet directly. | compose ([deployment](deployment.md) §4.7), boot step 2 | `tests/security/compose-lint.spec.ts`; `tests/security/env-example.spec.ts`; `tests/security/sandbox.spec.ts` (adding a database through mongo-express fails) |
| GUI-5 | RustFS console CORS is limited to the console origin. The bucket is private, and its CORS allows `GET`/`HEAD` from the dashboard origin only. | compose, boot step 4 | `tests/security/downloads.spec.ts` (preflight from a foreign origin is refused) |
| GUI-6 | RabbitMQ management accepts only the admin user. Per-scan users have no tags. | topology ([queue](queue.md)) | `tests/security/sandbox.spec.ts` |
| GUI-7 | The Traefik API is not insecure (`api.insecure=false`) and the dashboard is routed only through forwardAuth. | compose | `tests/security/compose-lint.spec.ts` |
| GUI-8 | The registry is not browsable: catalog access is granted only to the orchestrator credential. | MC-5 | `tests/api/registry-token.spec.ts` |

### 6.11 Secure-by-default configuration and first-admin setup (T11)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| CFG-1 | `.env.example` documents every variable. Development secrets end in `-insecure-dev`: every non-empty default of a variable whose name contains `PASSWORD` or `SECRET` (`SCANTOR_S3_SECRET_KEY` does, `SCANTOR_S3_ACCESS_KEY` does not). Secrets that default to empty (`SCANTOR_ADMIN_PASSWORD`, `SCANTOR_TOKEN`, `SCANTOR_NODE_TOKEN`, `CF_DNS_API_TOKEN`) are allowed ([deployment](deployment.md) §8.1). `just init` creates or completes `.env` from it and replaces every `*-insecure-dev` value it writes with 48 random hex characters (24 random bytes), never touching keys already present ([deployment](deployment.md) §8.3). | `.env.example`, `justfile` | `tests/security/env-example.spec.ts` (every variable read by code appears in `.env.example`; every non-empty default of a variable whose name contains `PASSWORD` or `SECRET` ends in `-insecure-dev`) |
| CFG-2 | Startup guard (algorithm below) refuses insecure secrets in a public deployment. | `orchestrator/server/utils/startup-guard.ts` (boot step 1) | `orchestrator/test/utils/startup-guard.test.ts` (unit, full truth table); `tests/security/insecure-secrets.spec.ts` (an orchestrator container with a public URL and the default secret exits 1 and names the variables) |
| CFG-3 | Host ports bind to `SCANTOR_BIND_ADDRESS` (orchestrator, editor port, AMQP, S3, registry) and `SCANTOR_ADMIN_BIND_ADDRESS` (MongoDB, mongo-express, RabbitMQ management, RustFS console). `.env.example` must ship loopback values for both (checked by `env-example.spec.ts`). Every port is configurable. | compose | `tests/security/compose-lint.spec.ts`; `tests/security/env-example.spec.ts` |
| CFG-4 | One root secret: every internal key is HKDF-derived ([auth](auth.md) §3). No plaintext secret is stored in MongoDB ([data model](data-model.md) §7, invariant 8). | `keys.ts`, `internal/keys` | `orchestrator/test/utils/keys.test.ts` and `internal/keys` unit tests over `tests/corpora/keys-vectors.json` |
| CFG-5 | First admin only through the per-boot setup token or `SCANTOR_ADMIN_EMAIL`/`SCANTOR_ADMIN_PASSWORD` ([auth](auth.md) §7). | `orchestrator/server/utils/setup.ts` | `tests/security/setup-token.spec.ts` (missing or wrong token → 401 `setupTokenInvalid`; right token → 201; again → 409 `setupCompleted`; the token appears in the logs) |
| CFG-6 | No self sign-up (`disableSignUp`, `/sign-up/email` disabled). | `auth.ts` | `tests/security/auth-endpoints.spec.ts` |
| CFG-7 | Invalid values for security-relevant variables abort startup ([architecture](architecture.md) §10): URLs, bind addresses, booleans of the `ALLOW_*`/`TRUST_*` family, `SCANTOR_PASSKEY_RP_ID`, `SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS`, the egress deny list. | `orchestrator/server/utils/config.ts`, Go `internal/envconf` loaders | `orchestrator/test/utils/config.test.ts`; `internal/envconf` unit tests |
| CFG-8 | `.env.example` notes that MongoDB and RabbitMQ root passwords apply only at first initialisation, so leaked defaults stick until rotated by hand ([deployment](deployment.md) §14.3). | `.env.example` | `tests/security/env-example.spec.ts` |

Startup guard (CFG-2):

```
loopbackHost(h)  = h == "localhost" || h ends with ".localhost" || h ∈ 127.0.0.0/8 || h == "::1"
loopbackAddr(a)  = a ∈ 127.0.0.0/8 || a == "::1"

if origin(SCANTOR_EDITOR_URL) == origin(SCANTOR_PUBLIC_URL):
    log error "SCANTOR_EDITOR_URL must have its own origin"; exit 1        (always; no override)

publicMode = !loopbackHost(host(SCANTOR_PUBLIC_URL)) || !loopbackHost(host(SCANTOR_EDITOR_URL))
          || "traefik" ∈ split(COMPOSE_PROFILES, ",")
          || !loopbackAddr(SCANTOR_BIND_ADDRESS) || !loopbackAddr(SCANTOR_ADMIN_BIND_ADDRESS)

coreSecrets = [SCANTOR_SECRET, SCANTOR_MONGO_PASSWORD, SCANTOR_RABBITMQ_PASSWORD, SCANTOR_S3_SECRET_KEY,
               SCANTOR_MONGO_EXPRESS_PASSWORD, SCANTOR_MONGO_EXPRESS_SECRET]
            + [SCANTOR_MONGO_ANALYTICS_PASSWORD if SCANTOR_EXPOSE_MONGO == "true" or SCANTOR_MONGO_EXPRESS_READONLY == "true"]

offenders  = { name | process.env[name] ends with "-insecure-dev" }          (any variable, not a fixed list)
           ∪ { name ∈ coreSecrets | length(process.env[name]) < 16 }
           ∪ { "SCANTOR_ADMIN_PASSWORD" | non-empty and length < 16 }

if publicMode and offenders ≠ ∅:
    if SCANTOR_ALLOW_INSECURE_DEFAULTS == "true": warn once per name, continue
    else: log error "refusing to start: insecure secrets in a public deployment: <names> (run `just init`)"; exit 1
if not publicMode and offenders ≠ ∅: log info "development secrets in use"
```

Only variable **names** are logged, never values. The orchestrator receives the whole `.env` through
`env_file`, so the suffix rule covers infrastructure secrets it does not use itself, and `COMPOSE_PROFILES`
from that file is the signal that Traefik is enabled ([deployment](deployment.md) §4.1). This algorithm is
authoritative; [architecture](architecture.md) §4.1 step 1 and [deployment](deployment.md) §8.2 summarise it.

### 6.12 Authentication, sessions and ownership (T12)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| AUTH-1 | better-auth with `disableSignUp`. Over HTTP better-auth answers only an allowlist of the endpoints scantor uses (method and path, exact match, deny by default); every other endpoint, including unused, admin and plugin endpoints added by upgrades, is 404 ([auth](auth.md) §2.5). Passwords are hashed by better-auth (scrypt), 8–128 characters. | `orchestrator/server/utils/auth-policy.ts`, `orchestrator/server/utils/auth.ts` | `tests/security/auth-endpoints.spec.ts` (each unused path → 404, also with a session); `orchestrator/test/utils/auth-policy.test.ts` |
| AUTH-2 | Session cookie: host-only, `HttpOnly`, `SameSite=Lax`, `Secure` (with the `__Secure-` prefix) on https, 7 days, no cookie cache. | same | `tests/security/auth-endpoints.spec.ts` (Set-Cookie attributes) |
| AUTH-3 | CSRF: cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` need a trusted `Origin` (the public origin only; never the editor origin), plus better-auth's own origin and Fetch-Metadata checks. No credentialed CORS anywhere. GET routes have no side effects except the two documented in [auth](auth.md) §4.2. | `10.auth.ts` | `tests/security/csrf.spec.ts` (foreign or missing Origin → 403; API keys need no Origin) |
| AUTH-4 | Banned users are rejected on every user principal within ≤ 30 s. A ban deletes sessions, API keys, OAuth tokens and consents, and stops the editor ([auth](auth.md) §5.7). | `users.ts`, `10.auth.ts` | `tests/security/banned.spec.ts` (session, API key, MCP token and tools cookie rejected after ban; keys gone; editor stopped) |
| AUTH-5 | API keys: 64 random letters plus prefix, stored as SHA-256, shown once, with expiry. Per-key rate limiting is off (it would break the CLI). Keys are rejected on `/api/auth/*`, so they can never become a better-auth session (passkey registration, email change, OAuth consent). | `auth.ts`, `10.auth.ts` | `tests/security/auth-endpoints.spec.ts` |
| AUTH-6 | Rate limits on sign-in, passkey authentication, password and email change, and OAuth registration. The client IP is taken from `x-scantor-client-ip`, which scantor sets from the socket or, only with `SCANTOR_TRUST_PROXY=true`, from the rightmost `X-Forwarded-For` entry. Spoofed `X-Forwarded-For` therefore cannot spread attempts across buckets. | `00.request.ts`, `auth.ts` | `tests/security/auth-endpoints.spec.ts` (11 sign-ins with rotating client-supplied `X-Forwarded-For` values → the 11th is 429) |
| AUTH-7 | Ownership: foreign resources are 404 (never 403). One-query `loadOwned`. `ownerFilter` for lists. Caller-scoped name lookups. Create bodies may reference only the caller's documents. The operation registry denies routes without OpenAPI metadata ([auth](auth.md) §5.4, §9). | `orchestrator/server/utils/authz.ts`, `operations.ts` | `tests/authz/matrix.spec.ts` (§7) |
| AUTH-8 | Credential invariant (no removal of the last password or passkey) and a fresh-session requirement for passkey registration ([auth](auth.md) §6.4). | `11.passkey-guard.ts` | `tests/api/account.spec.ts` |
| AUTH-9 | Effective role: an `editor` key or an MCP grant without `scantor:admin` never carries admin power ([auth](auth.md) §5.6). | `principal.ts` | `tests/authz/matrix.spec.ts` |
| AUTH-10 | Setup, node, worker, registry, tools and editor secrets are compared in constant time (hash first when lengths may differ). | respective utils | unit tests per util |

### 6.13 MCP and agents (T13)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| MCP-1 | Scopes `scantor:read`/`write`/`admin`. Tools are filtered per level. The consent page defaults to "Read and write", offers "Read only", and never preselects admin. `scantor:admin` is stripped for non-admins ([mcp](mcp.md) §3.2–3.3). | `orchestrator/server/services/mcp/`, consent hook | `tests/mcp/oauth.spec.ts`, `tests/mcp/tools.spec.ts`, `tests/ui/consent.spec.ts` |
| MCP-2 | Target-, code- and third-party-derived values are wrapped as `{"untrusted_data": …}`. The MCP instructions, the tool descriptions and the skills state that such content is data, never instructions ([mcp](mcp.md) §4.6). | `services/mcp/untrusted.ts`, `docs/guide/mcp.md`, `skills/` | `tests/mcp/tools.spec.ts`, `tests/mcp/agent-loop.spec.ts`; `tests/mcp/drift.spec.ts` |
| MCP-3 | Destructive tools are annotated (`destructiveHint`), so clients ask the user to confirm. `confirmationRequired` for large scans forces a second, explicit call. | `services/mcp/tools.ts` | `tests/mcp/tools.spec.ts` |
| MCP-4 | Redirect-URI policy (http loopback, operator-listed https origins, private-use schemes), enforced at registration and at every authorization. CIMD metadata is fetched over https only with the SSRF-hardened fetcher. The consent page shows the redirect origin ([mcp](mcp.md) §3.4–3.5). | `auth.ts` | `tests/mcp/oauth.spec.ts`; `tests/ui/consent.spec.ts` |
| MCP-5 | Every `/mcp` request re-checks that the user exists and is not banned and that the client's consent exists. Revoking an app cuts it off immediately. | `services/mcp/auth.ts` | `tests/mcp/oauth.spec.ts`; `tests/security/banned.spec.ts` |
| MCP-6 | Tools execute through the REST routes with single-use loopback capabilities bound to one operation, so validation, ownership, masking and limits are identical. OAuth tokens are never forwarded. | `services/mcp/bridge.ts`, `internal-auth.ts` | `tests/authz/matrix.spec.ts` (MCP half) |
| MCP-7 | 256 KiB response cap with explicit truncation, `wait` clamped to 50 s, and query defaults of 20 rows. This prevents context flooding and runaway calls. | `services/mcp/bridge.ts` | `tests/mcp/limits.spec.ts`, `tests/mcp/tools.spec.ts` |
| MCP-8 | No tool manages credentials or identity (API keys, OAuth apps, users, git credentials, editor sessions). `writeOnly` values are masked before they reach the agent. | curated list ([mcp](mcp.md) §5) | `tests/mcp/tools.spec.ts` (catalogue equals the curated list) |
| MCP-9 | Residual: a prompt-injected agent can still act within its granted level, for example cancel or delete the user's scans with `write`. Users grant "Read only" for analysis-only agents. | – | – |

### 6.14 Transport security for remote nodes (T14)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| TLS-1 | The node daemon and the runtime refuse `http://` and `amqp://` URLs (orchestrator, AMQP, presigned S3) unless every address the host resolves to is loopback (`127.0.0.0/8`, `::1`), RFC 1918, CGNAT (`100.64.0.0/10`, private overlays such as WireGuard or Tailscale) or IPv6 ULA (`fc00::/7`), or `SCANTOR_ALLOW_INSECURE_TRANSPORT=true`. The check runs in the dialer on the actual peer address, so DNS changes cannot bypass it ([architecture](architecture.md) §6.3, [nodes](nodes.md) §11). Registry pulls are made by the node host's Docker daemon and are covered by TLS-5. | shared transport policy in `internal/api`, used by `internal/node` and `internal/runtime` | `internal/api` unit tests (URL and peer-address policy table) |
| TLS-2 | TLS verification is always on. No skip-verify option exists; the test stack uses a test CA through `SCANTOR_CA_CERT`. | Go HTTP/AMQP clients | `tests/e2e/remote-node.spec.ts` (simulated remote node against a TLS endpoint with the test CA) |
| TLS-3 | Custom CA: `SCANTOR_CA_CERT` (PEM in env) is appended to the system roots of the daemon, never replacing them, and passed unchanged into worker environments. | `internal/api`, `internal/node/` | `internal/api` unit tests |
| TLS-4 | The master hands remote nodes only the `public` endpoint profile: `SCANTOR_PUBLIC_URL`, `SCANTOR_AMQP_PUBLIC_URL`, `SCANTOR_S3_PUBLIC_URL`, `SCANTOR_REGISTRY_PUBLIC_HOST` ([architecture](architecture.md) §8). With Traefik these are https/amqps on :443 (AMQPS via SNI). | endpoint profiles | `tests/e2e/remote-node.spec.ts` |
| TLS-5 | Remote nodes pull through `SCANTOR_REGISTRY_PUBLIC_HOST` (`registry.<domain>`) over TLS. Using `insecure-registries` is only supported on private networks; a custom CA goes into Docker's `certs.d` on the node host ([nodes](nodes.md) §10.3). | `docs/guide/remote-nodes.md` | `tests/e2e/remote-node.spec.ts` |
| TLS-6 | Traefik's fallback self-signed certificate changes on every restart. Production uses ACME (DNS-01), a private ACME CA, or an operator-provided default certificate through Traefik's file-provider directory, plus `SCANTOR_CA_CERT` on nodes for private CAs. | [deployment](deployment.md) §7.4 | – |

### 6.15 Downloads and exports (T15)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| DL-1 | Presigned GETs force `ResponseContentDisposition: attachment; filename*=UTF-8''<RFC 5987 encoding of the sanitised name>` and `ResponseContentType: application/octet-stream`. The exception is `image/png`, `image/jpeg`, `image/gif` and `image/webp`, which are served `inline` with the forced image type. HTML, SVG and XML are never inline. URLs live 10 minutes and are created per request. | `orchestrator/server/utils/s3.ts` (`presignDownload`) | `tests/security/downloads.spec.ts` (an HTML file from a fixture task downloads as an octet-stream attachment; PNG is inline; a name with CR/LF/quotes is sanitised) |
| DL-2 | CSV export prefixes every cell starting with `=`, `+`, `-`, `@`, tab or CR with `'`. Nested values are JSON-encoded. | `orchestrator/server/services/exports/csv.ts` | `orchestrator/test/services/exports/csv.test.ts`; `tests/api/exports.spec.ts` |
| DL-3 | Export, snapshot and file keys are server-generated, owner-checked before presigning, and live in a private bucket with lifecycle expiry. | exports, files routes | `tests/authz/matrix.spec.ts` |
| DL-4 | S3 is served on its own origin (`SCANTOR_S3_PUBLIC_URL`, for example `s3.<domain>`). Inline images can never execute script on the dashboard origin, and the bucket answers only signed requests. | deployment | `tests/security/downloads.spec.ts` (unsigned GET → 403) |
| DL-5 | Revision source downloads use the same presign helper with `application/gzip` attachments. | `downloadRevisionSource` | `tests/security/downloads.spec.ts` |

### 6.16 Secrets in configs and logs (T16)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| SEC-1 | JSON Schema `writeOnly: true` values (pydantic `SecretStr`, `secret()` in TypeScript and JavaScript, `scantor.Secret` in Go; [tasks](tasks.md) §6.5) become `secretPaths`. They are encrypted at rest (HKDF label `config-secrets`) in `scans.secrets` and `testRuns.secrets`, replaced by `"***"` in every API response, export and MCP result, and returned in clear only by `GET /api/runtime/bootstrap` to that scan's workers. | `orchestrator/server/utils/secrets.ts` | `tests/security/secrets-masking.spec.ts` |
| SEC-2 | Analysis configs and results are masked by `secretPaths.analysisConfig`/`result` on read and export. Aggregations that reference secret paths are rejected (Q-6). | same | same |
| SEC-3 | Restart clones copy encrypted secrets server-side, never through a response. | `restartScan` | same |
| SEC-4 | Git credentials are encrypted and write-only (WS-7). | – | `tests/api/git.spec.ts`, `tests/api/credentials.spec.ts` |
| SEC-5 | Log redaction (MC-10). Secrets that user code prints into logs or results cannot be detected; the authoring guides say so. | loggers, `docs/guide/` | `orchestrator/test/utils/redact.test.ts` |
| SEC-6 | Remote nodes receive the secrets of scans placed on them (MC-7). | – | – |
| SEC-7 | `getInstanceInfo` and the admin settings show only "set"/"not set" for secrets, never values. | `orchestrator/server/api/info.get.ts` | `tests/security/secrets-masking.spec.ts` |

### 6.17 Resource exhaustion (T17)

| Id | Limit | Enforced by | Test |
|---|---|---|---|
| RES-1 | request body `SCANTOR_MAX_REQUEST_BYTES`; `/api/runtime/*` 1 MiB; node status and logs 2 MiB; streaming uploads under their own caps (413 `payloadTooLarge`) | `02.body-limit.ts`, upload routes | `tests/api/errors.spec.ts` (413); `tests/e2e/limits.spec.ts` |
| RES-2 | per-scan queue `x-max-length = SCANTOR_SCAN_QUEUE_MAX_READY` with `reject-publish` (scheduler backpressure); delivery limit `SCANTOR_DELIVERY_LIMIT` | topology ([queue](queue.md)) | `tests/e2e/backpressure.spec.ts` |
| RES-3 | per-scan RabbitMQ user limits `max-connections` and `max-channels`; RabbitMQ memory and disk limits; MongoDB cache size; container `mem_limit`s | topology, compose | `tests/security/compose-lint.spec.ts` |
| RES-4 | message and document sizes (ING-4); analyses per scan `SCANTOR_MAX_ANALYSES_PER_SCAN`; confirmation above `SCANTOR_SCAN_CONFIRM_THRESHOLD` | runtime, API | `tests/e2e/limits.spec.ts`; `tests/api/scans.spec.ts` (confirmation) |
| RES-5 | files: `SCANTOR_MAX_FILE_BYTES` (signed `Content-Length`), `SCANTOR_MAX_FILES_PER_ANALYSIS`, per-user `SCANTOR_USER_STORAGE_QUOTA_BYTES` (403 `quotaExceeded`) | presign route | `tests/e2e/files.spec.ts` (quota); `tests/e2e/limits.spec.ts` |
| RES-6 | workers per scan `SCANTOR_MAX_WORKERS_PER_SCAN`, processes per worker, per-user `maxWorkers`, node capacity, PIDs limit | API, placement, node | `tests/e2e/limits.spec.ts` |
| RES-7 | builds and test runs: timeout, concurrency, image size, cache prune (BLD-9); test runs `limit` ≤ 50, `maxAttempts` ≤ 5, `SCANTOR_TEST_RUN_TIMEOUT`, `SCANTOR_TEST_RUN_CONCURRENCY` | jobs runner | `tests/e2e/limits.spec.ts` |
| RES-8 | workspace: helper timeout, file and byte caps (WS-3); git shallow clone with timeout | helpers | `tests/security/tar-slip.spec.ts` |
| RES-9 | queries: time, documents, bytes, per-user concurrency (Q-5); waits per user `SCANTOR_MAX_CONCURRENT_WAITS` (429 `tooManyRequests`) | API | `tests/api/wait.spec.ts`; `tests/security/query-injection.spec.ts` |
| RES-10 | auth rate limits (AUTH-6) | better-auth | `tests/security/auth-endpoints.spec.ts` |
| RES-11 | bounded storage: events TTL, worker document TTL, log tails, conditions ≤ 16, attempts ≤ 10 ([data model](data-model.md) §8) | writers, TTL indexes | – |
| RES-12 | circuit breaker auto-pauses failure storms; a broker alarm refuses new scans (503 `brokerAlarm`) | ingestor, API | `tests/e2e/breaker.spec.ts` |

### 6.18 Security headers and browser rendering (T18)

| Id | Mitigation | Implementation | Test |
|---|---|---|---|
| HDR-1 | Dashboard host, required on every response: a `Content-Security-Policy` containing at least `frame-ancestors 'self'`, `object-src 'none'` and `base-uri 'self'` (the full policy is in [ui](ui.md) §13); `X-Content-Type-Options: nosniff`; `Referrer-Policy: same-origin`; `Cross-Origin-Opener-Policy: same-origin`; and `Strict-Transport-Security: max-age=31536000` when `SCANTOR_PUBLIC_URL` is https. `script-src` uses a per-request nonce only if that works reliably in Nuxt 4 SPA mode; otherwise it is `'self'` plus hashes of the shell's inline scripts, or `'unsafe-inline'` scoped as narrowly as possible. The CSP must never break the app. | `orchestrator/server/plugins/security-headers.ts` (Nitro `request` hook, before every handler including the public assets; per-response nonce) | `tests/ui/headers.spec.ts` (headers present; no CSP violations in the console) |
| HDR-2 | `/oauth/consent`, `/setup` and `/login` send `frame-ancestors 'none'` (no clickjacked consent or setup). | same | same |
| HDR-3 | `/api/*` responses send `Cache-Control: no-store`. | `10.auth.ts` | `tests/api/errors.spec.ts` |
| HDR-4 | Editor listener, every response: `Content-Security-Policy: frame-ancestors 'self' <dashboard origin>` as an additional header (`'self'` is required because code-server frames its own origin, [editor](editor.md) §8.8) (code-server's own CSP is kept), `nosniff`, `Referrer-Policy: same-origin` (`no-referrer` on `/_auth`), HSTS when `SCANTOR_EDITOR_URL` is https ([editor](editor.md) §8.8). | editor listener | `tests/security/editor-isolation.spec.ts` |
| HDR-5 | The UI renders results, logs, errors and file names as text. `v-html` is forbidden (lint rule `vue/no-v-html` as error). ANSI sequences are stripped. Result strings are never linkified; other data-derived links (such as a client URI on the consent page) are rendered only for `http(s):` URLs with `rel="noopener noreferrer"`. | `orchestrator/app/`, ESLint config | `tests/ui/scan-results.spec.ts` (a result containing `<img src=x onerror=…>` renders inert) |
| HDR-6 | The setup token is removed from the address bar, and `Referrer-Policy` keeps it out of `Referer` ([auth](auth.md) §7.2). | `/setup` page | `tests/ui/setup.spec.ts` |

## 7. Authorization matrix test

`tests/authz/matrix.spec.ts` ([testing](testing.md) §8.5) is generated at run time from
`GET /api/docs/openapi.json`. It enforces G1 and the scope model for every operation, including operations
added later, without hand-written cases per route.

**Fixtures** (seeded through the API in the spec's `beforeAll`):

| Principal | Resources |
|---|---|
| admin `admin@test` | session, `default` API key |
| user A | session, `default` key, `editor` key (from starting the editor), MCP OAuth token (read and write), MCP token (read only); task `alpha` (python scaffold), ready revision, completed test run with one analysis and one file, completed scan (template `single`) with one analysis and one file, ready export, list upload, git credential, a pending job |
| user B | session, `default` key, MCP token; its own task with the **same name** `alpha` (proves name lookups are caller-scoped) |
| nodes | the built-in node; a simulated remote node N1 (token known to the test) |
| worker | worker tokens for A's scan, derived by `tests/helpers/keys.ts` from the test stack's `SCANTOR_SECRET` and the worker documents (`listScanWorkers` as admin) |

A **parameter map** gives a value for every path parameter name (`{task}` → A's task **id**, `{revision}` →
A's revision id, `{scanId}`, `{analysisId}`, `{fileId}`, `{testRunId}`, `{exportId}`, `{uploadId}`,
`{credentialId}`, `{keyId}`, `{clientId}`, `{jobId}`, `{workerId}`, `{userId}`, `{nodeId}`, `{template}`,
`{language}`, `{guide}`). **Request factories** in `tests/authz/requests.ts`, keyed by operationId, build
a minimal valid body and query that reference A's resources (for example
`startScan {revision: <A revision id>}`). An operation whose parameters, body or required query has no entry
fails the test with its operationId, so new routes cannot slip through.

**Expectations** ("ok" = any status other than 401, 403 and 404; state conflicts such as 409/422 are fine):

| `x-scantor-scope` | anonymous | user B with A's ids | user A | admin | A's API key | node / worker / setup credentials |
|---|---|---|---|---|---|---|
| `owner` | 401 | **404** | ok | ok (editor routes: own editor) | ok, but 403 `sessionRequired` if `x-session-only` | 401 |
| `admin` | 401 | 403 `adminRequired` | 403 `adminRequired` | ok | 403 `adminRequired` | 401 |
| `public` | ok | ok | ok | ok | ok | ok |
| `node` | 401 | 401 | 401 | 401 | 401 | N1: ok for own workers; worker ids of another node → 404 / ignored |
| `worker` | 401 | 401 | 401 | 401 | 401 | worker token: ok; runner token on scheduler routes → 403; token of a stopped worker → 401; node token → 401 |
| `setup` | 401 `setupTokenInvalid` / 409 `setupCompleted` | 409 | 409 | 409 | 409 | 409 |
| `tools` | 401 | 401 (B's cookie is not an admin's) | 401 | ok with an admin tools cookie | 401 | 401 |

Additional generated cases:

1. **Create references**: as B, every top-level create whose request factory references A's resources
   (revision, uploads, credential) → 404.
2. **Lists**: as B, no list response contains any of A's ids; as B with `?userId=<A>` → 403 `adminRequired`.
3. **Names**: as B, `{task}` = `alpha` resolves to B's own task, never A's. As admin, `alpha` resolves to the
   admin's own tasks (none: 404).
4. **Editor key**: A's `editor` key on every admin operation → 403 `adminRequired` (A is promoted to admin for
   this case and demoted afterwards); on `createEditorSession` → 403 `forbidden`.
5. **Injection**: ids replaced by `{"$ne": null}` (URL-encoded) or `../` → 404 or 400, never 2xx.
6. **MCP half**: for B's read/write MCP session, `tools/list` equals the read and write tools of [mcp](mcp.md)
   §5. `tools/call` of every tool with A's ids returns `isError` with `httpStatus: 404`. For the read-only
   token, write tools are absent. For a non-admin, `list_nodes` is absent even when `scantor:admin` was
   requested.
7. **Ordering**: reads run first; destructive operations (`DELETE`, `x-destructive`, cancel, retry,
   ban, rotate) run last against throwaway copies created per case.

`tests/authz/openapi-lint.spec.ts` complements the matrix. It fails when an operation lacks `x-scantor-scope`
or `x-mcp`, when `x-admin-only` disagrees with scope `admin`, when `x-session-only` or `x-destructive` is
misplaced ([api](api.md) §1.1), when the scope disagrees with the route prefix ([auth](auth.md) §5.4), when
an operationId is duplicated or not camelCase verb-first, when more than 30 operations have `x-mcp: true`,
when a request body has no schema, or when a route file exists without OpenAPI metadata.

## 8. Security test inventory

Locations follow [testing](testing.md) §2. This table is the inventory of security tests.

| Corpus / spec | Location | Cases |
|---|---|---|
| Dockerfile policy corpus | `tests/corpora/dockerfile-policy/<case>/{Dockerfile,expect.json}`, read by the `internal/taskpipe` unit tests; `tests/security/dockerfile-policy.spec.ts` (one sample per rule through `uploadTask`) | one case per rule BLD-1…7 and LBL-2, with the expected `{line, message}` (`COPY --from` a local task image, `FROM localhost:5000/…`, `FROM 0.0.0.0:5000/…`, `FROM sha256:…`, `ADD https://…`, `ADD git@…`, cache/secret/ssh mounts, `# syntax=`, `RUN --network=host`, `ONBUILD`, `LABEL traefik.enable=true`, `ARG K=traefik.x` + `LABEL $K=1`) |
| Hostile labels | `tests/corpora/hostile-labels/Dockerfile`; Go integration tests; `tests/security/hostile-labels.spec.ts` | static LABEL; ARG-expanded key; post-build label check; a pre-built image with hostile labels swapped into a ready revision runs with the managed labels; Traefik routing unaffected |
| Tar/zip slip and paths | `tests/corpora/tar-slip/cases.json` and `tests/corpora/paths/cases.json`, read by the `internal/workspace` unit tests; `tests/security/tar-slip.spec.ts` | `../x`, `/abs`, `a/../../x`, backslashes, NUL, symlink, hardlink, char device, FIFO, duplicate entries, 10 001 files, gzip bomb (1 KiB → 1 GiB), 1025-byte path, an existing workspace symlink pointing outside |
| Query injection | `tests/corpora/query-injection/cases.json`, read by `orchestrator/test/services/query/validator.test.ts`; `tests/security/query-injection.spec.ts` | `$facet`→`$lookup`, `$unionWith`, `$graphLookup`, `$function` in `$project`/`$addFields`/`$expr`, `$where`, `$accumulator` in `$group`, nested `$out`/`$merge`, `$documents`, `{"scanId": {"$ne": null}}`, `$sample` over 10 000, deeply nested `$facet` |
| Ingest trust | `tests/security/cross-scan.spec.ts` | cross-scan routing key, spoofed `user_id`, body `scanId` of another scan, seq −1 / 1.5 / 2^53, round > scan round, missing `user_id` |
| Machine credentials | `tests/api/node-api.spec.ts`, `tests/api/runtime-api.spec.ts`, `tests/api/registry-token.spec.ts`, `tests/api/nodes.spec.ts` | wrong-prefix credentials, revoked/rotated node token, foreign worker report, runner on scheduler routes, stopped worker token, registry grants |
| Banned user | `tests/security/banned.spec.ts` | session, `default` key, `editor` key, MCP OAuth token, MCP API key, tools cookie; editor stopped; scans cancelled when requested |
| Setup token | `tests/security/setup-token.spec.ts` | throwaway zero-user orchestrator ([testing](testing.md) §8.6): missing, wrong, right, repeated; passkey setup token |
| Startup guard | `orchestrator/test/utils/startup-guard.test.ts`; `tests/security/insecure-secrets.spec.ts` | public URL / editor URL / traefik profile / non-loopback bind × insecure suffix / short secret / allow flag; same-origin editor URL |
| Editor isolation | `tests/security/editor-isolation.spec.ts`; `orchestrator/test/services/editor/{proxy,socket,manager}.test.ts` | ED-1…10: 421 host checks, single-use codes, cookies invalid after stop, stripped headers and `Set-Cookie`, foreign-Origin upgrade, symlinked socket |
| Sandbox | `tests/security/sandbox.spec.ts` (`netprobe` fixture task on the built-in and the remote node) | SB-1…5, MC-3, GUI-6, BLD-11 |
| Others | `tests/security/{downloads,secrets-masking,auth-endpoints,csrf,compose-lint,env-example}.spec.ts`; `tests/api/{tools,git,errors,wait,exports}.spec.ts`; `tests/e2e/{limits,privileged,files,breaker,backpressure,remote-node}.spec.ts`; `tests/ui/{headers,scan-results,setup,consent,admin-tools}.spec.ts`; `tests/authz/{matrix,openapi-lint}.spec.ts`; `tests/mcp/*.spec.ts` | as listed in §6 |

All of these run in `just test` and in the CI workflow, are idempotent, and clean up after themselves
([testing](testing.md)).

## 9. Residual risks and operator guidance

| # | Risk | Guidance |
|---|---|---|
| R1 | Remote nodes see everything about the scans placed on them (Z3). | Add only nodes you trust like the master; use pools and `nodeSelector` to keep sensitive scans on trusted nodes. |
| R2 | Container escape through kernel or runtime bugs; `privileged` DinD is root on the host. | Keep Docker and kernels patched; prefer `sysbox`; never enable `privileged` on the master. |
| R3 | A prompt-injected agent can act within its grant. | Grant "Read only" for analysis agents; keep admin scope off; let clients confirm destructive tools. |
| R4 | Workers and build `RUN` steps can reach the internet and, unless denied, the node's LAN. | Run nodes in network segments without sensitive internal services, or add RFC 1918 ranges to `SCANTOR_NODE_EGRESS_DENY`. |
| R5 | The egress deny list is best effort (no `NET_ADMIN`, unusual firewall setups). | Check `egressDenyApplied` on every node; enforce cloud metadata hop limits. |
| R6 | Login CSRF by cookie tossing from sibling hosts (editor subdomain, `localhost` ports). | Production uses distinct hosts with Secure cookies; the signed-in email is always visible in the UI. Future: `__Host-` cookies. |
| R7 | `script-src` may fall back to hashes or a narrowly scoped `'unsafe-inline'` where a nonce does not work reliably (HDR-1). | Relies on Vue escaping and the `v-html` ban (HDR-5). |
| R8 | Hostile git servers (clone-time git CVEs) and hosts that resolve to public addresses but serve attacker content. DNS rebinding is closed by pinning the validated address (WS-6). | Bounded by the helper sandbox (only the user's subpath, no platform network, no secret but the user's own token) and the deny list; keep the scantor image's git patched. |
| R9 | mongo-express is unmaintained. | Keep it read-only, behind forwardAuth and the admin bind address, or disable its service. |
| R10 | Secrets printed by user code into logs or results are stored in clear. | Documented in the authoring guides; use `writeOnly` config fields and never log them. |
| R11 | The master host holds every secret. | Harden and patch the host; restrict SSH; back up `.env` securely. |
| R12 | Users can aim scans at third parties. | Operator policy; `events` record who started which scan with which configuration. |
| R13 | Auth rate limits are in memory and reset on restart. | Acceptable for one orchestrator; database storage is a future extension. |
| R14 | Writes from the editor terminal are not quota-limited (Docker volumes have no quotas); helpers only refuse to grow a workspace beyond `SCANTOR_WORKSPACE_MAX_BYTES`. | Monitor the master disk (resource guards, [deployment](deployment.md) §9); per-user quotas are a future extension ([editor](editor.md) §13). |

## 10. Credential rotation and incident response

| Situation | Procedure |
|---|---|
| A user's credentials are compromised | Admin bans the user (`banUser`, cancel scans if needed). This deletes sessions, API keys, OAuth grants and the editor key ([auth](auth.md) §5.7). After unban, the user creates new keys. |
| An API key is leaked | The owner deletes it on "CLI & MCP access" (`deleteApiKey`); the next request with it is 401. |
| An MCP client is suspicious | The owner revokes the app (`revokeOAuthApp`); the next `/mcp` call is 401. |
| A node token is leaked or the node is compromised | `revokeNodeToken` (workers lost and rescheduled elsewhere, registry denied), then `rotateNodeToken` for a clean re-join. Treat every scan that ran on the node as exposed (R1): rotate secrets contained in their configs. |
| `SCANTOR_SECRET` is leaked | 1. Cancel or finish running scans (worker tokens and AMQP passwords change). 2. Stop the stack and set a new `SCANTOR_SECRET` (orchestrator and built-in node read the same `.env`). 3. Start it: the built-in node token hash, the registry JWKS and the registry HTTP secret are rewritten at boot (restart the registry afterwards). At boot the orchestrator also detects `jwks` keys it can no longer decrypt and deletes them, so the `jwt()` plugin creates a new key. 4. Users sign in again and MCP clients re-authorise. 5. Re-create git credentials; their old ciphertexts fail to decrypt and are reported as unusable. 6. Scans with `writeOnly` secrets cannot be retried or restarted (decryption fails at bootstrap); start new scans with the secrets supplied again. |
| Infrastructure passwords are leaked | Rotate them inside MongoDB, RabbitMQ and RustFS first (they apply env only at first init), then update `.env` and restart ([deployment](deployment.md) §14.3). |

## 11. Decisions

Made in this document and flagged for lead review:

1. **Post-build label check (LBL-3)** and **ONBUILD rejection for external stage images (BLD-7)**, in
   addition to the static rules. Labels and ONBUILD triggers inherited from external base images are
   invisible to the Dockerfile parser.
2. **Static rule additions**: LABEL keys containing `$` (D9) and unspecified-address registry hosts
   (`0.0.0.0`, `::`; D5) are part of the static rules of [tasks](tasks.md) §8.2.
3. **Workspace writes use Go's `os.Root`** in addition to the `lstat` checks, so pre-existing symlinks in a
   workspace can never redirect a write or read outside the task folder.
4. **The startup guard (CFG-2) is authoritative** (lead ruling). Public mode also triggers on non-loopback
   `SCANTOR_EDITOR_URL`, `SCANTOR_BIND_ADDRESS` or `SCANTOR_ADMIN_BIND_ADDRESS`; every environment value
   ending in `-insecure-dev` is an offender, not only a fixed list; a same-origin editor URL always aborts.
5. **The managed label key set is shared** between Go and TS through `schemas/managed-labels.json`.
6. **Log redaction** is a named component in both stacks (`orchestrator/server/utils/redact.ts`, new Go
   package `internal/redact`) with a fixed list of headers and token shapes.
7. **Undecryptable `jwks` keys are deleted at boot** after a `SCANTOR_SECRET` change, so MCP OAuth recovers
   without manual database work.
8. **Security test locations follow [testing](testing.md) §2** (lead ruling): `tests/security/`,
   `tests/authz/`, `tests/corpora/` and the per-project directories; §8 is the inventory of security tests.
9. **Transport policy** treats CGNAT `100.64.0.0/10` and IPv6 ULA `fc00::/7` like RFC 1918 and checks the
   actual peer address (TLS-1, lead ruling).
10. **Editor isolation relies on the dedicated editor listener** (ED-1, lead ruling) and on the safe socket
    connect of [editor](editor.md) §8.5 (ED-10).
11. **CSP**: the static headers are required; a `script-src` nonce is used only where it works reliably in
    Nuxt 4 SPA mode (HDR-1, lead ruling).

## 12. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Per-user BuildKit cache mounts | BLD-5 rejects `type=cache` today. The policy can instead rewrite `id=` to `<userId>/<id>` because it already parses mounts with BuildKit's parser. |
| Rootless or user-namespaced workers | The hardening profile is one function in `internal/container`; `UsernsMode` or a rootless daemon on nodes needs no API change. |
| gVisor / Kata runtimes for untrusted tasks | The node's DinD mode already selects a runtime (`sysbox-runc`); a per-node runtime setting can select `runsc` for all workers. |
| Separate builder nodes | Builds already run through the stateless `scantor task build`, so builds can move off the master and isolate BLD-* risks from the data stores ([architecture](architecture.md) §14). |
| Strict nonce-based CSP everywhere | The CSP is built in one middleware; switch `script-src` to nonces once Nuxt SPA mode supports them reliably. |
| Network policies beyond the deny list | `internal/node/netpol.go` owns the DOCKER-USER rules; per-scan allowlists can be added as scan settings. |
| Audit log | `events` already supports `userId: null` security events; add `auth.*` and `admin.*` types and a retention independent of `SCANTOR_EVENTS_TTL_DAYS`. |
| Organisation-level isolation | Ownership helpers and the authz matrix are generic over the owner field ([auth](auth.md) §16). |
| STS-scoped S3 credentials | The presign helper is the only S3 credential path for workers; STS would add per-scan prefixes, which keys already have. |
| Signed task images | Revisions reference digests; cosign signatures from the build step can be verified by node daemons before starting workers. |
| Secret scanning of results and logs | The ingestor builds documents field by field, so a redaction pass over `logTail` and results can be inserted there. |
