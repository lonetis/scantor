import { describe, expect, it } from 'vitest'
import { gitUrlProblem, importGitBody } from '../../shared/schemas/tasks'

// The git URL syntax rule shared by the import-git request schema, the server pre-check and the UI form (docs/editor.md
// §9.7, security.md WS-6): https only, no userinfo and no leading "-", so the browser never sends such URLs.

describe('gitUrlProblem', () => {
  it('accepts https URLs', () => {
    for (const url of ['https://github.com/acme/tasks.git', 'HTTPS://git.example.org:8443/r', 'https://[2001:db8::1]/r.git', '  https://example.org/r  ']) {
      expect(gitUrlProblem(url), url).toBeNull()
    }
  })

  it.each([
    ['http://example.org/r.git', 'must be an https:// URL'],
    ['ssh://git@example.org/r.git', 'must be an https:// URL'],
    ['git@example.org:r.git', 'must be an https:// URL'],
    ['file:///etc/passwd', 'must be an https:// URL'],
    ['ext::sh -c touch% /tmp/pwned', 'must be an https:// URL'],
    ['-uhttps://example.org/r.git', 'must not start with "-"'],
    ['https://user:secret@example.org/r.git', 'must not contain credentials; use a git credential instead'],
    ['https://token@example.org/r.git', 'must not contain credentials; use a git credential instead'],
    ['https://:secret@example.org/r.git', 'must not contain credentials; use a git credential instead'],
    ['https://@example.org/r.git', 'must not contain credentials; use a git credential instead'],
    ['https://', 'is not a valid URL'],
    ['https://exa mple.org/r', 'is not a valid URL'],
  ])('rejects %s', (url, problem) => {
    expect(gitUrlProblem(url)).toBe(problem)
  })

  it('does not mistake an @ in the path or query for userinfo', () => {
    expect(gitUrlProblem('https://example.org/@scope/repo.git')).toBeNull()
    expect(gitUrlProblem('https://example.org/r.git?ref=a@b')).toBeNull()
  })
})

describe('importGitBody', () => {
  it('rejects a URL with credentials at path url, so the API answers 400 before any helper runs', () => {
    const result = importGitBody.safeParse({ url: 'https://user:secret@git.example.org/single.git' })
    expect(result.success).toBe(false)
    expect(result.error?.issues).toMatchObject([{ path: ['url'], message: 'must not contain credentials; use a git credential instead' }])
  })

  it('trims the URL and applies the defaults', () => {
    expect(importGitBody.parse({ url: ' https://git.example.org/single.git ' })).toEqual({ url: 'https://git.example.org/single.git', ref: 'HEAD', path: '.' })
  })
})
