import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats, { type FormatName } from 'ajv-formats'
import type { ValidationIssue } from '#shared/types/common'
import type { DescriptionDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { type Keyring, useKeys } from '../../utils/keys'
import { useLogger } from '../../utils/logger'
import {
  configSecretAad,
  decryptSecret,
  dropDefaultedSecrets,
  encryptSecret,
  extractSecrets,
  formatPointer,
  MASK,
  maskedSecretPointers,
  restoreSecrets,
} from '../../utils/secrets'

/*
 * Effective configs (docs/tasks.md §6.3, §6.5; docs/data-model.md §1 "Encrypted values"): the task, scan and analysis
 * configs of a request are validated with ajv (draft 2020-12, `useDefaults`, `discriminator`, ajv-formats for the
 * asserted formats, unknown formats ignored) against the revision's describe schemas. The result is the effective
 * config (defaults filled, but a secret only ever from the request, never from a default and never as the mask "***"),
 * its `writeOnly` values encrypted by JSON pointer (HKDF label `config-secrets`, AAD
 * `<collection>:<_id>:/<configKind><pointer>`) and the masked config that is stored and returned ("***").
 *
 * Used by startScan (orch-scans) and test runs (orch-tasks). Callers that persist the secrets pass the document they
 * belong to as `binding` ({collection: 'scans' | 'testRuns', id}); restoreConfigSecrets with the same binding gives the
 * plaintext back (runtime bootstrap, test-run spec).
 */

export const CONFIG_KINDS = ['taskConfig', 'scanConfig', 'analysisConfig'] as const
export type ConfigKind = (typeof CONFIG_KINDS)[number]

export type ConfigObject = Record<string, unknown>

export interface ConfigInput {
  taskConfig?: unknown
  scanConfig?: unknown
  analysisConfig?: unknown
}

export interface ConfigSet {
  taskConfig: ConfigObject
  scanConfig: ConfigObject
  analysisConfig?: ConfigObject
}

/** Encrypted `writeOnly` values by config kind and concrete JSON pointer (scans.secrets, testRuns.secrets). */
export interface ConfigSecrets {
  taskConfig: Record<string, string>
  scanConfig: Record<string, string>
  analysisConfig?: Record<string, string>
}

export interface ValidatedConfigs {
  effective: ConfigSet
  secrets: ConfigSecrets
  masked: ConfigSet
}

/** The document a set of config secrets belongs to; part of every ciphertext's AAD. */
export interface SecretBinding {
  collection: string
  id: string
}

/** Binding used when a caller does not name the owning document (values are then not bound to one document). */
export const UNBOUND_SECRETS: SecretBinding = { collection: 'configs', id: 'unbound' }

const MAX_ISSUES = 100
const MAX_CACHED_VALIDATORS = 256

// ── ajv ─────────────────────────────────────────────────────────────────────

/**
 * The asserted formats of the JSON Schema subset (docs/tasks.md §6.4); every other format is an annotation. ajv-formats'
 * "full" mode (RFC 3339 dates and times, RFC 1123 host names, ISO 8601 durations) matches the Go validator
 * (santhosh-tekuri with format assertions) used by `scantor dev run`.
 */
export const ASSERTED_FORMATS: readonly FormatName[] = ['date', 'date-time', 'time', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uri', 'uuid', 'regex']

function createAjv(discriminator: boolean): Ajv2020 {
  const log = useLogger('configs')
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    useDefaults: true,
    discriminator,
    validateFormats: true,
    logger: { log: () => {}, warn: (...args: unknown[]) => log.debug('ajv warning', { warning: args.map(String).join(' ') }), error: (...args: unknown[]) => log.warn('ajv error', { error: args.map(String).join(' ') }) },
  })
  addFormats(ajv, { mode: 'full', formats: [...ASSERTED_FORMATS], keywords: false })
  return ajv
}

let primary: Ajv2020 | null = null
let fallback: Ajv2020 | null = null
const validators = new Map<string, { validate: ValidateFunction; ajv: Ajv2020; schema: object }>()

