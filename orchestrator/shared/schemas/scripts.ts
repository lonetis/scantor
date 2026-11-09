import { z } from 'zod'
import { fileContentQuery } from './analyses'
import { pageQueryShape, qBoolean, qInt, text, userIdFilterShape, waitQueryShape } from './common'
import { configObject, deleteTaskFileQuery, taskName, taskPath, writeTaskFilesBody } from './tasks'

// Request schemas of the script domain (docs/api.md, tags `scripts`, `script-files` and `script-runs`; docs/scripts.md).
// Every schema is strict. Instance limits (SCANTOR_SCRIPT_RUN_*, SCANTOR_MAX_SCAN_CONFIG_BYTES) are checked by the
// server after parsing; the bounds here only keep requests small. Script names follow the task name rules and the
// file routes mirror the task file routes, so their schemas are shared.

export const SCRIPT_DESCRIPTION_MAX = 1024
export const SCRIPT_RUN_MAX_SCANS = 20
export const SCRIPT_RUN_MAX_SECRETS = 32
/** Secret names are environment-variable-like: they reach the script as `ctx.secrets[NAME]`. */
export const SCRIPT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
export const SCRIPT_SECRET_VALUE_MAX_BYTES = 8192
export const SCRIPT_RUN_MIN_TIMEOUT_MS = 1000
/** The static bound of `settings.timeoutMs`; SCANTOR_SCRIPT_RUN_TIMEOUT caps it further. */
export const SCRIPT_RUN_MAX_TIMEOUT_MS = 365 * 86_400_000
export const SCRIPT_RUN_MIN_MEMORY_MIB = 256
export const SCRIPT_RUN_MAX_MEMORY_MIB = 1_048_576
export const SCRIPT_RUN_MAX_CPUS = 1024
export const SCRIPT_RUN_LOGS_LIMIT_DEFAULT = 200
export const SCRIPT_RUN_LOGS_LIMIT_MAX = 1000

// ── building blocks ─────────────────────────────────────────────────────────

/** A script name: the task name rules (a slug that is neither reserved nor shaped like a uuid). */
export const scriptName = taskName

/** `{script}`: a script id or a script name (resolved among the caller's scripts by the server). */
export const scriptRef = () => z.string().min(1).max(64)

const secretValue = () =>
  z
    .string()
    .refine((value) => new TextEncoder().encode(value).length <= SCRIPT_SECRET_VALUE_MAX_BYTES, `must be at most ${SCRIPT_SECRET_VALUE_MAX_BYTES} bytes`)

/** `secrets`: values the script reads as `ctx.secrets`; stored encrypted and never returned (only their names). */
export const scriptRunSecrets = () =>
  z
    .record(z.string().regex(SCRIPT_SECRET_NAME_PATTERN, 'must be an uppercase name such as API_TOKEN'), secretValue())
    .refine((secrets) => Object.keys(secrets).length <= SCRIPT_RUN_MAX_SECRETS, `at most ${SCRIPT_RUN_MAX_SECRETS} secrets`)

const settingsShape = {
  timeoutMs: z.number().int().min(SCRIPT_RUN_MIN_TIMEOUT_MS).max(SCRIPT_RUN_MAX_TIMEOUT_MS).optional(),
  resources: z
    .strictObject({
      cpus: z.number().positive().max(SCRIPT_RUN_MAX_CPUS).optional(),
      memoryMiB: z.number().int().min(SCRIPT_RUN_MIN_MEMORY_MIB).max(SCRIPT_RUN_MAX_MEMORY_MIB).optional(),
    })
    .optional(),
}

const runLimit = () => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/**
 * Settings of a new script run, merged over the manifest `defaults` when the run is built (explicit values win).
 * `limit` makes a sample run: every analysis stream ends after `limit` analyses.
 */
export const scriptRunSettingsInput = z.strictObject({ ...settingsShape, limit: runLimit().optional() })
export type ScriptRunSettingsInput = z.infer<typeof scriptRunSettingsInput>

/** Settings of a restart: overrides of the original run's settings; `limit: null` removes the original's limit. */
export const restartScriptRunSettingsInput = z.strictObject({ ...settingsShape, limit: runLimit().nullable().optional() })
export type RestartScriptRunSettingsInput = z.infer<typeof restartScriptRunSettingsInput>

// ── scripts (tag `scripts`) ─────────────────────────────────────────────────

export const scriptParams = z.strictObject({ script: scriptRef() })

export const listScriptsQuery = z.strictObject({
  ...pageQueryShape,
  ...userIdFilterShape,
  q: text(64).optional(),
})
export type ListScriptsQuery = z.infer<typeof listScriptsQuery>

export const createScriptBody = z.strictObject({
  name: scriptName(),
  description: z.string().trim().max(SCRIPT_DESCRIPTION_MAX).optional(),
})
export type CreateScriptBody = z.infer<typeof createScriptBody>

export const uploadScriptQuery = z.strictObject({ force: qBoolean().default(false) })
export type UploadScriptQuery = z.infer<typeof uploadScriptQuery>

// ── script files (tag `script-files`) ───────────────────────────────────────

export const listScriptFilesQuery = z.strictObject({
  path: taskPath().default(''),
  recursive: qBoolean().default(true),
})

export const readScriptFileQuery = z.strictObject({ path: taskPath() })

export const writeScriptFilesBody = writeTaskFilesBody
export type WriteScriptFilesBody = z.infer<typeof writeScriptFilesBody>

export const deleteScriptFileQuery = deleteTaskFileQuery

// ── script runs (tag `script-runs`) ─────────────────────────────────────────

export const startScriptRunBody = z.strictObject({
  scans: z.array(z.uuid()).min(1).max(SCRIPT_RUN_MAX_SCANS),
  config: configObject().default({}),
  secrets: scriptRunSecrets().optional(),
  settings: scriptRunSettingsInput.optional(),
  confirm: z.boolean().optional(),
})
export type StartScriptRunBody = z.infer<typeof startScriptRunBody>

export const startScriptRunQuery = z.strictObject({ ...waitQueryShape })

export const listScriptRunsQuery = z.strictObject({ ...pageQueryShape })

export const scriptRunParams = z.strictObject({ scriptRunId: z.uuid() })

export const getScriptRunQuery = z.strictObject({ ...waitQueryShape })

export const restartScriptRunBody = z.strictObject({
  resume: z.boolean().default(false),
  config: configObject().optional(),
  settings: restartScriptRunSettingsInput.optional(),
  confirm: z.boolean().optional(),
})
export type RestartScriptRunBody = z.infer<typeof restartScriptRunBody>

/** Lines are numbered from 1, like build logs; without `afterLine` the page starts at the first retained line. */
export const getScriptRunLogsQuery = z.strictObject({
  afterLine: qInt(0, Number.MAX_SAFE_INTEGER).optional(),
  limit: qInt(1, SCRIPT_RUN_LOGS_LIMIT_MAX).default(SCRIPT_RUN_LOGS_LIMIT_DEFAULT),
})
export type GetScriptRunLogsQuery = z.infer<typeof getScriptRunLogsQuery>

export const scriptRunOutputParams = z.strictObject({ scriptRunId: z.uuid(), outputId: z.uuid() })

/** `?redirect` of the output and source downloads (302 to the presigned URL instead of the JSON location). */
export const scriptRunDownloadQuery = z.strictObject({ redirect: qBoolean().default(false) })

/** `?offset&length` of readScriptRunOutput, the same paging as readAnalysisFile. */
export const scriptRunOutputContentQuery = fileContentQuery
