import { describe, expect, it } from 'vitest'
import { checkGitUrl, isNonPublicAddress, parseGitUrl } from '../../../server/services/tasks/git-url'
import { ApiError } from '../../../server/utils/errors'

// The git URL pre-check (docs/editor.md §9.7, security.md WS-6): https only, no userinfo, no leading "-", and only
// public addresses unless SCANTOR_GIT_ALLOW_PRIVATE=true (the test stack allows private hosts).

const lookupTo = (...addresses: string[]) => async () => addresses

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof ApiError ? error.code : 'other'
  }
}

describe('parseGitUrl', () => {
  it('accepts https URLs and reports host[:port] for the credential match', () => {
    expect(parseGitUrl('https://GitHub.com/acme/repo.git')).toMatchObject({ host: 'github.com', hostname: 'github.com' })
    expect(parseGitUrl('https://git.example.org:8443/r')).toMatchObject({ host: 'git.example.org:8443' })
    expect(parseGitUrl('https://example.org:443/r').host).toBe('example.org')
  })

  it.each([
    'http://example.org/r.git',
    'git@example.org:r.git',
    'ssh://example.org/r',
    'file:///etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    'https://user:token@example.org/r.git',
    'https://token@example.org/r.git',
    'https://@example.org/r.git',
    '-uhttps://example.org/r.git',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => parseGitUrl(url)).toThrow(ApiError)
  })

  it('reports the shared rule at path url', () => {
    try {
      parseGitUrl('https://user:secret@example.org/r.git')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe('validationFailed')
      expect(JSON.stringify((error as ApiError).details)).toContain('must not contain credentials')
    }
  })
})

describe('checkGitUrl', () => {
  it('rejects hosts that resolve to non-public addresses', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(await code(checkGitUrl('https://git.internal/r.git', { allowPrivate: false, lookup: lookupTo(address) }))).toBe('validationFailed')
    }
  })

  it('rejects a host when any of its addresses is private (no partial pinning)', async () => {
    expect(await code(checkGitUrl('https://mixed.example/r.git', { allowPrivate: false, lookup: lookupTo('93.184.216.34', '10.0.0.1') }))).toBe('validationFailed')
  })

  it('accepts public hosts and private ones when allowed', async () => {
    expect(await checkGitUrl('https://example.org/r.git', { allowPrivate: false, lookup: lookupTo('93.184.216.34', '2606:2800:220:1::248') })).toEqual({ url: 'https://example.org/r.git', host: 'example.org' })
    expect(await code(checkGitUrl('https://fixtures:8443/r.git', { allowPrivate: true, lookup: lookupTo('10.0.0.5') }))).toBe('ok')
  })

  it('checks IP literals without a lookup and reports unresolvable hosts as gitFailed', async () => {
    expect(await code(checkGitUrl('https://127.0.0.1/r.git', { allowPrivate: false, lookup: async () => { throw new Error('no lookup expected') } }))).toBe('validationFailed')
    expect(await code(checkGitUrl('https://[::1]/r.git', { allowPrivate: false }))).toBe('validationFailed')
    expect(await code(checkGitUrl('https://nowhere.invalid/r.git', { allowPrivate: false, lookup: async () => { throw new Error('ENOTFOUND') } }))).toBe('gitFailed')
  })

  it('classifies addresses', () => {
    expect(isNonPublicAddress('8.8.8.8')).toBe(false)
    expect(isNonPublicAddress('2001:4860:4860::8888')).toBe(false)
    expect(isNonPublicAddress('100.127.255.255')).toBe(true)
    expect(isNonPublicAddress('not-an-ip')).toBe(true)
  })
})