/**
 * Compiles (and caches) a validator. A schema whose `discriminator` keywords ajv cannot use is compiled again with the
 * keyword treated as an annotation (docs/tasks.md §6.4 accepts the OpenAPI keyword as an annotation).
 */
function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema)
  const cached = validators.get(key)
  if (cached) {
    validators.delete(key)
    validators.set(key, cached)
    return cached.validate
  }
  const { $id: _id, ...rest } = structuredClone(schema)
  primary ??= createAjv(true)
  let ajv = primary
  let validate: ValidateFunction
  try {
    validate = ajv.compile(rest)
  } catch (primaryError) {
    fallback ??= createAjv(false)
    ajv = fallback
    try {
      validate = ajv.compile(rest)
    } catch (error) {
      throw new Error(`schema cannot be compiled: ${(error as Error).message} (with discriminator: ${(primaryError as Error).message})`, { cause: error })
    }
  }
  validators.set(key, { validate, ajv, schema: rest })
  if (validators.size > MAX_CACHED_VALIDATORS) {
    const [oldestKey, oldest] = validators.entries().next().value!
    validators.delete(oldestKey)
    oldest.ajv.removeSchema(oldest.schema)
  }
  return validate
}

/** One ajv error as a request-body issue: a JSON pointer below `/<kind>` and a message (docs/api.md §1.7). */
export function issueFromAjvError(kind: string, error: ErrorObject): ValidationIssue {
  const base = `/${kind}${error.instancePath}`
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
    return { path: `${base}${formatPointer([params.missingProperty])}`, message: 'is required' }
  }
  if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return { path: `${base}${formatPointer([params.additionalProperty])}`, message: 'is not allowed (unknown property)' }
  }
  return { path: base, message: error.message ?? `failed ${error.keyword}` }
}

export interface ConfigValidationResult {
  /** a deep copy of the input with defaults filled (only meaningful when `issues` is empty) */
  value: unknown
  issues: ValidationIssue[]
}

