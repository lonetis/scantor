import { describe, expect, it } from 'vitest'
import { checkClientVersion, clientImageTag, isReleaseVersion } from '../../server/utils/version'

// Version window (docs/api.md §1.10) and the image tag rule of decision 14.

describe('isReleaseVersion and clientImageTag', () => {
  it('uses the release version, otherwise SCANTOR_IMAGE_TAG', () => {
    expect(isReleaseVersion('1.4.0')).toBe(true)
    expect(isReleaseVersion('1.4.0-12-gabcdef')).toBe(false)
    expect(isReleaseVersion('dev')).toBe(false)
    expect(clientImageTag('1.4.0', 'latest')).toBe('1.4.0')
    expect(clientImageTag('1.4.0-3-gabc', 'latest')).toBe('latest')
    expect(clientImageTag('dev', 'dev')).toBe('dev')
  })
})

describe('checkClientVersion', () => {
  it.each([
    ['1.4.0', '1.4.2', true],
    ['1.4.0', '1.3.9', true],
    ['1.4.0', 'v1.4.0', true],
    ['1.4.0', '1.2.0', false],
    ['1.4.0', '1.5.0', false],
    ['1.4.0', '2.4.0', false],
    ['1.4.0', 'dev', false],
    // A build from main counts by its leading X.Y.Z (docs/api.md §1.10).
    ['1.4.0', '1.4.0-3-gabc1234', true],
    ['1.4.0', '1.2.0-7-gabc1234', false],
    ['1.4.0', undefined, false],
    ['1.0.0', '1.0.1', true],
    ['dev', 'anything', true],
    ['1.4.0-3-gabc', '0.1.0', true],
  ])('server %s accepts %s: %s', (server, client, ok) => {
    expect(checkClientVersion(server, client).ok).toBe(ok)
  })

  it('reports the window', () => {
    expect(checkClientVersion('2.7.1', '2.5.0')).toEqual({ ok: false, serverVersion: '2.7.1', minVersion: '2.6.0' })
  })
})
