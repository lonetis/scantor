import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Keyring } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { registryJwks } from './jwt'

// Boot step 610 (docs/architecture.md §4.1 step 6, docs/deployment.md §4.1, §4.5): the public JWKS of the registry
// signing key and the registry HTTP secret, both derived from SCANTOR_SECRET, are written atomically into the
// `scantor-registry-auth` volume at every boot. The registry's wrapper entrypoint waits for both files. The
// directory is created when missing, so an orchestrator started without the volume still boots.

/** Mount point of the `scantor-registry-auth` volume in the orchestrator container. */
export const REGISTRY_AUTH_DIR = '/run/scantor/registry-auth'
export const JWKS_FILE = 'jwks.json'
export const HTTP_SECRET_FILE = 'http-secret'

async function writeAtomic(dir: string, name: string, content: string, mode: number): Promise<void> {
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, content, { mode })
    await rename(temp, join(dir, name))
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function previousKid(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, JWKS_FILE), 'utf8')) as { keys?: { kid?: unknown }[] }
    const kid = parsed.keys?.[0]?.kid
    return typeof kid === 'string' ? kid : null
  } catch {
    // Missing on the first boot; an unreadable or corrupt file is simply replaced.
    return null
  }
}

export async function writeRegistryAuthFiles(keys: Keyring, log: Logger, dir: string = REGISTRY_AUTH_DIR): Promise<void> {
  await mkdir(dir, { recursive: true })
  const signing = keys.registrySigningKey()
  const before = await previousKid(dir)
  await writeAtomic(dir, JWKS_FILE, `${JSON.stringify(registryJwks(signing))}\n`, 0o644)
  await writeAtomic(dir, HTTP_SECRET_FILE, keys.registryHttpSecret(), 0o600)
  if (before !== null && before !== signing.kid) {
    log.warn('the registry signing key changed (SCANTOR_SECRET changed); restart the registry so it reads the new JWKS', { kid: signing.kid })
  }
  log.info('registry auth files written', { dir, kid: signing.kid })
}
