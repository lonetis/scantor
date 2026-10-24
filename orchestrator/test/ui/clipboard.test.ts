import { describe, expect, it, vi } from 'vitest'
import { writeClipboard, type ClipboardEnvironment } from '../../app/utils/clipboard'

// Copy buttons (docs/ui.md §7, FEATURES UI-NAV-027): the Clipboard API first, the execCommand fallback second, and
// a rejection when both refuse, so the UI shows "Copy failed" rather than "Copied".

function fakeDocument(copyResult: boolean | 'throw') {
  const areas: { value: string; removed: boolean }[] = []
  const execCommand = vi.fn(() => {
    if (copyResult === 'throw') throw new Error('not allowed')
    return copyResult
  })
  const document = {
    activeElement: null,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => {
      const area = { value: '', removed: false, style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: () => (area.removed = true) }
      areas.push(area)
      return area
    }),
    execCommand,
  }
  return { document: document as unknown as NonNullable<ClipboardEnvironment['document']>, areas, execCommand }
}

const refuse = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))

describe('writeClipboard', () => {
  it('uses the Clipboard API when it accepts the text', async () => {
    const writeText = vi.fn(async () => {})
    const fallback = fakeDocument(true)
    await writeClipboard('abc', { clipboard: { writeText }, document: fallback.document })
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(fallback.execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the Clipboard API refuses or is missing', async () => {
    const fallback = fakeDocument(true)
    await writeClipboard('abc', { clipboard: { writeText: refuse }, document: fallback.document })
    expect(fallback.execCommand).toHaveBeenCalledWith('copy')
    expect(fallback.areas).toMatchObject([{ value: 'abc', removed: true }])

    const insecure = fakeDocument(true)
    await writeClipboard('def', { clipboard: undefined, document: insecure.document })
    expect(insecure.areas).toMatchObject([{ value: 'def', removed: true }])
  })

  it('rejects when both the Clipboard API and execCommand refuse', async () => {
    const blocked = fakeDocument(false)
    await expect(writeClipboard('abc', { clipboard: { writeText: refuse }, document: blocked.document })).rejects.toThrow('refused')
    expect(blocked.areas).toMatchObject([{ removed: true }])

    const throwing = fakeDocument('throw')
    await expect(writeClipboard('abc', { clipboard: undefined, document: throwing.document })).rejects.toThrow('refused')
    await expect(writeClipboard('abc', { clipboard: undefined, document: undefined })).rejects.toThrow('refused')
  })
})
