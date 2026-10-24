import { z } from 'zod'
import languagesTable from '../../../schemas/languages.json'
import { CREDENTIAL_KINDS, REVISION_STATES, UPLOAD_KINDS } from '../utils/enums'
import { isUuid, SLUG_PATTERN, taskNameProblem } from '../utils/slug'
import { pageQueryShape, qBoolean, qInt, text, userIdFilterShape, waitQueryShape } from './common'

// Request schemas of the task domain (docs/api.md §4.5–§4.12): credentials, tasks, task files, git, uploads,
// revisions, test runs and the catalog. Every schema is strict (unknown keys are rejected). The server validates
// with them and the UI forms reuse them.

/** Languages of schemas/languages.json, the only language table of the platform. */
export const LANGUAGE_NAMES = Object.keys((languagesTable as { languages: Record<string, unknown> }).languages) as [string, ...string[]]

export const TASK_DESCRIPTION_MAX = 500
export const REVISION_MESSAGE_MAX = 500
export const CREDENTIAL_NAME_MAX = 64
export const CREDENTIAL_USERNAME_MAX = 128
export const CREDENTIAL_TOKEN_MAX = 4096
export const UPLOAD_NAME_MAX = 255
export const MAX_WRITE_FILES = 200
export const TASK_PATH_MAX_BYTES = 1024
export const TEST_RUN_LIMIT_MAX = 50
export const TEST_RUN_MAX_ATTEMPTS_MAX = 5
export const BUILD_LOG_LIMIT_DEFAULT = 1000
export const BUILD_LOG_LIMIT_MAX = 5000
/** The template value that selects the scaffold's generator stub instead of a template. */
export const CUSTOM_TEMPLATE = 'custom'
export const TEMPLATE_NAME_PATTERN = /^[a-z][a-z0-9]{0,31}$/

// ── building blocks ─────────────────────────────────────────────────────────

/** A task name: a slug that is neither reserved nor shaped like a uuid. */
export const taskName = () =>
  z.string().superRefine((value, ctx) => {
    const problem = taskNameProblem(value)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })

/** `{task}`: a task id or a task name (resolved among the caller's tasks by the server). */
export const taskRef = () => z.string().min(1).max(64)

/** `{revision}`: a number, `latest` or a revision id. */
export const revisionRef = () => z.string().regex(/^(latest|\d{1,9}|[0-9a-fA-F-]{36})$/, 'must be a number, latest or a revision id')

/**
 * A path inside a task folder (docs/editor.md §9.5); the helper is authoritative, these bounds only keep the
 * request small. An empty string addresses the task root where an operation allows it.
 */
export const taskPath = () => z.string().max(TASK_PATH_MAX_BYTES * 4)

/** A config object (task, scan or analysis config); its content is validated against the described schema. */
export const configObject = () => z.record(z.string(), z.unknown())

/** `host[:port]`, lowercase, without scheme or path (the exact host a git credential is sent to). */
export const credentialHost = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(261)
    .transform((value, ctx) => {
      const host = normalizeHost(value)
      if (host === null) {
        ctx.addIssue({ code: 'custom', message: 'must be host[:port] without scheme, credentials or path' })
        return z.NEVER
      }
      return host
    })

