# Authentication and authorization

This document specifies how scantor decides who is calling and what that caller may do. It covers the
better-auth configuration (MongoDB adapter, plugins, sessions, rate limits) and the key derivation from
`SCANTOR_SECRET`. It covers the public URL, trusted origins and proxy handling, and the typed principals
together with the single global middleware that recognises them and binds them to route prefixes. It also
covers roles and per-user limits, first-admin bootstrap, API keys for the CLI and the editor, the ownership
helpers that every route uses, and the machine credentials: node tokens, worker tokens, the registry token
server, the admin-tools cookie and the editor cookie. The REST surface is in [api](api.md), persistent fields
in [data model](data-model.md), the MCP layer in [mcp](mcp.md), and the threat model with all mitigations and
their tests in [security](security.md).

## 1. Overview

```
request
  │
  ├─ request hook       security headers on every response, public assets included (ui §13)
  ├─ 00.request         request id, client IP header (x-scantor-client-ip), 421 for the editor host
  ├─ 01.path            400 badRequest for a path that a URL parser would rewrite (§5.5)
  ├─ 02.body-limit      SCANTOR_MAX_REQUEST_BYTES / per-route caps, chunked bodies counted while they stream
  ├─ 10.auth            (/api/* only)
  │     ├─ route prefix  → which credential kind is parsed (§5.3)
  │     ├─ credential    → principal (§5.2)                         401 unauthorized
  │     ├─ operation     → OpenAPI operation registry (§5.4)         404 notFound / 405
  │     ├─ scope check   → x-scantor-scope, x-session-only, MCP scope 403 adminRequired | sessionRequired | forbidden
  │     ├─ ban check     → user principals                          403 banned
  │     └─ CSRF          → cookie sessions + unsafe method          403 forbidden
  ├─ 11.passkey-guard   (/api/auth/passkey/* only, §6.4)
  │
  └─ route handler
        requireUser / requireAdmin / requireNode / requireWorker / …   (typed principal, defence in depth)
        loadOwned / resolveTask / resolveRevisionRef                   404 for anything not visible
        action
```

| Principal kind | Presented as | Accepted on | Source of identity |
|---|---|---|---|
| `user` via `session` | better-auth cookie `scantor.session_token` (`__Secure-scantor.session_token` on https) | user routes | better-auth `session` |
| `user` via `apiKey` | `x-api-key: sk_scantor_…` or `Authorization: Bearer sk_scantor_…` | user routes, `/mcp` | better-auth `apikey` (hashed) |
| `user` via `mcp` | `x-scantor-internal-auth: sic_…` (loopback listener only) | user routes | in-memory capability minted by the MCP bridge |
| `node` | `Authorization: Bearer snt_…`; Basic `node:snt_…` on the registry token route | `/api/node/*`, `/api/registry/token` | `nodes.tokenHash` |
| `worker` | `Authorization: Bearer swt_<workerId>.<mac>` | `/api/runtime/*` | HMAC over the `workers` document |
| `registry` (orchestrator credential) | Basic `orchestrator:<derived>` | `/api/registry/token` | HKDF-derived, never stored |
| `tools` | cookie `scantor_tools` | `/api/tools/forward-auth` | HS256 JWT |
| `setup` | header `X-Scantor-Setup-Token: sst_…` | `/api/setup/*` mutations | in-memory, per boot |
| `editor` | cookie `scantor_editor` (editor origin) | the editor listener only (container port 3001, [editor](editor.md) §8.1) | HMAC-signed cookie bound to `editors.startedAt` |

This middleware chain runs wherever the Nitro app serves requests: on the dashboard listener (container port
3000) and on the loopback listener, a private listener on `127.0.0.1` with an ephemeral port that only the MCP
bridge of the same process uses for tool calls and the JWKS fetch (`server/utils/loopback.ts`, [mcp](mcp.md) §1,
§4.3). Internal capabilities are accepted only on connections of the loopback listener (§5.2). The editor origin is
a separate HTTP listener outside Nitro ([editor](editor.md) §8.1). `00.request` answers 421 Misdirected Request
when `Host` is the editor host, so no dashboard route is ever reachable there.

MCP OAuth access tokens are not principals of the REST API. They are verified only on `/mcp`, which turns
them into `user` principals via `mcp` ([mcp](mcp.md)).

## 2. better-auth configuration

### 2.1 Packages