/** Validates one config against its schema and fills defaults (on a copy). Issue paths start with `/<kind>`. */
export function validateConfig(kind: string, schema: Record<string, unknown>, input: unknown): ConfigValidationResult {
  let validate: ValidateFunction
  try {
    validate = compile(schema)
  } catch (error) {
    return { value: input, issues: [{ path: `/${kind}`, message: `the revision's ${kind} schema is unusable: ${(error as Error).message}` }] }
  }
  const value = structuredClone(input)
  if (validate(value)) return { value, issues: [] }
  const seen = new Set<string>()
  const issues: ValidationIssue[] = []
  for (const error of validate.errors ?? []) {
    const issue = issueFromAjvError(kind, error)
    const key = `${issue.path}\n${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push(issue)
  }
  return { value, issues }
}

function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── secrets ─────────────────────────────────────────────────────────────────

function aadFor(binding: SecretBinding, kind: ConfigKind) {
  return (pointer: string) => configSecretAad(binding.collection, binding.id, kind, pointer)
}

/** Rebuilds the plaintext configs from masked configs and their encrypted secrets (bootstrap, test-run spec). */
export function restoreConfigSecrets(masked: ConfigSet, secrets: Partial<ConfigSecrets>, binding: SecretBinding = UNBOUND_SECRETS, keys: Keyring = useKeys()): ConfigSet {
  const restored: ConfigSet = {
    taskConfig: restoreSecrets(masked.taskConfig, secrets.taskConfig ?? {}, aadFor(binding, 'taskConfig'), keys),
    scanConfig: restoreSecrets(masked.scanConfig, secrets.scanConfig ?? {}, aadFor(binding, 'scanConfig'), keys),
  }
  if (masked.analysisConfig) {
    restored.analysisConfig = restoreSecrets(masked.analysisConfig, secrets.analysisConfig ?? {}, aadFor(binding, 'analysisConfig'), keys)
  }
  return restored
}

/** Re-encrypts secrets for another document (restart clones copy secrets server-side, security.md SEC-3). */
export function rebindConfigSecrets(secrets: ConfigSecrets, from: SecretBinding, to: SecretBinding, keys: Keyring = useKeys()): ConfigSecrets {
  const rebind = (kind: ConfigKind, values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([pointer, value]) => {
        const plaintext = decryptSecret(value, 'config-secrets', aadFor(from, kind)(pointer), keys)
        return [pointer, encryptSecret(plaintext, 'config-secrets', aadFor(to, kind)(pointer), keys)]
      }),
    )
  const result: ConfigSecrets = { taskConfig: rebind('taskConfig', secrets.taskConfig), scanConfig: rebind('scanConfig', secrets.scanConfig) }
  if (secrets.analysisConfig) result.analysisConfig = rebind('analysisConfig', secrets.analysisConfig)
  return result
}

// ── validateConfigs ─────────────────────────────────────────────────────────

/**
 * Validates the configs of a scan start or test run against the revision's describe output. Missing task and scan
 * configs are validated as `{}`; the analysis config only when given. Throws 422 configInvalid with
 * `details.issues: [{path, message}]` (JSON pointers into the request body, at most 100) on any failure.
 */
export async function validateConfigs(
  description: DescriptionDoc | null | undefined,
  input: ConfigInput,
  binding: SecretBinding = UNBOUND_SECRETS,
  keys: Keyring = useKeys(),
): Promise<ValidatedConfigs> {
  if (!description) {
    throw apiError('configInvalid', 'the revision has no describe output', { issues: [{ path: '', message: 'the revision has no schemas' }] })
  }
  const kinds: ConfigKind[] = input.analysisConfig === undefined ? ['taskConfig', 'scanConfig'] : [...CONFIG_KINDS]
  const effective: Partial<Record<ConfigKind, ConfigObject>> = {}
  const issues: ValidationIssue[] = []
  for (const kind of kinds) {
    const requested = input[kind] ?? {}
    const result = validateConfig(kind, description.schemas[kind], requested)
    issues.push(...result.issues)
    if (result.issues.length === 0 && !isConfigObject(result.value)) issues.push({ path: `/${kind}`, message: 'must be an object' })
    if (!isConfigObject(result.value)) continue
    effective[kind] = result.value
    // Secrets come from the request only (docs/tasks.md §6.5): never from a default of a stored description, and
    // never as the mask of a response sent back.
    const secretPaths = description.secretPaths[kind] ?? []
    dropDefaultedSecrets(result.value, requested, secretPaths)
    for (const pointer of maskedSecretPointers(result.value, secretPaths)) {
      issues.push({ path: `/${kind}${pointer}`, message: `is the mask "${MASK}" of a secret; send the secret value itself` })
    }
  }
  if (issues.length > 0) {
    throw apiError('configInvalid', `config rejected by the revision schema: ${issues[0]!.path || '/'} ${issues[0]!.message}`, {
      issues: issues.slice(0, MAX_ISSUES),
    })
  }

  const masked: Partial<Record<ConfigKind, ConfigObject>> = {}
  const secrets: Partial<Record<ConfigKind, Record<string, string>>> = {}
  for (const kind of kinds) {
    const extracted = extractSecrets(effective[kind]!, description.secretPaths[kind] ?? [], aadFor(binding, kind), keys)
    masked[kind] = extracted.masked
    secrets[kind] = extracted.encrypted
  }
  const pick = <T>(values: Partial<Record<ConfigKind, T>>) =>
    ({
      taskConfig: values.taskConfig!,
      scanConfig: values.scanConfig!,
      ...(values.analysisConfig === undefined ? {} : { analysisConfig: values.analysisConfig }),
    }) as { taskConfig: T; scanConfig: T; analysisConfig?: T }
  return { effective: pick(effective), secrets: pick(secrets), masked: pick(masked) }
}
