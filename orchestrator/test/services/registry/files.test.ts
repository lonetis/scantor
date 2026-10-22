import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HTTP_SECRET_FILE, JWKS_FILE, writeRegistryAuthFiles } from '../../../server/services/registry/files'
import { createKeyring } from '../../../server/utils/keys'
import { recordingLogger } from '../nodes/helpers'

// Boot step 610 (docs/architecture.md §4.1 step 6, docs/deployment.md §4.1, §4.5): jwks.json and http-secret are
// written atomically (no temporary files left behind) into the registry-auth directory, created when missing; a
// changed signing key is logged because the registry reads the JWKS only at start.

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scantor-registry-auth-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capture() {
  const log = recordingLogger()
  return { records: log.records, log }
}

describe('writeRegistryAuthFiles', () => {
  it('writes the JWKS and the HTTP secret into a new directory', async () => {
    const keys = createKeyring('registry files secret')
    const dir = join(tempDir(), 'nested', 'registry-auth')
    await writeRegistryAuthFiles(keys, capture().log, dir)

    const jwks = JSON.parse(readFileSync(join(dir, JWKS_FILE), 'utf8')) as { keys: Record<string, string>[] }
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: keys.registrySigningKey().kid })
    expect(jwks.keys[0]).not.toHaveProperty('d')
    expect(readFileSync(join(dir, HTTP_SECRET_FILE), 'utf8')).toBe(keys.registryHttpSecret())
    expect(keys.registryHttpSecret()).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(join(dir, HTTP_SECRET_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual([HTTP_SECRET_FILE, JWKS_FILE])
  })

  it('rewrites the files at every boot and warns when the signing key changed', async () => {
    const dir = tempDir()
    const first = capture()
    await writeRegistryAuthFiles(createKeyring('secret one'), first.log, dir)
    expect(first.records.some((record) => record.level === 'warn')).toBe(false)

    const same = capture()
    await writeRegistryAuthFiles(createKeyring('secret one'), same.log, dir)
    expect(same.records.some((record) => record.level === 'warn')).toBe(false)

    const changed = capture()
    const keys = createKeyring('secret two')
    await writeRegistryAuthFiles(keys, changed.log, dir)
    expect(changed.records.some((record) => record.level === 'warn' && /restart the registry/.test(record.msg))).toBe(true)
    expect(readFileSync(join(dir, HTTP_SECRET_FILE), 'utf8')).toBe(keys.registryHttpSecret())
  })

  it('replaces a corrupt JWKS file', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, JWKS_FILE), '{not json')
    await writeRegistryAuthFiles(createKeyring('secret three'), capture().log, dir)
    expect(() => JSON.parse(readFileSync(join(dir, JWKS_FILE), 'utf8')) as unknown).not.toThrow()
  })
})
