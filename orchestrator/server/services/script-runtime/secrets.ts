import type { ScriptRunDoc } from '../../types/documents'
import { type Keyring, useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { REDACTED, redactText } from '../../utils/redact'
import { decryptSecret, encryptSecret, SecretDecryptionError } from '../../utils/secrets'

// The secrets of a script run (docs/scripts.md, security.md SEC-1): the NAME → value map is sealed as one JSON
// document with AES-256-GCM under HKDF label `config-secrets` and AAD `scriptRuns:<runId>:secrets`, so a sealed blob
// cannot be moved to another run. Only the names are ever returned by the API; the values are decrypted in the
// script runtime bootstrap, and for masking. Every text the run's code controls and the API returns (log lines, the
// crash's stderr tail, the reported error, the progress message) passes maskScriptRunText before it is stored.

/** Secret values shorter than this are not masked (they would mask ordinary words). */
export const MIN_MASKED_SECRET_LENGTH = 6

/** AAD of the sealed secrets of one script run. */
export function scriptRunSecretsAad(scriptRunId: string): string {
  return `scriptRuns:${scriptRunId}:secrets`
}

/** `ScriptRunDoc.secrets` for the values of a new run (null without secrets). */
export function sealScriptRunSecrets(scriptRunId: string, values: Record<string, string>, keys: Keyring = useKeys()): ScriptRunDoc['secrets'] {
  const names = Object.keys(values)
  if (names.length === 0) return null
  return { names, enc: encryptSecret(JSON.stringify(values), 'config-secrets', scriptRunSecretsAad(scriptRunId), keys) }
}

/** The plaintext secrets of a run ({} without secrets); throws SecretDecryptionError when the blob does not open. */
export function unsealScriptRunSecrets(run: Pick<ScriptRunDoc, '_id' | 'secrets'>, keys: Keyring = useKeys()): Record<string, string> {
  if (!run.secrets) return {}
  const parsed: unknown = JSON.parse(decryptSecret(run.secrets.enc, 'config-secrets', scriptRunSecretsAad(run._id), keys))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === 'string')) {
    throw new SecretDecryptionError('the sealed script-run secrets are not a NAME → value map')
  }
  return parsed as Record<string, string>
}

/** The secret values maskScriptRunText masks: at least MIN_MASKED_SECRET_LENGTH characters, longest first. */
export function maskableSecrets(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length >= MIN_MASKED_SECRET_LENGTH).sort((a, b) => b.length - a.length)
}

/**
 * Text of a script run as it may be stored and returned: the redaction rules (tokens, presigned signatures), then the
 * run's secret values (`secrets` from maskableSecrets; longest first, so a value that contains another is masked whole).
 */
export function maskScriptRunText(text: string, secrets: readonly string[]): string {
  let masked = redactText(text)
  for (const secret of secrets) masked = masked.split(secret).join(REDACTED)
  return masked
}

/**
 * The maskable secret values of a stored run ([] without secrets or run). A blob that does not open masks nothing
 * beyond the redaction rules (warned): the container never received those values either.
 */
export async function loadMaskableSecrets(scriptRunId: string, log: Pick<Logger, 'warn'>): Promise<string[]> {
  const run = await useCollections().scriptRuns.findOne({ _id: scriptRunId }, { projection: { _id: 1, secrets: 1 } })
  if (!run?.secrets) return []
  try {
    return maskableSecrets(Object.values(unsealScriptRunSecrets(run)))
  } catch (error) {
    log.warn('the secrets of a script run do not open; its text is not masked with them', { scriptRunId, err: error })
    return []
  }
}
