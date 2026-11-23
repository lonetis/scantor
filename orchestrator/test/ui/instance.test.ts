import { afterAll, describe, expect, it, vi } from 'vitest'

// The instance info of the SPA (docs/ui.md §1): loaded once per page, tried again after a failure, and the check a
// download handler runs before it follows a presigned URL (useInstance().downloadsAvailable): a page loaded through
// the tunnel URL never leaves for an unreachable S3 link because a click came before the info.

/** The answers of the next getInstanceInfo calls (a function that throws is a failure); every call is counted. */
const answers: (() => unknown)[] = []
let requests = 0
vi.stubGlobal('useApi', () => async (path: string) => {
  expect(path).toBe('/api/info')
  requests++
  return (answers.shift() ?? (() => Promise.reject(new Error('no answer'))))()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

const { useInstance } = await import('../../app/composables/useInstance')

function infoOf(origin: 'public' | 'tunnel') {
  return { origin, publicUrl: 'https://scantor.example.com', tunnelUrl: 'https://tunnel.example.org', features: { downloads: origin === 'public' } }
}

describe('useInstance', () => {
  it('allows downloads while the info is missing, tries the info again on the next call and then follows it', async () => {
    const instance = useInstance()
    answers.push(() => {
      throw new Error('503 unavailable')
    })
    // A failed load keeps downloads on: they work on the public URL, and the next caller tries again.
    expect(await instance.downloadsAvailable()).toBe(true)
    expect(requests).toBe(1)
    expect(instance.info.value).toBeNull()

    answers.push(() => infoOf('tunnel'))
    expect(await instance.downloadsAvailable()).toBe(false)
    expect(requests).toBe(2)
    expect(instance.isTunnel.value).toBe(true)
    expect(instance.features.value.downloads).toBe(false)

    // Loaded once per page: later checks ask nothing.
    expect(await instance.downloadsAvailable()).toBe(false)
    await instance.loadInfo()
    expect(requests).toBe(2)
  })
})
