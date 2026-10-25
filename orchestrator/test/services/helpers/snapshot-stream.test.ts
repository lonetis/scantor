import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelperResult } from '../../../server/services/helpers/types'

// snapshotStream (docs/editor.md §9.4): a helper that never ran or never exited destroys the sink, so whoever reads
// the sink (the snapshot upload, a download response) ends instead of waiting for more bytes.

let outcome: () => Promise<HelperResult>
const signals: (AbortSignal | undefined)[] = []

vi.mock('../../../server/services/helpers/executor', () => ({
  executeHelper: (_op: string, options: { signal?: AbortSignal }) => {
    signals.push(options.signal)
    return outcome()
  },
  useHelperRuntime: () => ({ config: { taskMaxFiles: 10, taskMaxBytes: 10, workspaceMaxBytes: 10, taskMaxPackBytes: 10 } }),
}))

const { snapshotStream } = await import('../../../server/services/helpers/ops')

beforeEach(() => {
  signals.length = 0
})

describe('snapshotStream', () => {
  it('destroys the sink when the helper does not run', async () => {
    outcome = async () => {
      throw new Error('no workspace helper slot became free within 30 s; retry later')
    }
    const sink = new PassThrough()
    await expect(snapshotStream('u1', 'echo', sink)).rejects.toThrow('no workspace helper slot')
    expect(sink.destroyed).toBe(true)
  })

  it('passes the signal on and returns the summary of a helper that exited', async () => {
    const summary = { packSha256: 'a'.repeat(64), fileCount: 1, bytes: 1, packBytes: 1 }
    outcome = async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: `${JSON.stringify({ type: 'summary', ...summary })}\n` })
    const sink = new PassThrough()
    const abort = new AbortController()
    await expect(snapshotStream('u1', 'echo', sink, abort.signal)).resolves.toMatchObject(summary)
    expect(signals).toEqual([abort.signal])
    expect(sink.destroyed).toBe(false)
  })
})
