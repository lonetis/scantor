# scantor features

The inventory of user-visible behaviour that drives test coverage ([testing](../docs/testing.md) §10). Every
subsection id is covered by at least one test tagged with it (`{ tag: ['@F1.1'] }`); `just test-index --check`
fails on uncovered ids and unknown tags. Bullets describe observable behaviour in present tense, including
validation and error paths; mechanisms are documented in `docs/`. New subsections take the next free number,
and ids are never reused.

## F1. Platform

### F1.1 Health

- `GET /api/health` is public and answers `status` (`ok` or `degraded`), the version and the state of each
  component (`mongo`, `rabbitmq`, `s3`, `registry`: `ok` or `down`).

## F2. Sign-in and access

### F2.1 Password sign-in

- A user signs in on the login page with email and password and lands on the overview; a visitor without a
  session is sent to the login page.

### F2.2 API keys

- A `default` API key (`Authorization: Bearer sk_scantor_…`) authenticates REST calls as its owner, like the
  owner's session.

## F3. Scans

### F3.1 Scans from the CLI

- `scantor push <dir> --wait` uploads a task folder and builds a ready revision.
- `scantor scans start <task>@latest --wait -o json` runs a scan to completion, prints the final scan and
  exits 0.

## F4. MCP

### F4.1 MCP with an API key

- `/mcp` accepts a `default` API key as bearer token; `tools/list` returns the tools of level `write` and tools
  can be called.

### F4.2 MCP over OAuth

- An MCP client connects through OAuth 2.1 (protected-resource discovery, a registered client, consent as the
  signed-in user, PKCE); with "Read and write" consent a user sees no admin tools.