/** `host[:port]` as the URL standard serialises it for https (lowercase, default port 443 dropped), or null. */
export function normalizeHost(value: string): string | null {
  if (value.length === 0 || /[\s/@?#\\]/.test(value)) return null
  try {
    const url = new URL(`https://${value}`)
    const input = value.toLowerCase()
    return url.host === input || `${url.host}:443` === input ? url.host : null
  } catch {
    return null
  }
}

// ── credentials (§4.5) ──────────────────────────────────────────────────────

export const credentialParams = z.strictObject({ credentialId: z.uuid() })

export const createCredentialBody = z.strictObject({
  kind: z.enum(CREDENTIAL_KINDS),
  name: text(CREDENTIAL_NAME_MAX),
  host: credentialHost(),
  username: text(CREDENTIAL_USERNAME_MAX).default('x-access-token'),
  token: z.string().min(1).max(CREDENTIAL_TOKEN_MAX).refine((value) => !/[\r\n]/.test(value), 'must not contain line breaks'),
})
export type CreateCredentialBody = z.infer<typeof createCredentialBody>

export const updateCredentialBody = z
  .strictObject({
    name: text(CREDENTIAL_NAME_MAX).optional(),
    host: credentialHost().optional(),
    username: text(CREDENTIAL_USERNAME_MAX).optional(),
    token: z.string().min(1).max(CREDENTIAL_TOKEN_MAX).refine((value) => !/[\r\n]/.test(value), 'must not contain line breaks').optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'at least one field is required')
export type UpdateCredentialBody = z.infer<typeof updateCredentialBody>

// ── tasks (§4.6) ────────────────────────────────────────────────────────────

export const taskParams = z.strictObject({ task: taskRef() })

export const listTasksQuery = z.strictObject({
  ...pageQueryShape,
  ...userIdFilterShape,
  q: text(64).optional(),
  language: z.enum(LANGUAGE_NAMES).optional(),
})
export type ListTasksQuery = z.infer<typeof listTasksQuery>

export const createTaskBody = z.strictObject({
  name: taskName(),
  language: z.enum(LANGUAGE_NAMES),
  template: z
    .string()
    .refine((value) => value === CUSTOM_TEMPLATE || TEMPLATE_NAME_PATTERN.test(value), 'must be a template name or "custom"')
    .default('single'),
  description: z.string().trim().max(TASK_DESCRIPTION_MAX).optional(),
})
export type CreateTaskBody = z.infer<typeof createTaskBody>

export const uploadTaskQuery = z.strictObject({
  ...waitQueryShape,
  publish: qBoolean().default(true),
  force: qBoolean().default(false),
  message: text(REVISION_MESSAGE_MAX).optional(),
})
export type UploadTaskQuery = z.infer<typeof uploadTaskQuery>

// ── task files (§4.7) ───────────────────────────────────────────────────────

export const listTaskFilesQuery = z.strictObject({
  path: taskPath().default(''),
  recursive: qBoolean().default(true),
  revision: revisionRef().optional(),
})

export const readTaskFileQuery = z.strictObject({
  path: taskPath(),
  revision: revisionRef().optional(),
})

export const fileContent = z.union([z.string(), z.strictObject({ base64: z.base64() })])

// The keys are checked by the path rules (an empty path is 422 invalidPath like every other invalid path), not here.
export const writeTaskFilesBody = z.strictObject({
  files: z
    .record(taskPath(), fileContent)
    .refine((files) => Object.keys(files).length >= 1, 'at least one file is required')
    .refine((files) => Object.keys(files).length <= MAX_WRITE_FILES, `at most ${MAX_WRITE_FILES} files per request`),
})
export type WriteTaskFilesBody = z.infer<typeof writeTaskFilesBody>

export const deleteTaskFileQuery = z.strictObject({
  path: taskPath(),
  recursive: qBoolean().default(false),
})

// ── git (§4.8) ──────────────────────────────────────────────────────────────

/**
 * Why the syntax of a git URL is rejected (docs/editor.md §9.7, security.md WS-6), or null: `https://` only, no
 * userinfo (not even an empty one), no leading `-` and a host. The server additionally checks the host's addresses
 * (`server/services/tasks/git-url.ts`); the import form validates with the same rule, so such URLs never leave the
 * browser.
 */
export function gitUrlProblem(raw: string): string | null {
  const value = raw.trim()
  if (value.startsWith('-')) return 'must not start with "-"'
  if (!/^https:\/\//i.test(value)) return 'must be an https:// URL'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'is not a valid URL'
  }
  if (url.protocol !== 'https:') return 'must be an https:// URL'
  const authority = value.slice('https://'.length).split(/[/?#\\]/, 1)[0] ?? ''
  if (url.username || url.password || authority.includes('@')) return 'must not contain credentials; use a git credential instead'
  if (!url.hostname) return 'must name a host'
  if (url.hostname.startsWith('-')) return 'the host must not start with "-"'
  return null
}

export const gitUrl = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .superRefine((value, ctx) => {
      const problem = gitUrlProblem(value)
      if (problem) ctx.addIssue({ code: 'custom', message: problem })
    })

export const importGitBody = z.strictObject({
  url: gitUrl(),
  ref: z.string().trim().min(1).max(255).regex(/^[^\s\0\\]+$/, 'must not contain whitespace, NUL or backslashes').refine((value) => !value.startsWith('-'), 'must not start with "-"').default('HEAD'),
  path: z.string().trim().min(1).max(1024).regex(/^[^\0\\]+$/, 'must not contain NUL or backslashes').default('.'),
  credentialId: z.uuid().optional(),
  select: z.array(z.string().min(1).max(1024)).min(1).max(100).optional(),
})
export type ImportGitBody = z.infer<typeof importGitBody>

export const pullGitBody = z.strictObject({ force: z.boolean().default(false) })
export type PullGitBody = z.infer<typeof pullGitBody>

// ── uploads (§4.9) ──────────────────────────────────────────────────────────

export const uploadParams = z.strictObject({ uploadId: z.uuid() })

export const createUploadQuery = z.strictObject({
  name: text(UPLOAD_NAME_MAX).optional(),
  kind: z.enum(UPLOAD_KINDS).default('list'),
})

export const listUploadsQuery = z.strictObject({ ...pageQueryShape })

// ── revisions (§4.10) ───────────────────────────────────────────────────────

export const revisionParams = z.strictObject({ task: taskRef(), revision: revisionRef() })

export const listRevisionsQuery = z.strictObject({
  ...pageQueryShape,
  state: z.enum(REVISION_STATES).optional(),
})

export const publishRevisionBody = z.strictObject({
  message: text(REVISION_MESSAGE_MAX).optional(),
})
export type PublishRevisionBody = z.infer<typeof publishRevisionBody>

export const waitQuery = z.strictObject({ ...waitQueryShape })

export const buildLogQuery = z.strictObject({
  afterLine: qInt(0, Number.MAX_SAFE_INTEGER).default(0),
  limit: qInt(1, BUILD_LOG_LIMIT_MAX).default(BUILD_LOG_LIMIT_DEFAULT),
})

export const redirectQuery = (fallback: boolean) => z.strictObject({ redirect: qBoolean().default(fallback) })

// ── test runs (§4.11) ───────────────────────────────────────────────────────

export const testTaskBody = z.strictObject({
  taskConfig: configObject().optional(),
  scanConfig: configObject().optional(),
  analysisConfig: configObject().optional(),
  limit: z.number().int().min(1).max(TEST_RUN_LIMIT_MAX).default(5),
  maxAttempts: z.number().int().min(1).max(TEST_RUN_MAX_ATTEMPTS_MAX).default(1),
  timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
})
export type TestTaskBody = z.infer<typeof testTaskBody>

export const testRunParams = z.strictObject({ testRunId: z.uuid() })

export const testRunFileParams = z.strictObject({ testRunId: z.uuid(), fileId: z.uuid() })

export const getTestRunQuery = z.strictObject({
  ...waitQueryShape,
  analyses: qBoolean().default(true),
})

export const listTestRunsQuery = z.strictObject({ ...pageQueryShape })

// ── catalog (§4.12) ─────────────────────────────────────────────────────────

export const templateParams = z.strictObject({ template: z.string().regex(TEMPLATE_NAME_PATTERN) })

export const estimateTemplateBody = z.strictObject({ scanConfig: configObject().default({}) })

export const languageParams = z.strictObject({ language: z.string().min(1).max(32) })

export const guideParams = z.strictObject({ guide: z.string().regex(/^[a-z][a-z-]{0,31}$/) })

// ── helpers shared with the UI ──────────────────────────────────────────────

/** True for a uuid-shaped `{task}` (an id rather than a name). */
export function isTaskId(ref: string): boolean {
  return isUuid(ref)
}

/** True for a slug (used by the UI's live name validation before the reserved-name check). */
export function isTaskSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}
