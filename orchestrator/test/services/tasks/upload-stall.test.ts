import { PassThrough, type Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A task upload's body feeds the `extract` helper, which holds a helper slot while it reads (docs/editor.md §9.8,
// security.md RES-8): a body that sends nothing for the idle time fails the upload with 400 badRequest, while data
// buffered behind a helper that waits for its slot does not count as a stall.

let helper: (stdin: Readable) => Promise<never>
const discarded: string[] = []

vi.mock('../../../server/services/helpers/ops', () => ({
  extract: (_userId: string, _stagingId: string, stdin: Readable) => helper(stdin),
  discard: async (_userId: string, stagingId: string) => {
    discarded.push(stagingId)
  },
  commit: async () => undefined,
  snapshotHash: async () => null,
}))

const { uploadTask } = await import('../../../server/services/tasks/upload')
type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const alice = { kind: 'user', user: { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11' }, isAdmin: false } as unknown as UserPrincipal

/** Reads stdin like the helper until it ends, then fails like `extract` on a truncated archive. */
async function readAll(stdin: Readable): Promise<never> {
  for await (const chunk of stdin) void chunk
  throw new Error('unexpected EOF in the archive')
}

beforeEach(() => {
  discarded.length = 0
})

describe('uploadTask stall guard', () => {
  it('fails a body that stops sending with 400 badRequest', async () => {
    const body = new PassThrough()
    body.write(Buffer.alloc(100))
    helper = readAll
    await expect(uploadTask(alice, { body, maxBytes: 1024 ** 2, publish: false, force: false, idleMs: 50 })).rejects.toMatchObject({ code: 'badRequest', details: { idleMs: 50 } })
    expect(discarded).toHaveLength(1)
  })

  it('does not count data buffered behind a helper that has not started reading', async () => {
    const body = new PassThrough()
    body.write(Buffer.alloc(256 * 1024))
    let endedBeforeRead: boolean | null = null
    helper = async (stdin) => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      endedBeforeRead = stdin.readableEnded
      return readAll(stdin)
    }
    await expect(uploadTask(alice, { body, maxBytes: 1024 ** 2, publish: false, force: false, idleMs: 50 })).rejects.toMatchObject({ code: 'badRequest' })
    expect(endedBeforeRead).toBe(false)
  })

  it('keeps helper errors of a body that arrived completely', async () => {
    const body = new PassThrough()
    body.end(Buffer.alloc(100))
    helper = async (stdin) => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return readAll(stdin)
    }
    await expect(uploadTask(alice, { body, maxBytes: 1024 ** 2, publish: false, force: false, idleMs: 50 })).rejects.toThrow('unexpected EOF in the archive')
  })
})