`better-auth`, `@better-auth/passkey`, `@better-auth/api-key`, `@better-auth/mcp`,
`@better-auth/oauth-provider` (client plugin only) and `@better-auth/cimd` are pinned to the **same exact
version** (1.7.12) in `orchestrator/package.json`; upgrades move them together. The MongoDB adapter is
`better-auth/adapters/mongodb` (no extra dependency); the driver is `mongodb` 7.x, shared with scantor.
`getMigrations()` must never be called: it supports only Kysely and calls `process.exit(1)` for any other
adapter. Collections are created lazily by the adapter. The adapter also creates the table-level indexes
lazily (on first use of a model, under better-auth's generated names), but never the field-level
`unique`/`index` attributes. Boot step 3 therefore creates every index of better-auth's table metadata
(`$context.tables`; unique only for required fields) under exactly the names better-auth uses
(`getDatabaseIndexName` / `getDatabaseFieldIndexName` from `@better-auth/core/db/internal`, a direct
dependency pinned with the other better-auth packages). With any other name, the adapter's own
`createIndex` for the same key fails with `IndexOptionsConflict` (this broke OAuth client
registration). An index with the same key under another name is dropped and recreated. A failure is
logged and does not stop the boot.

### 2.2 Configuration

`orchestrator/server/utils/auth.ts` builds one instance lazily (`useAuth()`), eagerly initialised in boot
step 3 ([architecture](architecture.md) §4.1). The return type is cast to `any` to avoid TypeScript blow-ups
from nested better-call/zod types; typed wrappers live in `server/utils/users.ts`.

```ts
import { betterAuth } from 'better-auth'
import { admin, jwt } from 'better-auth/plugins'
import { createAuthMiddleware } from 'better-auth/api'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { passkey } from '@better-auth/passkey'
import { apiKey } from '@better-auth/api-key'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'

export const MCP_SCOPES = ['scantor:read', 'scantor:write', 'scantor:admin'] as const
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', ...MCP_SCOPES]

function buildAuth(): any {
  const cfg = useConfig()                       // parsed env (server/utils/config.ts)
  const { db, client } = useMongo()             // the one shared MongoClient
  const pk = resolvePasskeyConfig(cfg)          // §4.4
  const mc = resolveMcpConfig(cfg)              // mcp.md §3.8

  return betterAuth({
    appName: 'scantor',
    baseURL: cfg.publicUrl,                     // SCANTOR_PUBLIC_URL without trailing slash
    basePath: '/api/auth',
    secret: deriveKeyHex('better-auth'),        // §3
    database: mongodbAdapter(db, { client, usePlural: false }),   // transactions on (replica set rs0)
    trustedOrigins: trustedOrigins(cfg),        // §4.2
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true, disableSignUp: true, autoSignIn: false, requireEmailVerification: false,
      minPasswordLength: 8, maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        canRunPrivileged: { type: 'boolean', required: false, defaultValue: false, input: false },
        maxWorkers: { type: 'number', required: false, defaultValue: () => cfg.userMaxWorkers, input: false },
      },
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: 604_800, updateAge: 86_400, freshAge: 86_400,
      cookieCache: { enabled: false },          // bans and revocations take effect on the next request
    },
    rateLimit: RATE_LIMIT,                      // §2.7
    advanced: {
      cookiePrefix: 'scantor',
      useSecureCookies: cfg.publicUrl.startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      database: { generateId: () => crypto.randomUUID() },   // plain uuid strings (data-model §1)
      ipAddress: { ipAddressHeaders: ['x-scantor-client-ip'], ipv6Subnet: 64 },   // §4.3
    },
    databaseHooks: {
      user: { create: { before: lowercaseEmail }, update: { before: lowercaseEmail } },
    },
    hooks: {
      before: createAuthMiddleware(beforeHook), // §2.8
      after: createAuthMiddleware(afterHook),
    },
    plugins: [
      authHttpAllowlist(),                      // §2.5; first, before every other plugin and endpoint
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      apiKey([DEFAULT_KEY_CONFIG, EDITOR_KEY_CONFIG]),           // §8.1
      ...(pk.enabled ? [passkey({
        rpID: pk.rpID, rpName: 'scantor', origin: pk.origin,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        registration: {                         // §7.3
          requireSession: false,
          resolveUser: resolvePasskeySetupUser,
          afterVerification: completePasskeySetupUser,
        },
      })] : []),
      ...(mc.enabled ? [
        jwt(),
        mcp({
          resource: mc.resource,                // `${SCANTOR_PUBLIC_URL}/mcp`
          loginPage: '/login',
          consentPage: '/oauth/consent',
          scopes: OAUTH_SCOPES,
          clientRegistrationDefaultScopes: OAUTH_SCOPES,
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          clientRegistrationDefaultApplicationType: 'infer',
          validateRedirectUri: (uri, _registered, defaultResult) => defaultResult && isAllowedMcpRedirect(uri),
          accessTokenExpiresIn: 3600, refreshTokenExpiresIn: 2_592_000, codeExpiresIn: 600,
        }),
        cimd({
          fetchClientMetadataResource,          // SSRF-hardened node fetcher
          metadataProfile: 'mcp-2026-07-28',
          isMetadataDocumentUrlAllowed: (url) => url.startsWith('https://'),
        }),
      ] : []),
    ],
  })
}
```

Handlers: `orchestrator/server/api/auth/[...all].ts` and `orchestrator/server/routes/.well-known/[...path].ts`
both call `useAuth().handler(toWebRequest(event))`; the HTTP allowlist (§2.5) decides inside that handler which
requests reach an endpoint. The `.well-known` catch-all must also match the bare
path segments that MCP discovery uses (`/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server/api/auth`, `/.well-known/openid-configuration/api/auth`).

### 2.3 MongoDB adapter

| Setting | Value | Why |
|---|---|---|
| adapter | `mongodbAdapter(db, { client, usePlural: false })` | singular collection names (`user`, `session`, `apikey`, …) that never collide with scantor's plural camelCase collections ([data model](data-model.md) §1) |
| transactions | on (implied by `client`) | requires the single-node replica set `rs0`; write-conflict retries are bounded by the client's `timeoutMS` |
| ids | `generateId: () => crypto.randomUUID()` | stored as plain strings, so `user._id` equals `userId` on every scantor document without conversion. **Fixed before the first user exists; ids cannot be migrated later.** |
| writes | only through `auth.api.*`, `ctx.internalAdapter`, `ctx.adapter` | scantor reads `user` and `apikey` directly only for listings |

Raw database helpers used by scantor are all written on the adapter, never on collections:

| Helper | Implementation |
|---|---|
| any user exists | `(await ctx.internalAdapter.countTotalUsers()) > 0` |
| credential summary | `hasPassword = (await ctx.internalAdapter.findAccounts(userId)).some(a => a.providerId === 'credential' && a.password)`; `passkeyCount = await ctx.adapter.count({ model: 'passkey', where: [{ field: 'userId', value: userId }] })` |
| remove password | `ctx.adapter.deleteMany({ model: 'account', where: [{ field: 'userId', value: userId }, { field: 'providerId', value: 'credential' }] })` |
| set password | `ctx.password.hash` then `ctx.internalAdapter.updatePassword`, or `createAccount({ providerId: 'credential', accountId: userId, password })` when none exists |
| OAuth apps | `ctx.adapter.findMany/deleteMany` on `oauthConsent`, `oauthAccessToken`, `oauthRefreshToken`, names from `oauthClient` |

### 2.4 Plugins

| Plugin | Purpose in scantor | Configuration notes |
|---|---|---|
| `authHttpAllowlist()` (scantor, `server/utils/auth-policy.ts`) | the HTTP allowlist of §2.5 | listed first, so its `onRequest` runs before every other plugin's and before routing |
| `admin()` | roles `admin`/`user`, `banned`, `banReason`, `banExpires` on `user`; banned users cannot create sessions | no `/admin/*` HTTP endpoint is reachable (§2.5). Users are managed through scantor's `/api/users` routes, which call the adapter. Impersonation is unavailable. |
| `apiKey()` (`@better-auth/api-key`) | user API keys for the CLI, MCP clients and the editor | two configurations, `default` and `editor` (§8.1). Per-key rate limiting is **off** (its default of 10 requests/day breaks the CLI). `enableSessionForAPIKeys: true`, so `auth.api.getSession` resolves a key to its user. |
| `passkey()` | WebAuthn sign-in and passkey-first first admin | registered only when passkeys are enabled (§4.4); `requireSession: false` so the setup flow can register without a session, with the freshness guard of §6.4 |
| `jwt()` | signing keys (`jwks` collection) for OAuth access tokens | registered only with MCP; its `/token` endpoint is not reachable (§2.5) |
| `mcp()` | OAuth 2.1 authorization server for MCP clients (wraps `@better-auth/oauth-provider`) | registered only when MCP is enabled ([mcp](mcp.md) §3.8); DCR open but redirect URIs restricted ([mcp](mcp.md) §3.4) |
| `cimd()` | Client ID Metadata Documents (MCP 2026-07-28 client identification) | SSRF-hardened fetcher from `@better-auth/cimd/node`; https metadata URLs only |

Client plugins in the SPA (`app/composables/useAuth.ts`): `adminClient()`, `passkeyClient()`,
`oauthProviderClient()` (forwards the signed OAuth query on `/login` and `/oauth/consent`).

### 2.5 HTTP allowlist

better-auth and its plugins register many more HTTP endpoints than scantor uses, and every plugin upgrade can add
more. Over HTTP they are therefore **denied by default**: the scantor plugin `authHttpAllowlist()`
(`orchestrator/server/utils/auth-policy.ts`, listed first in `plugins`) answers 404 `notFound` (JSON envelope,
`Cache-Control: no-store`) to every request whose method and path are not on the allowlist. Its `onRequest` runs
inside `useAuth().handler` before every other plugin and before routing, for both HTTP entries into better-auth (the
`/api/auth/*` catch-all and the root `.well-known` route), on the URL better-auth itself routes (dot segments
resolved). The match is exact: other methods, trailing slashes, percent-encodings and case variants are denied.
The root `.well-known` route forwards only the three root discovery documents listed below (GET, HEAD), judged on
that routed URL, and answers 404 for everything else, so no path below `/api/auth` is reachable through it. A raw
path whose routed form differs never gets that far: `01.path` refuses it first (§5.5).
Server-side `auth.api.*` calls never pass through it, so scantor's own routes keep calling any endpoint.

`isAuthHttpEndpoint(method, path)` allows exactly the endpoints of [api](api.md) §3:

| Paths below `/api/auth` | Methods | Used by |
|---|---|---|
| `/sign-in/email`, `/sign-out` | POST | UI sign-in and sign-out |
| `/get-session` | GET, POST | UI session (better-auth's session atom refreshes with POST) |
| `/update-user`, `/change-password`, `/change-email`, `/revoke-session`, `/revoke-sessions` | POST | account page |
| `/list-sessions` | GET | account page |
| `/passkey/generate-register-options`, `/passkey/generate-authenticate-options`, `/passkey/list-user-passkeys` | GET | passkeys |
| `/passkey/verify-registration`, `/passkey/verify-authentication`, `/passkey/update-passkey`, `/passkey/delete-passkey` | POST | passkeys |
| `/oauth2/authorize`, `/oauth2/userinfo`, `/oauth2/public-client`, `/oauth2/end-session`, `/jwks` | GET | MCP OAuth |
| `/oauth2/token`, `/oauth2/register`, `/oauth2/consent`, `/oauth2/continue`, `/oauth2/public-client-prelogin`, `/oauth2/revoke`, `/oauth2/introspect` | POST | MCP OAuth |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | GET, HEAD | issuer-relative discovery |
| `/error` | GET | the page a failed OAuth authorization redirects to |

At the origin root only `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/api/auth`
and `/.well-known/openid-configuration/api/auth` (GET, HEAD) pass. Passkey and OAuth endpoints exist only while
passkeys (§4.4) and MCP OAuth ([mcp](mcp.md) §3.8) are enabled; otherwise better-auth itself answers 404.

Everything else is unreachable, among others: `/sign-up/email` (users are created by admins or the setup flow),
`/token` (tokens are issued only through `/oauth2/token`), `/api-key/*` (managed through `/api/account/api-keys`,
§8.2), `/admin/*` and `/admin/oauth2/*` (users are managed through `/api/users`, §6.3), `/delete-user*` (deletion runs
the `userPurge` job), password reset and email verification (no email delivery in v1), social sign-in, account
linking and `/callback/*` (no social providers), `/list-accounts`, `/update-session`, `/revoke-other-sessions`,
`/verify-password`, `/ok`, and OAuth client and consent management (`/oauth2/get-client*`, `/oauth2/create-client`,
`/oauth2/update-client`, `/oauth2/delete-client`, `/oauth2/client/*`, `/oauth2/*-consent*`,
`/oauth2/end-session/confirm`; OAuth apps are managed through `/api/account/oauth-apps`). To expose another
endpoint, add it to the allowlist and to [api](api.md) §3 together.

`tests/security/auth-endpoints.spec.ts` asserts that these endpoints answer 404 with a session and that the documented
ones keep working; `orchestrator/test/utils/auth-policy.test.ts` covers the matcher and the plugin on a real
better-auth instance.

### 2.6 Sessions and cookies

| Item | Value |
|---|---|
| session cookie | `scantor.session_token`; on https better-auth names it `__Secure-scantor.session_token`. Host-only (no `Domain`), `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` on https. Never sent to the editor, S3, registry or admin-tool hosts. |
| lifetime | 7 days, extended once a day on use (`updateAge`) |
| fresh age | 24 h (passkey registration without a setup context requires a fresh session, §6.4) |
| cookie cache | disabled: every request reads the session and user, so sign-out, revocation and bans apply immediately |
| storage | better-auth `session` collection (indexed by the adapter) |
| sign-out | `POST /api/auth/sign-out`; the after-hook also clears `scantor_tools` (§11) |

### 2.7 Rate limiting

better-auth's limiter applies only to `/api/auth/*`. Storage is `memory` (single orchestrator). Keys are
`<client IP>|<path>` with the client IP from §4.3.

```ts
const RATE_LIMIT = {
  enabled: true,                      // also in development and tests
  storage: 'memory',
  window: 60, max: 300,               // default per IP and path
  customRules: {
    '/sign-in/email':                 { window: 60, max: 10 },
    '/passkey/verify-authentication': { window: 60, max: 20 },
    '/change-password':               { window: 60, max: 5 },
    '/change-email':                  { window: 60, max: 5 },
    '/oauth2/register':               { window: 60, max: 10 },
  },
}
```

The OAuth provider's built-in per-endpoint limits (token, authorize, introspect, revoke) stay at their
defaults. API keys have no per-key limit; the scantor API protects itself with concurrency caps
(`SCANTOR_MAX_CONCURRENT_WAITS`, `SCANTOR_USER_MAX_CONCURRENT_QUERIES`) and body caps. Exceeding a limit
returns better-auth's 429 response. The whole test suite reaches the stack from one client IP, so it budgets
sign-ins and OAuth registrations across all workers through a shared limiter ([testing](testing.md) §7.8,
§9).

### 2.8 Hooks

`beforeHook(ctx)`:

| Path | Action |
|---|---|
| `/oauth2/register` | reject (400 `invalid_redirect_uri`, OAuth error format) when any `redirect_uris` entry fails `isAllowedMcpRedirect` ([mcp](mcp.md) §3.4) |
| `/oauth2/consent` | when `accept` is true, require `scope` in the body (400 `invalid_request` otherwise) and remove `scantor:admin` from it when the session user's role is not `admin` |

`afterHook(ctx)`:

| Path | Action |
|---|---|
| `/sign-out` | append `Set-Cookie: scantor_tools=; Domain=<SCANTOR_DOMAIN>; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` when `SCANTOR_DOMAIN` is set |
| `/change-password`, `/revoke-sessions` | invalidate the user cache entry (§5.7) |

## 3. Secrets and key derivation

All internal keys derive from `SCANTOR_SECRET` with the function fixed in [architecture](architecture.md) §9:

```
key(label) = HKDF-SHA256(ikm = UTF-8(SCANTOR_SECRET), salt = UTF-8("scantor-v1"), info = UTF-8(label), L = 32)
```

| Label | Consumer | Encoding |
|---|---|---|
| `better-auth` | better-auth `secret` (cookie signing, encryption of `jwks` private keys and OAuth secrets) | lowercase hex (64 chars) |
| `worker-token` | worker token MAC (§10.2) | raw key for HMAC-SHA256 |
| `amqp` | per-scan RabbitMQ password (§10.3) | raw key for HMAC-SHA256 |
| `builtin-node` | built-in node token (§10.1) | `snt_` + base64url(key) |
| `registry-signing` | registry token ES256 key (§10.4) | P-256 private scalar `d = (k mod (n − 1)) + 1`, `k` = the key read big-endian, `n` = the order of P-256 ([architecture](architecture.md) §9) |
| `registry-push` | password of the registry `orchestrator` credential (§10.4) | base64url(key) |
| `registry-http` | the registry's `REGISTRY_HTTP_SECRET`, written to `scantor-registry-auth/http-secret` at boot ([deployment](deployment.md) §8.1) | lowercase hex |
| `tools-cookie` | HS256 key of `scantor_tools` (§11) | raw key |
| `editor-cookie` | HMAC key of `scantor_editor` (§12) | raw key |
| `credentials`, `config-secrets` | AES-256-GCM of git credentials and `writeOnly` config values ([data model](data-model.md) §1) | raw key |
| `mongo-query` | password of the read-only MongoDB user `scantor_query` | base64url(key) |

Implementations: `orchestrator/server/utils/keys.ts` (`deriveKey(label): Buffer`, `deriveKeyHex`,
`deriveKeyB64url`) and Go `internal/keys`. Both are tested against the shared vectors in
`tests/corpora/keys-vectors.json` (Go reads the file by relative path, [testing](testing.md) §4.1): an
`hkdf` array of `{secret, label, hex}` triples for every label and several secrets (including non-ASCII
ones), one section per derived credential format (better-auth secret, registry push password and HTTP
secret, `mongo-query` password, built-in node token and node token hash, worker token, AMQP password,
editor cookie, tools-cookie signature, registry signing key with `d`, `x`, `y` and `kid`), and
AES-256-GCM `enc:v1` vectors. `go test ./internal/keys -run TestVectors -update` regenerates it. Keys
are derived once at boot and kept in memory; they are never logged.

Rotation: changing `SCANTOR_SECRET` invalidates every session, every OAuth access token (the `jwks` private keys
can no longer be decrypted, so better-auth must generate new ones and clients re-authorise), every worker
token and AMQP password, the registry signing key and HTTP secret, the tools and editor cookies, the built-in node token, and
every encrypted git credential and config secret. API keys and node tokens are stored as hashes and survive. It
is a disaster-recovery procedure ([security](security.md) §10).

## 4. Public URL, origins and proxies

### 4.1 `SCANTOR_PUBLIC_URL`

`SCANTOR_PUBLIC_URL` is the single canonical dashboard URL. It is parsed once at boot; an invalid URL, a path
other than `/`, a query or credentials abort startup. It is used as:

| Use | Value |
|---|---|
| better-auth `baseURL` | `SCANTOR_PUBLIC_URL` |
| OAuth issuer | `${SCANTOR_PUBLIC_URL}/api/auth` |
| MCP protected resource | `${SCANTOR_PUBLIC_URL}/mcp` |
| trusted origin, CSRF origin | `origin(SCANTOR_PUBLIC_URL)` |
| passkey origin and default rpID | origin and hostname of `SCANTOR_PUBLIC_URL` |
| registry token realm | `${SCANTOR_PUBLIC_URL}/api/registry/token` |
| links in logs and responses | setup link, node join commands, `getInstanceInfo` |

No absolute URL is ever derived from `Host`, `X-Forwarded-Host` or `X-Forwarded-Proto`. `Host` is used only
for the 421 checks of the two listeners: the dashboard listener rejects the host of `SCANTOR_EDITOR_URL`,
and the editor listener accepts only that host ([editor](editor.md) §8.1).

### 4.2 Trusted origins and CSRF

`trustedOrigins(cfg)` returns exactly:

- `origin(SCANTOR_PUBLIC_URL)`;
- when that host is `localhost`: also `http(s)://127.0.0.1:<port>` and `http(s)://[::1]:<port>` with the same
  scheme and port (local development convenience; passkeys work only on `localhost` itself).

The editor origin (`SCANTOR_EDITOR_URL`) is **never** trusted: workspace-controlled JavaScript runs there
([editor](editor.md)).

CSRF rules:

1. better-auth's own origin check and Fetch-Metadata checks protect `/api/auth/*`.
2. The global middleware requires, for every cookie-authenticated request with method `POST`, `PUT`,
   `PATCH` or `DELETE`, an `Origin` header equal to a trusted origin; a missing or different `Origin` is
   403 `forbidden`. API keys, MCP capabilities and machine tokens are not ambient credentials and are exempt.
3. No route under the dashboard host sends `Access-Control-Allow-Origin` with credentials. The only
   CORS-enabled routes are credential-less: `/.well-known/*`, `/api/auth/jwks`, `/api/auth/oauth2/token`,
   `/api/auth/oauth2/register` and `/mcp` (`Access-Control-Allow-Origin: *`, no `Allow-Credentials`; allowed
   headers `authorization, content-type, mcp-protocol-version, mcp-session-id, x-api-key`).
4. GET routes have no side effects beyond these documented exceptions. `createToolsSession` sets the
   caller's own tools cookie and redirects. `getWorkerLogs` asks the node for a log tail.

### 4.3 Client IP and `SCANTOR_TRUST_PROXY`

better-auth reads the client IP only from request headers, and by default from `x-forwarded-for`, which any
client can set. Scantor therefore always computes the client IP itself and hands it to better-auth through a
header that clients cannot inject:

1. Middleware `00.request` deletes any incoming `x-scantor-client-ip` header.
2. If `SCANTOR_TRUST_PROXY=true`, the client IP is the **rightmost** entry of `X-Forwarded-For`, which is
   the address the trusted proxy saw. If the header is absent, the socket peer address is used.
   Otherwise the client IP is the socket peer address.
3. It sets `x-scantor-client-ip` to that address. better-auth uses
   `advanced.ipAddress.ipAddressHeaders: ['x-scantor-client-ip']` for rate limiting and `session.ipAddress`,
   and scantor uses the same value in logs and its own limits.

`SCANTOR_TRUST_PROXY=true` is correct only when every request reaches the orchestrator through Traefik (the
`traefik` profile). Traefik's entrypoints do not trust incoming forwarded headers, so they overwrite
`X-Forwarded-For` with the real peer. The orchestrator port stays bound to `SCANTOR_BIND_ADDRESS`. Requests
that reach it directly (from that address, normally loopback) could then spoof their IP. This only affects rate-limit
fairness and is accepted. The orchestrator logs a warning at boot when `SCANTOR_TRUST_PROXY=true` and
`COMPOSE_PROFILES` does not contain `traefik`.

### 4.4 Passkeys

WebAuthn needs a secure context and an RP ID that is a domain (never an IP literal). `resolvePasskeyConfig`:

| `SCANTOR_PUBLIC_URL` | Passkeys | rpID | origin |
|---|---|---|---|
| `https://<domain name>[:port]` | enabled | `SCANTOR_PASSKEY_RP_ID` or the hostname | the public origin |
| `http://localhost[:port]` or `http://<name>.localhost[:port]` | enabled | `SCANTOR_PASSKEY_RP_ID` or the hostname | the public origin |
| `http://` any other host, or any IP-literal host (`127.0.0.1`, `[::1]`, `10.0.0.5`) | disabled | – | – |

`SCANTOR_PASSKEY_RP_ID`, when set, must equal the hostname or be a registrable suffix of it; otherwise startup
aborts. Changing the rpID or the hostname later makes existing passkeys unusable (users then sign in with a
password, or an admin sets one). When passkeys are disabled, the passkey plugin is not registered,
`getSetupStatus.passkeysEnabled` and `getInstanceInfo.features.passkeys` are `false`, the UI hides passkey
controls, and `createSetupPasskeyToken` returns 400 `passkeysDisabled`.

## 5. Principals and the global middleware

### 5.1 Principal type

`orchestrator/server/utils/principal.ts`:

```ts
type UserRef = { id: string; email: string; name: string; role: 'admin' | 'user' }

type UserPrincipal = {
  kind: 'user'
  via: 'session' | 'apiKey' | 'mcp'
  user: UserRef
  isAdmin: boolean                       // effective admin power, §5.6
  sessionId?: string                     // via session
  apiKey?: { id: string; configId: 'default' | 'editor' }   // via apiKey (also inside mcp via API key)
  mcp?: { clientId: string | null; level: 'read' | 'write' | 'admin'; operationId: string }   // via mcp
}
type NodePrincipal = { kind: 'node'; node: { id: string; name: string; builtIn: boolean; endpointProfile: 'internal' | 'public'; pool: string } }
type WorkerPrincipal = { kind: 'worker'; worker: { id: string; scanId: string; userId: string; role: 'scheduler' | 'runner'; nodeId: string; epoch: number } }
type RegistryPrincipal = { kind: 'registry'; subject: 'orchestrator' }   // token route only; nodes use NodePrincipal
type ToolsPrincipal = { kind: 'tools'; user: UserRef }
type SetupPrincipal = { kind: 'setup' }
type Principal = UserPrincipal | NodePrincipal | WorkerPrincipal | RegistryPrincipal | ToolsPrincipal | SetupPrincipal
```

The middleware stores it as `event.context.principal`; nothing else in `event.context` carries identity.

### 5.2 Credential recognition

| Credential | Exact recognition | Validation | Failure |
|---|---|---|---|
| internal capability | header `x-scantor-internal-auth` matching `^sic_[A-Za-z0-9_-]{43}$` | the request arrived on a connection of this process's loopback listener (`isLoopbackListenerSocket`), never on the dashboard listener, and its TCP peer address is loopback (`127.0.0.1`, `::1`); entry exists in the in-memory map and is unexpired (60 s); request method and pathname equal the values bound at mint time; entry deleted on first use (single use), whatever the outcome. The user is re-read through the user cache. | 401 `unauthorized` |
| API key | header `x-api-key`, or `Authorization: Bearer` whose value starts with `sk_scantor_` | `auth.api.getSession({ headers: new Headers({ 'x-api-key': key }) })`. The api-key plugin hook hashes the key (SHA-256, base64url), looks it up, and checks `enabled` and `expiresAt` (expired keys are deleted). The returned session carries the fresh user. `configId` = `editor` iff the key matches `^sk_scantor_editor_[A-Za-z]{64}$`, else `default`. | 401 `unauthorized` (never falls back to the cookie) |
| session cookie | better-auth session cookie present | `auth.api.getSession({ headers: new Headers({ cookie }) })`: DB lookup of session and user | 401 `unauthorized` |
| node token | `Authorization: Bearer snt_…` (or Basic `node:snt_…` on the token route) | §10.1 | 401 `unauthorized` |
| worker token | `Authorization: Bearer swt_…` | §10.2 | 401 `unauthorized` |
| registry credential | Basic `orchestrator:<password>` on `/api/registry/token` | constant-time compare with base64url(key(`registry-push`)) | 401 (registry error format) |
| tools cookie | cookie `scantor_tools` on `/api/tools/forward-auth` (parsed by the route) | §11 | 302 to `createToolsSession` for browsers, else 401 with a short `text/plain` body (§11) |
| setup token | header `X-Scantor-Setup-Token` | §7.2 | 401 `setupTokenInvalid` / 409 `setupCompleted` |

Both better-auth lookups go through `server/utils/credential-lookup.ts`, which `/mcp` shares (§13). Only a
credential that better-auth rejects (no session, an unknown, expired or disabled key: a 4xx `APIError`) is 401. A
lookup that fails (a 5xx `APIError`, which is how better-auth wraps database errors, or any other error) is logged
and answered with 503 `unavailable`, so a MongoDB election or timeout never signs browsers out or makes clients
treat a valid key as revoked.

Precedence on user routes: internal capability, then API key, then session cookie. When an explicit
credential (capability or API key) is present, it alone decides; the cookie is ignored and CSRF does not
apply. MCP OAuth access tokens (`Authorization: Bearer eyJ…`) are not accepted on `/api/*`: they are
audience-bound to `/mcp`, so a bearer value that is not `sk_scantor_…` on a user route is 401.

API keys on `/api/auth/*`: the middleware rejects any request to `/api/auth/*` that carries `x-api-key` or a
`Bearer sk_scantor_…` value with 401 `unauthorized` (scantor envelope). Otherwise the api-key plugin would
turn the key into a session for better-auth's own endpoints. A stolen CLI key could then register a passkey,
change the email or approve OAuth consents, which amounts to account takeover. The rule holds for the raw path and
for the path better-auth routes (dot segments resolved), and `01.path` already refuses every path whose two forms
differ (§5.5), so no other spelling such as `/.well-known/x/../../api/auth/…` carries a key into better-auth.

### 5.3 Route prefixes

Prefixes are bound to principal kinds ([api](api.md) §1.2). On a prefix, only the bound credential kind is
parsed. Credentials of another kind are ignored, so a missing credential and a wrong-kind credential both give
401.

| Prefix | Parsed credential kinds |
|---|---|
| `/api/node/*` | node token (Bearer) |
| `/api/runtime/*` | worker token |
| `/api/registry/token` | Basic `node:` / `orchestrator:` (handled by the route itself, registry error format) |
| `/api/setup/*` | setup token (`GET /api/setup/status` is public) |
| `/api/tools/forward-auth` | tools cookie (handled by the route itself, §11) |
| `/api/health`, `/api/docs`, `/api/docs/openapi.json` | none (public; credentials are not validated) |
| `/api/auth/*` | none by the middleware (better-auth's own handling, limited to the HTTP allowlist of §2.5); API-key headers rejected (§5.2) |
| every other `/api/*` | internal capability, API key, session cookie |
| `/mcp` | not handled by the middleware; `/mcp` authenticates itself ([mcp](mcp.md) §3) |
| editor origin (`Host` = host of `SCANTOR_EDITOR_URL`) | never reaches this middleware: the dashboard listener answers 421 for the editor host, and the dedicated editor listener (container port 3001) checks `scantor_editor` itself (§12) |

### 5.4 Operation registry and scope enforcement

`orchestrator/server/utils/operations.ts` builds an **operation registry** once (a promise shared by
concurrent callers); the last foundation boot step builds it, so it exists before `/api/*` leaves the
boot-time 503 ([architecture](architecture.md) §4.1). It reads the runtime OpenAPI document in-process with
`useNitroApp().localFetch('/api/docs/openapi.json')`, the same document the MCP bridge uses. Each entry
holds `{method, pathTemplate, segments, operationId, scope, adminOnly, readOnly, sessionOnly, destructive}`
from the extensions `x-scantor-scope`, `x-admin-only`, `x-read-only`, `x-session-only` and `x-destructive`
([api](api.md) §1.1).

Matching: the request pathname is split into segments and compared with each template. As in Nitro's
router, one trailing slash is ignored, while an empty interior segment is kept and matches nothing (so
`/api//users` is 404, never `/api/users`). A static segment must match exactly, and `{param}` matches one
non-empty segment. If several templates match, the one with a static segment at the first position where
they differ wins, which is the precedence of Nitro's router (rou3).

| Situation | Result |
|---|---|
| `/api/*` path (not in the public/better-auth allowlist) matches no template | 404 `notFound`, **deny by default**: a route without OpenAPI metadata is unreachable |
| template matches, method does not | 405 `methodNotAllowed` |
| principal kind not accepted by `x-scantor-scope` (table below) | 401 `unauthorized` (kind mismatch on a prefix) or 403 `forbidden` (internal inconsistency, logged as error) |
| scope `admin` and `principal.isAdmin` false | 403 `adminRequired` |
| `x-session-only` and `via ≠ session` | 403 `sessionRequired` |
| `via = mcp`: GET or `x-read-only` needs level ≥ read, other methods level ≥ write, `x-admin-only` needs level `admin` | 403 `forbidden` |

| `x-scantor-scope` | Accepted principals |
|---|---|
| `public` | any (credentials not validated) |
| `owner` | `user` |
| `admin` | `user` with `isAdmin` |
| `node` | `node`; on `/api/registry/token` also `registry` |
| `worker` | `worker` |
| `setup` | `setup` |
| `tools` | `tools` |

At boot, a consistency check verifies that every operation's scope agrees with its prefix (`node` ⇔
`/api/node/*` or `/api/registry/token`, `worker` ⇔ `/api/runtime/*`, `setup` ⇔ `/api/setup/*` except the
public status, `tools` ⇔ `/api/tools/forward-auth`, `owner`/`admin` elsewhere). A mismatch is logged as an
error and the operation then always answers 403. `tests/authz/openapi-lint.spec.ts` fails on the same
condition ([testing](testing.md) §8.5). Route handlers still call the typed helpers of §9, which assert the principal kind
again (defence in depth). The central check is what the authorization matrix relies on.

### 5.5 Middleware algorithm

`orchestrator/server/middleware/01.path.ts` runs first, for every request: the raw path (without the query) must
equal the pathname a WHATWG URL parser makes of it, which is what h3's `getRequestURL` and so better-auth route.
Dot segments (also percent-encoded, `%2e`), backslashes, repeated leading slashes and characters the parser would
percent-encode are 400 `badRequest`. Nitro's router and the middleware match the raw path, so without this rule a
path such as `/.well-known/x/../../api/auth/passkey/generate-register-options` would reach a route outside `/api/auth`
while better-auth runs the passkey endpoint, past every check keyed on `/api/auth/*`.

`orchestrator/server/middleware/10.auth.ts`, for requests on the dashboard listener whose path starts with
`/api/`:

1. If the path is `/api/auth/*`: reject API-key credentials (§5.2), then pass to better-auth.
2. If the path is public (`/api/health`, `/api/docs`, `/api/docs/openapi.json`, `GET /api/setup/status`): set
   `principal = null` and continue.
3. Classify the prefix (§5.3) and parse only the bound credential kind. No credential, or an invalid one,
   gives 401 `unauthorized`. `/api/setup/*` follows §7.2 instead. On `/api/registry/token` and
   `/api/tools/forward-auth` the middleware only resolves the operation (step 4). These routes parse their
   credential themselves (Basic credentials, the `scantor_tools` cookie), enforce their scope and answer as
   §10.4 and §11 specify.
4. Look up the operation (§5.4): 404, 405 or 403 as listed.
5. For `user` principals: if the user is banned (`banned === true` and
   `banExpires == null || banExpires > now`), return 403 `banned`. The tools route checks bans itself (§11).
6. CSRF (§4.2) for `via = session` and unsafe methods.
7. Set `event.context.principal`, `event.context.operation`, and add `X-Request-Id` to the log context.
   Response headers for `/api/*` include `Cache-Control: no-store`.

Every rejection uses the error envelope of [api](api.md) §1.7, except on `/api/registry/token` (registry
format) and `/api/tools/forward-auth` (302 for browser navigations, otherwise 401 with a short `text/plain`
body, §11). The rejection
is logged at `info` with the request id, principal kind, operation id and code; credentials are never logged.

### 5.6 Effective role

`isAdmin` is the user's admin power **for this request**:

```
isAdmin = user.role === 'admin'
          && !(via === 'apiKey' && apiKey.configId === 'editor')
          && !(via === 'mcp' && mcp.level !== 'admin')
```

- The `editor` API key never carries admin power. It lives inside a container that runs workspace code, which
  may come from untrusted git repositories. An admin's editor key therefore acts as a plain user: no admin
  routes, no ownership bypass.
- MCP sessions get admin power only with the OAuth scope `scantor:admin` (or with a `default` API key of an
  admin, [mcp](mcp.md) §3.7).
- Sessions and `default` API keys of admins carry full admin power.

### 5.7 User cache and bans

`orchestrator/server/utils/user-cache.ts` caches `{id, email, name, role, banned, banExpires,
canRunPrivileged, maxWorkers}` per user id for at most 30 s. It is used by the internal capability, tools and
editor cookie paths, by placement (`maxWorkers`) and by the MCP endpoint. Sessions and API keys read the user
fresh through `getSession`. Every user mutation done by scantor (`updateUser`, `banUser`, `unbanUser`,
`setUserPassword`, `deleteUser`) invalidates the entry in-process. The upper bound for any role or ban change
to take effect on any user principal is therefore 30 s.

Effects of `banUser` (`POST /api/users/{userId}/ban`), all done by `server/utils/users.ts` in this order:

1. `ctx.internalAdapter.updateUser(userId, { banned: true, banReason, banExpires: null })`, invalidate the cache;
2. delete all sessions (`ctx.internalAdapter.deleteSessions(userId)`);
3. delete all API keys of both configurations (`ctx.adapter.deleteMany({ model: 'apikey', where: referenceId = userId })`);
4. delete OAuth access tokens, refresh tokens and consents of the user (MCP clients are cut off at once);
5. stop the user's editor (which deletes its `editor` key) ([editor](editor.md));
6. if `cancelScans: true`, cancel every non-terminal scan of the user (the UI pre-checks this option).

Steps 5 and 6 are lockout hooks that domain plugins register (`registerUserLockoutHook`, orders 50 and 60). Every
hook runs, also when an earlier one failed. A failed hook makes `banUser` answer 500 after all of them ran; the ban
itself and steps 1–4 are in place, and repeating the ban runs the hooks again. `deleteUser` runs steps 1–5 with
`banReason: "deleted"`; a failed hook there is logged and does not stop the deletion, because the `userPurge` job's
steps 10 and 20 cancel the scans and stop the editor again ([data model](data-model.md) §5).

A banned user is rejected on every **user principal** (session, API key, MCP over OAuth or API key, tools
cookie, editor cookie). Worker tokens are not user principals: the scans of a banned user keep running unless
`cancelScans` was chosen. `unbanUser` only clears the flag; keys, sessions and OAuth grants stay deleted.

## 6. Users and roles

### 6.1 Roles

| Capability | `user` | `admin` (effective, §5.6) |
|---|---|---|
| own tasks, revisions, test runs, scans, analyses, files, uploads, exports, credentials, API keys, editor | yes | yes |
| read and act on other users' resources (by id; lists with `userId` filter) | no (404) | yes |
| `/api/users/*`, `/api/nodes/*`, `/api/metrics`, `createToolsSession` | no (403 `adminRequired`) | yes |
| open another user's editor | no | no (editor routes always act on the caller) |

A non-admin passing a `userId` query parameter other than their own on a list operation gets 403
`adminRequired`. Admins cannot demote, ban, delete or set the password of themselves through `/api/users`
(400 `badRequest`), so at least one admin always remains.

### 6.2 `canRunPrivileged` and `maxWorkers`

Both are better-auth additional fields declared with `input: false`, so better-auth's own `update-user`
endpoint cannot set them. Only `createUser` and `updateUser` (admin) write them through `ctx.internalAdapter`.

| Field | Default at creation | Enforced at |
|---|---|---|
| `canRunPrivileged` (boolean) | `false` | `publishRevision` / `uploadTask` (check-static rejects a privileged manifest: revision `failed`, `errors[{phase: "static", message: "privileged tasks require canRunPrivileged"}]`), `startScan`, `restartScan`, `resumeScan`, `retryFailedAnalyses` (403 `privilegedNotAllowed` for privileged revisions). Test runs, describe and check never run privileged. Revoking the flag does not stop running workers; admins cancel those scans explicitly. |
| `maxWorkers` (integer ≥ 0, `0` = unlimited) | `SCANTOR_USER_MAX_WORKERS` read at creation time (later changes of the variable do not touch existing users) | placement: a user's active workers across all scans never exceed it; unplaceable workers stay `pending` with reason `userMaxWorkers` ([nodes](nodes.md)) |

### 6.3 User management

`orchestrator/server/utils/users.ts` wraps better-auth for the `/api/users` and `/api/account` routes:

| Operation | Implementation |
|---|---|
| `createUser` | normalise the email (lowercase), check length bounds, then `auth.api.createUser({ body: { email, name, password?, role, data: { canRunPrivileged, maxWorkers } } })` **without headers**. The admin plugin skips its session check only for server-side calls without headers. 409 `alreadyExists` on a duplicate email. `password` is optional in the API, but a user without one cannot sign in until an admin calls `setUserPassword`, so the UI always asks for an initial password. |
| `updateUser` | `ctx.internalAdapter.updateUser(id, {name?, email?, role?, canRunPrivileged?, maxWorkers?})`; invalidate cache |
| `setUserPassword` | hash with `ctx.password.hash`; `updatePassword` or `createAccount`; revoke the user's sessions |
| `banUser` / `unbanUser` | §5.7 |
| `deleteUser` | immediately apply steps 1–5 of `banUser` with `banReason: "deleted"` (the user is locked out while the purge runs), then create the `userPurge` job, which finally calls `ctx.internalAdapter.deleteUser(id)` ([data model](data-model.md) §5) |
| `getAccount` | user fields plus the credential summary (§2.3) |
| `setAccountPassword` / `removeAccountPassword` | session only; §6.4 |

### 6.4 Credential invariant and the passkey guard

Every user keeps at least one way to sign in. `orchestrator/server/middleware/11.passkey-guard.ts` and the
account routes enforce:

| Request | Rule | Error |
|---|---|---|
| `POST /api/auth/passkey/delete-passkey` | rejected when the user has no password and this is their last passkey | 409 `lastCredential` |
| `DELETE /api/account/password` (`removeAccountPassword`) | rejected when the user has no passkey | 409 `lastCredential` |
| `GET /api/auth/passkey/generate-register-options`, `POST /api/auth/passkey/verify-registration` without a `context` query value | require a session created less than 24 h ago (the passkey plugin's `freshAge` semantics, which `requireSession: false` would otherwise skip) | 403 `sessionRequired` |
| same, with a `context` value | handled by `resolvePasskeySetupUser` (§7.3); an unknown or expired context is 401 | – |

The guard matches the path better-auth routes (dot segments resolved), never the raw request path, so a spelling
such as `/api/auth/passkey/./delete-passkey` cannot skip it; `01.path` refuses such paths anyway (§5.5).

## 7. First admin

Boot step 3 ([architecture](architecture.md) §4.1) runs `ensureFirstAdmin()` (`server/utils/setup.ts`).

```
users exist? ── yes ──► nothing to do (SCANTOR_ADMIN_* ignored, info log)
     │ no
     ▼
SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD both set? ── yes ──► create admin (§7.1)
     │ no (exactly one set → abort startup)
     ▼
generate setup token, log the setup link (§7.2)
```

### 7.1 Environment bootstrap

When no user exists and both `SCANTOR_ADMIN_EMAIL` and `SCANTOR_ADMIN_PASSWORD` are set, the orchestrator calls
`auth.api.createUser({ body: { email, password, name: <local part of the email>, role: 'admin' } })` without
headers. It logs `[setup] created first admin <email>`. The variables have no effect once a user exists:
they never reset passwords. In public mode the startup guard rejects a `SCANTOR_ADMIN_PASSWORD` that is shorter
than 16 characters or ends in `-insecure-dev` ([security](security.md) §6.11). This path is meant for headless
installs and the test stack.

### 7.2 Setup token

- Format `sst_` + base64url(32 random bytes) (43 characters). It is generated at boot only when no user
  exists, kept only in memory, and replaced on every restart.
- Logged at `warn` at boot and again every 10 minutes while no user exists:
  `[setup] no users exist; open <SCANTOR_PUBLIC_URL>/setup?token=<token> to create the first admin`.
  This line is the one deliberate exception to redaction: it is written through a dedicated unredacted
  logger call (`logger.warnUnredacted`). The request logger and every other log line redact the `token`
  query parameter of `/setup` ([security](security.md) MC-10).
- The `/setup` page reads `token` from the URL, keeps it in `sessionStorage`, removes it from the address bar
  with `history.replaceState`, and sends it as `X-Scantor-Setup-Token` on the setup calls.
- Every `/api/setup/*` mutation runs in this order:
  1. if any user exists: 409 `setupCompleted` (the token has already been discarded);
  2. compare `SHA-256(header)` with `SHA-256(token)` using `timingSafeEqual`; a mismatch or a missing header
     gives 401 `setupTokenInvalid`;
  3. run under an in-process mutex, re-check that no user exists (409), then act.
- `createSetupAdmin {email, name, password}` creates the admin as in §7.1, discards the setup token and returns
  201 `User`. The browser then signs in with `POST /api/auth/sign-in/email`.
- `GET /api/setup/status` is public and returns `{needsSetup, passkeysEnabled, mcpUrl}`. The SPA redirects
  every route to `/setup` while `needsSetup` is true.

### 7.3 Passkey-first admin

`createSetupPasskeyToken {email, name}` (setup token required; 400 `passkeysDisabled` when passkeys are off)
returns `{token: "spk_…", expiresIn: 300}`. The `spk_` token is single use, kept in memory with payload
`{email, name, role: 'admin', initialAdmin: true, handle: <random uuid>}` and valid for 5 minutes. The browser
runs `passkeyClient.addPasskey({ name: 'Primary passkey', context: token })` and verifies with
`createSession: true`.

The user is created only **after** a successful WebAuthn ceremony. An aborted ceremony therefore never leaves
an admin without credentials behind, which would otherwise end setup and lock everyone out.

1. `resolvePasskeySetupUser({ context })` runs at `generate-register-options`. It checks that the `spk_` token
   exists and is unexpired without consuming it (401 otherwise), and that no user exists (409
   `setupCompleted`). It returns the provisional WebAuthn user `{ id: handle, name: email, displayName: name }`.
2. `completePasskeySetupUser({ context })` runs inside `verify-registration` after the attestation is verified.
   It consumes the `spk_` token, re-checks under the setup mutex that no user exists (409), creates the user
   with `ctx.context.internalAdapter.createUser({ email, name, emailVerified: false, role: 'admin',
   canRunPrivileged: false, maxWorkers: cfg.userMaxWorkers })` (the creation default of §6.2, as on every
   other creation path), discards the setup token, and returns `{ userId: user.id }`.
   The passkey is stored for that user, and `createSession: true` signs the browser in immediately.

The WebAuthn user handle stored in the authenticator is the provisional `handle`, not the user id. This is
harmless because better-auth finds passkeys by `credentialID` at sign-in. The user has no password, which
satisfies the credential invariant because a passkey exists.

## 8. API keys

### 8.1 Configurations

`apiKey([DEFAULT_KEY_CONFIG, EDITOR_KEY_CONFIG])`. With `enableSessionForAPIKeys`, the plugin uses the
**first** configuration whose getter returns a key, and then rejects keys whose stored `configId` differs.
The two configurations therefore use disjoint prefixes and getters that match only their own prefix.

| Setting | `default` (CLI, MCP clients, scripts) | `editor` (per-user editor container) |
|---|---|---|
| `configId` | `default` | `editor` |
| `defaultPrefix` | `sk_scantor_` | `sk_scantor_editor_` |
| key format | `sk_scantor_` + 64 letters `[A-Za-z]` | `sk_scantor_editor_` + 64 letters |
| `customAPIKeyGetter` | value of `x-api-key` or of `Authorization: Bearer`, if it matches `^sk_scantor_[A-Za-z]{64}$` | same headers, `^sk_scantor_editor_[A-Za-z]{64}$` |
| `enableSessionForAPIKeys` | `true` | `true` |
| `rateLimit` | `{ enabled: false }` | `{ enabled: false }` |
| `keyExpiration` | `{ defaultExpiresIn: 7_776_000, minExpiresIn: 1, maxExpiresIn: 365 }` (90 days) | `{ defaultExpiresIn: <SCANTOR_EDITOR_API_KEY_TTL in seconds>, disableCustomExpiresTime: true }` |
| `startingCharactersConfig` | `{ shouldStore: true, charactersLength: 15 }` (`sk_scantor_` + 4) | `{ shouldStore: true, charactersLength: 22 }` |
| `requireName`, `maximumNameLength` | `true`, 32 | `true`, 32 (name `editor`) |
| `enableMetadata` | `false` | `false` |
| storage | database (`apikey`, `key` = base64url SHA-256), `referenceId` = user id | same |

`keyExpiration.defaultExpiresIn` is interpreted in **seconds** by `@better-auth/api-key@1.7.12`
(`getDate(value, "sec")`), although its type comment says milliseconds. A unit test pins this: a newly
created default key expires 90 days ± 1 minute after creation.

Keys are created only server-side: `auth.api.createApiKey({ body: { userId, name, expiresIn?, configId } })`
without headers (`expiresIn` in seconds, from `expiresInDays × 86400`). Editor keys are created without
`expiresIn`, so the configured `SCANTOR_EDITOR_API_KEY_TTL` applies. The plain key appears only in that
response. Listing and deletion go through `ctx.adapter` on `apikey` filtered by `referenceId` (and
`configId`). A user can only ever see or delete their own keys.

### 8.2 "CLI & MCP access" page

The account page section "CLI & MCP access" (`/account/access`, [ui](ui.md)):

1. **API keys**: the list (`listApiKeys`) shows name, `start`, configuration, created, expires and last used,
   with a delete button. Create (`createApiKey`, session only) asks for a name (1–32 characters) and an
   expiry (1–365 days, default 90) and shows the key once, together with copyable snippets:

   ```sh
   export SCANTOR_URL=https://scantor.example.com
   export SCANTOR_TOKEN=sk_scantor_…
   ```

   ```sh
   claude mcp add --transport http scantor https://scantor.example.com/mcp --header "Authorization: Bearer sk_scantor_…"
   ```

2. **MCP over OAuth**: the MCP URL (`<SCANTOR_PUBLIC_URL>/mcp`) and `claude mcp add --transport http scantor
   <SCANTOR_PUBLIC_URL>/mcp`. Below it, the authorised OAuth applications (`listOAuthApps`) with client
   name, client id or metadata host, granted scopes, date, and a two-step revoke (`revokeOAuthApp`).
3. A pointer to the CLI docker shim (`scantor.sh`) and the release binaries.

The CLI takes credentials only from `SCANTOR_URL` and `SCANTOR_TOKEN` and sends
`Authorization: Bearer $SCANTOR_TOKEN`. There is no login command and no credentials file. The other
variables the CLI reads select modes or override local defaults; none of them is a credential
([architecture](architecture.md) §10).

### 8.3 Editor keys

Owned by the editor manager ([editor](editor.md)); the auth rules are:

| Event | Effect on the `editor` key |
|---|---|
| editor start (`createEditorSession` when stopped) | delete any existing `editor` key of the user, create a new one (lifetime `SCANTOR_EDITOR_API_KEY_TTL`), store its id in `editors.apiKeyId` and its expiry in `editors.apiKeyExpiresAt`, pass it as `SCANTOR_TOKEN` in the container env |
| editor stop (`stopEditor`, idle, key expiry, orphan cleanup) | delete the key |
| ban, user deletion | delete all keys (§5.7), stop the editor |
| key about to expire | the reaper stops the editor (reason `keyExpired`) once `apiKeyExpiresAt` is less than 5 minutes away; the next `createEditorSession` starts it with a fresh key ([editor](editor.md) §6.4) |
| `editor` key whose user has no editor in `starting`/`running` | the reaper deletes it |

What an `editor` key may do: everything a `default` key of a non-admin may do (§5.6), except
`createEditorSession` (403 `forbidden`). Operations marked `x-session-only` are not reachable with any key.
On `/mcp` an `editor` key always has level `write` ([mcp](mcp.md) §3.7); on `/api/auth/*` it is rejected
like every API key (§5.2).

## 9. Ownership helpers

`orchestrator/server/utils/authz.ts`. Route handlers never inspect `event.context.principal` directly.

| Helper | Returns / throws |
|---|---|
| `requireUser(event, opts?: { editorKey?: boolean })` | `UserPrincipal`. 401 if absent. `editorKey: false` gives 403 `forbidden` for `editor` keys (used only by `createEditorSession`). |
| `requireAdmin(event)` | `UserPrincipal` with `isAdmin`, else 403 `adminRequired` |
| `requireSession(event)` | `UserPrincipal` with `via = session`, else 403 `sessionRequired` (duplicates the central `x-session-only` check) |
| `requireNode(event)`, `requireWorker(event, { role? })`, `requireTools(event)`, `requireSetup(event)` | typed principal; worker routes pass `role: 'scheduler'` (403 `forbidden` for runners) and check the epoch (409 `staleEpoch`) |
| `ownerFilter(p, requestedUserId?)` | `{}` for admins (or `{userId: requestedUserId}` when given); `{userId: p.user.id}` for users; a non-admin's foreign `requestedUserId` gives 403 `adminRequired` |
| `callerFilter(p)` | `{userId: p.user.id}`, for admins too: the filter of the caller-only lists `listCredentials` and `listUploads` ([api](api.md) §1.3) |
| `loadOwned(coll, id, p, opts?)` | validates `id` with `z.uuid()` (malformed gives 404), runs **one** query `{_id: id}` (admin) or `{_id: id, userId: p.user.id}` (user), applies `opts.visible(doc)` (for example tasks with `deletingAt` are invisible), else 404 `notFound` |
| `resolveTask(p, ref)` | uuid → `loadOwned(tasks)`; slug → `{userId: p.user.id, name: ref, deletingAt: null}`. A name lookup never crosses users, even for admins (admins address other users' tasks by id). |
| `resolveRevisionRef(p, ref)` | `<task>@<N>`, `<task>@latest`, `<task>`, or a uuid tried as a revision id (via `loadOwned(revisions)`) and then as a task id (`@latest`) ([api](api.md) §1.4) |
| `loadOwnedScan(p, scanId)`, `loadOwnedAnalysis(p, analysisId)` | an analysis id `^(<uuid>)-(\d{1,16})$` loads the owned scan first, then `analyses.findOne({_id, scanId})` |
| `ownedRef(p, coll, id)` | for references inside create bodies (revision, uploads, credential): always the **caller's** documents, even for admins acting on their own behalf; anything else gives 404 |

Rules:

1. Order: authenticate (401), then visibility (404), then operation permission (403). A resource of another
   user is **404 `notFound`**, never 403. Admin-only operations check admin power before any lookup, so a
   non-admin gets 403 `adminRequired` for every id.
2. `userId` of new documents comes from the principal (top-level creates) or from the parent document
   (derived creates); request bodies never carry it ([data model](data-model.md) §1).
3. Request objects are never placed into MongoDB filters. Ids are parsed with zod before use. The query API
   has its own allowlist ([api](api.md) §5.2).
4. Lists use `ownerFilter`; single resources use `loadOwned` and its variants. The only lists that filter by
   the caller's own id instead, also for admins, are `listCredentials` and `listUploads` ([api](api.md) §1.3):
   their items can only be referenced by their owner (`ownedRef`). They use `callerFilter`. A handler that touches an owned
   collection without one of these helpers is a review blocker. The authorization matrix test catches the
   effect ([security](security.md) §7).

## 10. Machine credentials

### 10.1 Node tokens

| Aspect | Rule |
|---|---|
| format | `snt_` + base64url(32 random bytes), no padding: `^snt_[A-Za-z0-9_-]{43}$` |
| creation | `createNode` and `rotateNodeToken` generate it with `crypto.randomBytes`; the response contains it once (`token`, and inside `join`) |
| storage | `nodes.tokenHash` = lowercase hex SHA-256 of the full token string (unique partial index); `nodes.tokenPrefix` = first 8 characters for display |
| validation | regex, then `nodes.findOne({tokenHash})`; `state ≠ revoked`; version window (426 `incompatibleVersion`); instance lease on non-hello routes (409 `nodeInstanceConflict`, [nodes](nodes.md)). Positive results are cached 10 s by hash; rotate, revoke and delete clear the cache in-process. |
| principal | `{kind: 'node', node: {id, name, builtIn, endpointProfile, pool}}`. A node can report on, and request logs for, only workers whose `nodeId` is its own; other entries are ignored and logged ([api](api.md) §7). |
| rotation | `rotateNodeToken`: new token, new hash, `tokenRotatedAt`. The old token fails at once and the daemon must be restarted with the new one. A `revoked` node returns to `pending`. |
| revocation | `revokeNodeToken`: `tokenHash = null`, `state = revoked`, all its non-terminal workers `lost` at once (their worker tokens stop validating), registry pulls denied, event `node.revoked` |
| built-in node | token = `snt_` + base64url(key(`builtin-node`)), derived by the orchestrator and by the built-in daemon (`SCANTOR_NODE_BUILTIN=true`, which receives `SCANTOR_SECRET`). Boot step 6 upserts the built-in node and sets its `tokenHash` to the hash of the derived token, so the normal lookup applies. Not rotatable or revocable through the API (409 `builtInNode`). Changing `SCANTOR_SECRET` rotates it on both sides. |
| transport | the daemon refuses plaintext to non-private hosts ([security](security.md) §6.14); the token is never logged |

### 10.2 Worker tokens

| Aspect | Rule |
|---|---|
| format | `swt_<workerId>.<mac>`, `^swt_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$` |
| derivation | `mac = base64url(HMAC-SHA256(key("worker-token"), workerId + "\n" + scanId + "\n" + role + "\n" + nodeId))`. It is computed when the assignment for the worker is built, after placement has set `nodeId`. |
| storage | none; recomputed from the `workers` document on every request |
| validation | parse, then `workers.findOne({_id: workerId})` (no cache, so revocation is immediate), `state ∈ {assigned, pulling, starting, running, backoff, draining}`, recompute the MAC from the document's `scanId`, `role`, `nodeId`, compare with `timingSafeEqual` |
| principal | `{kind: 'worker', worker: {id, scanId, userId, role, nodeId, epoch}}`; identity (scan, role, node) comes only from here ([data model](data-model.md) §7 invariant 2) |
| binding | a runner token cannot call scheduler routes (403 `forbidden`); a scheduler token with a stale epoch gets 409 `staleEpoch`; uploads and status queries are confined to the token's scan |
| revocation | the worker reaches `stopped` or `lost` (scale-in, pause, completion, cancel, node offline, revoke or delete). The runtime treats 401 like `action: stop`. |
| exposure | delivered to the node in the assignment env (`SCANTOR_WORKER_TOKEN`); the runtime removes it from the environment of connector processes; never logged by the daemon, runtime or orchestrator |

### 10.3 Per-scan AMQP credentials

The RabbitMQ user `scan-<scanId>` has password `base64url(HMAC-SHA256(key("amqp"), scanId))`. The password is
never stored, is returned only by `GET /api/runtime/bootstrap` to that scan's workers, and is recreated
identically on resume and retry-failed. Permissions, limits and the kill-switch semantics are in
[queue](queue.md). The ingestor trusts only the broker-validated `user_id` ([security](security.md) §6.6).

### 10.4 Registry token server

`GET` and `POST /api/registry/token` ([api](api.md) §6), implemented in
`orchestrator/server/services/registry/token.ts`.

| Basic credential | Principal | Grants (intersection with the requested scope) |
|---|---|---|
| `node:<snt_…>` | that node (validated as in §10.1, including `revoked`) | `pull` on `tasks/<taskId>` for every task that has a worker in state `assigned` … `draining` with `nodeId` = this node. Nothing else: no push, no catalog, no other repositories. |
| `orchestrator:<base64url(key("registry-push"))>` | `registry` (orchestrator) | `pull`, `push`, `delete` on `tasks/*` (`delete` for the `taskDelete` job); `registry:catalog:*` |
| anything else, or missing | – | 401 `{"errors":[{"code":"UNAUTHORIZED","message":"…"}]}` |

Tokens are ES256 JWTs signed with the key derived from `registry-signing` (`kid` per [architecture](architecture.md)
§9), with `iss: "scantor"`, `aud: "scantor-registry"`, `sub: "node:<nodeId>"` or `"orchestrator"`, a lifetime
of 300 s and a fresh `jti`. No refresh token is issued. For `scantor task build --push` the orchestrator
passes only the derived `orchestrator` password, base64url(key(`registry-push`)), to the subprocess in the
environment variable `SCANTOR_REGISTRY_PUSH_PASSWORD` (internal contract, never in `.env`;
[architecture](architecture.md) §10), never on a command line ([tasks](tasks.md) §9.7). The subprocess never receives
`SCANTOR_SECRET` or any other key material (least privilege). Node daemons
pass the node credential per pull through the Engine API's `X-Registry-Auth` and never persist it in the
host's Docker configuration ([nodes](nodes.md)).

## 11. Admin tools cookie and forwardAuth

With the `traefik` profile, the admin GUIs (Traefik dashboard, RabbitMQ management, mongo-express, RustFS
console) are routed through the Traefik `forwardAuth` middleware `scantor-tools-auth`, which points at
`http://orchestrator:3000/api/tools/forward-auth` (`trustForwardHeader: false`, so Traefik sets
`X-Forwarded-*` from the real request and never passes client-supplied values;
`authResponseHeaders: [X-Scantor-User]`; [deployment](deployment.md) §7.5). They also keep their own
credentials. Without Traefik they are bound to `SCANTOR_ADMIN_BIND_ADDRESS` only and the tools routes are
unused.

Targets. The tool hosts are the fixed Traefik subdomains of [deployment](deployment.md) §7.3. The redirect URL is `<scheme>://<tool host>[:<port>]<path>`, with the
scheme and port of `SCANTOR_PUBLIC_URL`:

| `target` | Tool host | Path |
|---|---|---|
| `traefik` | `traefik.${SCANTOR_DOMAIN}` | `/dashboard/` |
| `rabbitmq` | `rabbitmq.${SCANTOR_DOMAIN}` | `/` |
| `mongo-express` | `mongo-express.${SCANTOR_DOMAIN}` | `/` |
| `rustfs` | `rustfs.${SCANTOR_DOMAIN}` | `/rustfs/console/` |

`GET /api/tools/session?target=<t>` (`createToolsSession`, admin, session only):

1. 404 `notFound` when `SCANTOR_DOMAIN` is empty (no Traefik);
2. mint a JWT with header `{alg: "HS256", typ: "JWT"}` and claims `{iss: "scantor", aud: "tools", sub: <userId>,
   role: "admin", iat, exp: iat + 28800, jti}`, signed with key(`tools-cookie`);
3. respond 302 to the target URL with
   `Set-Cookie: scantor_tools=<jwt>; Domain=<SCANTOR_DOMAIN>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`.

`GET /api/tools/forward-auth` (`toolsForwardAuth`, scope `tools`; the route parses the cookie itself, §5.5):

1. `X-Forwarded-Host` must be one of the four tool hosts; otherwise 401 with a short `text/plain` body (never
   the [api](api.md) §1.7 envelope). This stops the cookie from authorising any other router that might be
   pointed at the endpoint.
2. Verify the `scantor_tools` JWT: algorithm pinned to HS256, `iss`, `aud`, `exp` with 30 s leeway.
3. Load the user through the user cache: the user must exist, have role `admin` and not be banned.
4. Success: 200 with `X-Scantor-User: <userId>`.
5. Failure of step 2 or 3 (cookie missing, invalid or expired, user not an admin or banned): when the
   forwarded request's `Accept` header contains `text/html` (a browser navigation), 302 with
   `Location: <SCANTOR_PUBLIC_URL>/api/tools/session?target=<t>`, where `<t>` is the target of the
   forwarded host. `createToolsSession` then mints a fresh cookie for an admin with a dashboard session, or
   answers 401/403 itself. Any other request gets 401 with a short `text/plain` body (never the
   [api](api.md) §1.7 envelope). Traefik relays either response to the client.

The better-auth session cookie stays host-only, so it never reaches the tool subdomains. The tools cookie is
`HttpOnly` and is sent to every subdomain of `SCANTOR_DOMAIN`. Subdomains that serve user-influenced content
(the editor and S3) never forward it: the editor proxy strips all cookies ([editor](editor.md)), and RustFS
ignores it. Sign-out clears it (§2.8). Demotion or a ban stops it from working within 30 s.

## 12. Editor cookie

The editor listener, the handoff flow and the proxy are specified in [editor](editor.md) §8. The credential
rules, summarised from there:

| Item | Value |
|---|---|
| one-time code | `POST /api/editor/session` (`createEditorSession`) → `sec_` + base64url(32 random bytes), kept in memory in the `api` component, bound to `{userId, open}`, valid 60 s, single use |
| redemption | `GET <SCANTOR_EDITOR_URL>/_auth?code=…` on the editor listener; an unknown, used or expired code gives a 401 page, more than 30 failures per minute per client IP give 429 |
| cookie | `scantor_editor=v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>` with `mac = base64url(HMAC-SHA256(key("editor-cookie"), "v1.<userId>.<editorStartedAtMs>.<expiresAtMs>"))`. `editorStartedAtMs` is `editors.startedAt` (epoch ms) at redemption, `expiresAtMs` = redemption time + 12 h. Host-only on the editor host (no `Domain`), `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` when `SCANTOR_EDITOR_URL` is https, `Max-Age=43200` |
| validation (every editor-listener request, including WebSocket upgrades) | the cookie parses and the MAC matches (`timingSafeEqual`); `expiresAtMs > now`; the user exists and is not banned (user cache, ≤ 30 s); the user's editor is `starting` or `running` with `startedAt == editorStartedAtMs` (cached ≤ 5 s), so stopping or restarting an editor invalidates all its cookies. WebSocket upgrades additionally require `Origin` = origin of `SCANTOR_EDITOR_URL`. The editor listener accepts no other credential. |
| proxying | strips `cookie`, `authorization`, `proxy-authorization`, `x-api-key`, every `x-scantor-*` and the forwarding headers before forwarding to code-server's unix socket, and removes `Set-Cookie` from responses ([editor](editor.md) §8.6) |

## 13. MCP credentials (summary)

Specified in [mcp](mcp.md) §3:

- OAuth 2.1 access tokens (JWT, audience `${SCANTOR_PUBLIC_URL}/mcp`, scopes `scantor:read|write|admin`)
  are accepted **only** on `/mcp`. They are verified with `requireMcpAuth` against the loopback JWKS, then
  checked per request: the user exists and is not banned, and the client still has a consent row.
- API keys (`default` or `editor`) are also accepted on `/mcp`.
- Tool calls reach the REST API through single-use `sic_…` capabilities (§5.2), each bound to one operation,
  and carry the principal's MCP level.

## 14. Implementation map

| File | Contents |
|---|---|
| `orchestrator/server/utils/config.ts` | env parsing (`publicUrl`, `editorUrl`, `domain`, `trustProxy`, `passkeyRpId`, `userMaxWorkers`, `mcpEnabled`, `mcpAllowedRedirectOrigins`, …) |
| `orchestrator/server/utils/keys.ts` | HKDF derivations (mirror of `internal/keys`) |
| `orchestrator/server/utils/auth.ts` | better-auth instance, plugin configurations, hooks, indexes |
| `orchestrator/server/utils/auth-policy.ts` | pure policy: the HTTP allowlist (`isAuthHttpEndpoint`, `authHttpAllowlist`), rate limits, `trustedOrigins`, `resolvePasskeyConfig`, `resolveMcpConfig`, `isAllowedMcpRedirect` |
| `orchestrator/server/utils/principal.ts` | principal types, credential parsers, effective role |
| `orchestrator/server/utils/operations.ts` | operation registry and matcher |
| `orchestrator/server/utils/authz.ts` | `requireUser`, `requireAdmin`, `requireSession`, `requireNode`, `requireWorker`, `requireTools`, `requireSetup`, `ownerFilter`, `callerFilter`, `loadOwned`, `resolveTask`, `resolveRevisionRef`, `loadOwnedScan`, `loadOwnedAnalysis`, `ownedRef` |
| `orchestrator/server/utils/user-cache.ts` | 30 s user cache with in-process invalidation |
| `orchestrator/server/utils/users.ts` | user management wrappers, ban/unban/delete side effects, OAuth app listing and revocation |
| `orchestrator/server/utils/setup.ts` | `ensureFirstAdmin`, setup token, `spk_` tokens, `resolvePasskeySetupUser`, `completePasskeySetupUser` |
| `orchestrator/server/utils/node-tokens.ts`, `worker-tokens.ts` | node token generation/validation; worker token mint/verify |
| `orchestrator/server/utils/internal-auth.ts` | `sic_` capability mint/consume |
| `orchestrator/server/middleware/00.request.ts` | request id, client IP header, 421 for the editor host |
| `orchestrator/server/middleware/01.path.ts`, `orchestrator/server/utils/request-path.ts` | canonical request paths (§5.5) |
| `orchestrator/server/middleware/10.auth.ts`, `orchestrator/server/utils/credential-lookup.ts` | §5.5; session and API key lookups (401 only for a rejected credential, §5.2) |
| `orchestrator/server/middleware/11.passkey-guard.ts` | §6.4 |
| `orchestrator/server/services/registry/token.ts` | registry token server |
| `orchestrator/server/api/tools/session.get.ts`, `forward-auth.get.ts` | §11 |
| `orchestrator/server/plugins/` (editor listener), `orchestrator/server/services/editor/` | editor listener on container port 3001, one-time codes and `scantor_editor` cookies (§12, [editor](editor.md) §8) |
| `internal/keys` | Go HKDF derivations (built-in node token, shared vectors) |

## 15. Decisions

Decisions made in this document, flagged for lead review:

1. **Disjoint API-key prefixes** (`sk_scantor_` and `sk_scantor_editor_`) with per-configuration getters. This is
   required because `enableSessionForAPIKeys` always picks the first configuration whose getter returns a key,
   so a second configuration with the same header would reject every editor key.
2. **`keyExpiration.defaultExpiresIn` in seconds** (90 days = 7 776 000) for `@better-auth/api-key@1.7.12`,
   pinned by a unit test.
3. **API keys are rejected on `/api/auth/*`.** Otherwise a stolen key becomes a better-auth session, which can
   register passkeys, change the email or approve OAuth consents.
4. **Client IP through `x-scantor-client-ip`**, set by middleware from the socket or, with
   `SCANTOR_TRUST_PROXY=true`, from the rightmost `X-Forwarded-For` entry. better-auth's `ipAddressHeaders` is
   always this header, because its default trusts `x-forwarded-for` unconditionally.
5. **Central operation registry with deny-by-default.** `x-scantor-scope`, `x-admin-only`, `x-read-only`,
   `x-session-only` and the MCP level are enforced in the middleware from the runtime OpenAPI document, and
   handlers re-assert them. `x-session-only` and `x-destructive` are defined in [api](api.md) §1.1.
6. **Effective role**: an `editor` API key never has admin power, and MCP has admin power only with
   `scantor:admin`.
7. **Bans apply to user principals only.** Worker tokens of a banned user stay valid unless the scans are
   cancelled; the ban dialog pre-checks "cancel all scans". A ban also deletes OAuth tokens and consents.
   `deleteUser` locks the user out immediately, before the purge job runs.
8. **The built-in node's `tokenHash`** is upserted at boot from the derived token, so a single validation path
   covers all nodes.
9. **Setup token format `sst_`**, re-logged every 10 minutes, in-process mutex. Passkey setup tokens use the
   `spk_` prefix. The passkey-first admin is created in `afterVerification`, not in `resolveUser` (unlike
   agentor), so an aborted ceremony cannot lock setup.
10. **Passkey freshness guard**: passkey registration without a setup context needs a session younger than
    24 h, because `requireSession: false` would skip better-auth's fresh-session check.
11. **Trusted origins** are the public origin plus loopback aliases when the host is `localhost`. The editor
    origin is never trusted. CORS without credentials is enabled only on discovery, token, registration, JWKS
    and `/mcp`.
12. **Passkeys are disabled for IP-literal hosts** (WebAuthn forbids IP RP IDs).
13. **Tool hosts** are the fixed Traefik subdomains `traefik.`, `rabbitmq.`, `mongo-express.` and `rustfs.`
    of `SCANTOR_DOMAIN` ([deployment](deployment.md) decision 14) and form the forwardAuth `X-Forwarded-Host`
    allowlist. Browser requests without a valid tools cookie are redirected
    to `createToolsSession`; other requests get 401 (lead ruling).
14. **Editor credentials follow [editor](editor.md) §8** (lead ruling): `sec_` one-time codes (60 s) and
    `v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>` cookies bound to `editors.startedAt`. The `editor`
    API key lives for `SCANTOR_EDITOR_API_KEY_TTL`, and the reaper stops the editor shortly before it
    expires.
15. **better-auth rate limits** are fixed (sign-in 10/min per IP and others as in §2.7) and on in every
    environment.
16. **A non-admin's foreign `userId` list filter** gives 403 `adminRequired`.
17. **`scantor task build --push` receives only the derived registry password** through its environment,
    never `SCANTOR_SECRET` (lead ruling, least privilege).

## 16. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Organisations / shared tasks | Ownership goes only through `ownerFilter`/`loadOwned`; an `ownerRef {kind, id}` and a membership check replace `userId` equality there ([data model](data-model.md) §12). |
| SSO / OIDC sign-in, social providers | better-auth `socialProviders` or `genericOAuth`; add the related endpoints to the HTTP allowlist (§2.5). `disableSignUp` stays, so accounts must still be provisioned or auto-provisioned by an explicit hook. |
| Email verification and password reset | Configure `emailAndPassword.sendResetPassword` / `emailVerification` with an SMTP transport and add the endpoints to the HTTP allowlist (§2.5). |
| TOTP second factor | better-auth `twoFactor` plugin; the credential invariant (§6.4) extends to "at least one primary credential". |
| Scoped and read-only API keys | `apikey.permissions` exists in the schema; map permissions to MCP-style levels in `principal.ts` and the operation registry. |
| `__Host-` session cookie (resist cookie tossing from sibling subdomains) | custom `advanced.cookies.session_token` naming once better-auth supports `__Host-` with secure cookies; the middleware reads the cookie only through `getSession`. |
| Multi-replica orchestrator | better-auth rate limit `storage: 'database'`; `sic_` capabilities, setup and `spk_` tokens move to a TTL collection; the setup mutex becomes a `locks` entry; the user cache becomes a change-stream-invalidated cache. |
| Node mTLS / automatic node token rotation | The node principal is resolved in one function; a client-certificate path or a `POST /api/node/token/rotate` route can be added beside the Bearer path. |
| Per-user node pools | `user.allowedPools` additional field (`input: false`), enforced by placement next to `maxWorkers`. |
| Audit log | `events` with `userId: null` already carries security events; add `auth.*` event types for sign-in, key creation, ban and role changes. |
| Secret rotation without downtime | better-auth `secrets` (versioned) for the better-auth key; dual-key verification windows for worker and editor MACs. |
