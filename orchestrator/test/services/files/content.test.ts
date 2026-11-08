import { createHash } from 'node:crypto'
import { NoSuchKey, S3ServiceException } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { FILE_CONTENT_MAX_BYTES } from '#shared/schemas/analyses'
import type { FileRefDoc } from '../../../server/types/documents'
import {
  encodeFileContent,
  FILE_CONTENT_MAX_JSON_BYTES,
  findStoredFile,
  readStoredFileContent,
  type StoredFile,
  textPage,
  trimPartialRune,
} from '../../../server/services/files/content'

// Inline reads of stored files (docs/api.md §4.15, security.md DL-6): byte ranges of S3 objects as UTF-8 text or
// base64, paged with offset and nextOffset. The S3 range read is replaced by a reader over an in-memory buffer.

const KEY = 'files/scan/0/exec/file/report.txt'

function stored(data: Buffer, name = 'report.txt'): StoredFile {
  return { key: KEY, name, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), contentType: 'text/plain' }
}

/** A RangeReader over `data` that records the requested ranges. */
function readerOf(data: Buffer) {
  return vi.fn(async (key: string, start: number, endInclusive: number) => {
    expect(key).toBe(KEY)
    return data.subarray(start, endInclusive + 1)
  })
}

async function read(data: Buffer, range: { offset?: number; length?: number } = {}) {
  const reader = readerOf(data)
  return { page: await readStoredFileContent(stored(data), range, reader), reader }
}

/** Reads the whole file page by page and returns the decoded bytes and the pages. */
async function readAll(data: Buffer, length?: number) {
  const reader = readerOf(data)
  const parts: Buffer[] = []
  const pages = []
  let offset = 0
  for (;;) {
    const page = await readStoredFileContent(stored(data), { offset, length }, reader)
    pages.push(page)
    parts.push(Buffer.from(page.content, page.encoding === 'utf8' ? 'utf8' : 'base64'))
    expect(Buffer.concat(parts).length).toBe(page.offset + page.length)
    if (!page.truncated) break
    expect(page.nextOffset).toBe(page.offset + page.length)
    offset = page.nextOffset!
  }
  return { bytes: Buffer.concat(parts), pages }
}

describe('readStoredFileContent', () => {
  it('returns a whole text file as utf8 with its metadata', async () => {
    const data = Buffer.from('schema-zoo zoo\n')
    const { page, reader } = await read(data)
    expect(page).toEqual({
      name: 'report.txt',
      contentType: 'text/plain',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      offset: 0,
      length: data.length,
      encoding: 'utf8',
      content: 'schema-zoo zoo\n',
      truncated: false,
      nextOffset: null,
    })
    expect(reader).toHaveBeenCalledExactlyOnceWith(KEY, 0, data.length - 1)
  })

  it('returns binary data, data with NUL and invalid UTF-8 as base64', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    for (const data of [png, Buffer.from('text\0with a NUL'), Buffer.from([0x61, 0xff, 0x62]), Buffer.from([0x61, 0xc3])]) {
      const { page } = await read(data)
      expect(page).toMatchObject({ encoding: 'base64', content: data.toString('base64'), length: data.length, truncated: false, nextOffset: null })
    }
  })

  it('reads the byte range offset … offset+length and pages with nextOffset', async () => {
    const data = Buffer.from('0123456789abcdef')
    const { page, reader } = await read(data, { offset: 4, length: 5 })
    expect(page).toMatchObject({ offset: 4, length: 5, content: '45678', encoding: 'utf8', truncated: true, nextOffset: 9, size: 16 })
    expect(reader).toHaveBeenCalledExactlyOnceWith(KEY, 4, 8)

    const last = await read(data, { offset: 12, length: 10 })
    expect(last.page).toMatchObject({ offset: 12, length: 4, content: 'cdef', truncated: false, nextOffset: null })
    expect(last.reader).toHaveBeenCalledExactlyOnceWith(KEY, 12, 15)

    const { bytes, pages } = await readAll(data, 3)
    expect(bytes.equals(data)).toBe(true)
    expect(pages.map((p) => p.offset)).toEqual([0, 3, 6, 9, 12, 15])
  })

  it('reads at most FILE_CONTENT_MAX_BYTES by default and never more', async () => {
    const data = Buffer.alloc(FILE_CONTENT_MAX_BYTES * 2 + 10, 'a')
    const { page, reader } = await read(data)
    expect(page).toMatchObject({ offset: 0, length: FILE_CONTENT_MAX_BYTES, truncated: true, nextOffset: FILE_CONTENT_MAX_BYTES })
    expect(reader).toHaveBeenCalledExactlyOnceWith(KEY, 0, FILE_CONTENT_MAX_BYTES - 1)
    const clamped = await read(data, { offset: 5, length: FILE_CONTENT_MAX_BYTES * 3 })
    expect(clamped.reader).toHaveBeenCalledExactlyOnceWith(KEY, 5, 5 + FILE_CONTENT_MAX_BYTES - 1)
    const { bytes, pages } = await readAll(data)
    expect(bytes.equals(data)).toBe(true)
    expect(pages).toHaveLength(3)
  })

  it('trims a character cut by the end of the range, and the next page starts with it', async () => {
    const data = Buffer.from('héllo wörld 😀!')
    const first = await read(data, { length: 2 })
    expect(first.page).toMatchObject({ content: 'h', length: 1, encoding: 'utf8', truncated: true, nextOffset: 1 })
    const second = await read(data, { offset: 1, length: 2 })
    expect(second.page).toMatchObject({ content: 'é', length: 2, nextOffset: 3 })

    for (const length of [1, 2, 3, 4, 5, 7]) {
      const { bytes, pages } = await readAll(data, length)
      expect(bytes.equals(data), `length ${length}`).toBe(true)
      // Pages of 4 bytes or more are always text; shorter ones only fall back to base64 to make progress.
      if (length >= 4)
        expect(
          pages.every((p) => p.encoding === 'utf8'),
          `length ${length}`,
        ).toBe(true)
    }
  })

  it('returns a read shorter than one character as base64, so it still makes progress', async () => {
    const data = Buffer.from('😀 smile')
    const { page } = await read(data, { length: 3 })
    expect(page).toMatchObject({ encoding: 'base64', content: data.subarray(0, 3).toString('base64'), length: 3, truncated: true, nextOffset: 3 })
  })

  it('treats a range that starts inside a character as binary', async () => {
    const data = Buffer.from('héllo')
    const { page } = await read(data, { offset: 2 })
    expect(page).toMatchObject({ encoding: 'base64', content: data.subarray(2).toString('base64'), length: 4, truncated: false })
  })

  it('returns an empty page for an empty file and for offset equal to the size, without reading S3', async () => {
    for (const [data, offset] of [
      [Buffer.alloc(0), 0],
      [Buffer.from('abc'), 3],
    ] as const) {
      const { page, reader } = await read(data, { offset })
      expect(page).toMatchObject({ offset, length: 0, encoding: 'utf8', content: '', truncated: false, nextOffset: null, size: data.length })
      expect(reader).not.toHaveBeenCalled()
    }
  })

  it('rejects an offset beyond the end of the file with 400 validationFailed', async () => {
    const data = Buffer.from('abc')
    const reader = readerOf(data)
    await expect(readStoredFileContent(stored(data), { offset: 4 }, reader)).rejects.toMatchObject({
      code: 'validationFailed',
      statusCode: 400,
      details: { issues: [{ path: 'offset', message: 'must be at most 3 (the file size)' }] },
    })
    expect(reader).not.toHaveBeenCalled()
  })

  it('answers 404 notFound when the object is gone and passes other S3 failures on', async () => {
    const file = stored(Buffer.from('abc'))
    const gone = vi.fn(async () => {
      throw new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: 'The specified key does not exist.' })
    })
    await expect(readStoredFileContent(file, {}, gone)).rejects.toMatchObject({ code: 'notFound', statusCode: 404 })
    const broken = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(readStoredFileContent(file, {}, broken)).rejects.toThrow('connect ECONNREFUSED')
  })

  it('answers 404 notFound when the stored object is shorter than the file size, so paging never stalls', async () => {
    const data = Buffer.from('0123456789')
    const file: StoredFile = { ...stored(data), size: 20 }
    await expect(readStoredFileContent(file, {}, readerOf(data))).rejects.toMatchObject({ code: 'notFound', statusCode: 404 })
    // An empty body for a non-empty range would otherwise be a page with nextOffset equal to offset.
    await expect(readStoredFileContent(file, { offset: 10 }, readerOf(data))).rejects.toMatchObject({ code: 'notFound', statusCode: 404 })
    const unsatisfiable = vi.fn(async () => {
      throw new S3ServiceException({
        name: 'InvalidRange',
        $fault: 'client',
        $metadata: { httpStatusCode: 416 },
        message: 'The requested range is not satisfiable',
      })
    })
    await expect(readStoredFileContent(file, { offset: 15 }, unsatisfiable)).rejects.toMatchObject({ code: 'notFound', statusCode: 404 })
  })

  it('shortens text whose JSON escaping would exceed FILE_CONTENT_MAX_JSON_BYTES and pages through the rest', async () => {
    // Control characters escape to six bytes (\u0001), quotes and backslashes to two.
    const control = Buffer.alloc(FILE_CONTENT_MAX_BYTES, 0x01)
    const { page } = await read(control)
    expect(page).toMatchObject({ encoding: 'utf8', length: FILE_CONTENT_MAX_JSON_BYTES / 6, truncated: true, nextOffset: FILE_CONTENT_MAX_JSON_BYTES / 6 })
    expect(Buffer.byteLength(JSON.stringify(page.content))).toBeLessThanOrEqual(FILE_CONTENT_MAX_JSON_BYTES + 2)

    const quotes = Buffer.alloc(FILE_CONTENT_MAX_BYTES, '"')
    expect((await read(quotes)).page).toMatchObject({ length: FILE_CONTENT_MAX_BYTES, truncated: false })

    // The budget ends six bytes into two 4-byte characters: the page ends after the first one.
    const mixed = Buffer.concat([Buffer.alloc(FILE_CONTENT_MAX_JSON_BYTES / 6 - 1, 0x01), Buffer.from('😀😀')])
    const cut = (await read(mixed)).page
    expect(cut.encoding).toBe('utf8')
    expect(Buffer.from(cut.content, 'utf8').length).toBe(cut.length)
    expect(cut.length).toBe(FILE_CONTENT_MAX_JSON_BYTES / 6 - 1 + 4)
    expect(cut.content.endsWith('😀')).toBe(true)
    const { bytes } = await readAll(Buffer.concat([control, mixed]))
    expect(bytes.equals(Buffer.concat([control, mixed]))).toBe(true)
  })
})

describe('textPage', () => {
  it('keeps a range that ends the file only when it is complete UTF-8', () => {
    expect(textPage(Buffer.from([0x61, 0xe2, 0x82]), false)?.toString()).toBe('a')
    expect(textPage(Buffer.from([0x61, 0xe2, 0x82]), true)).toBeNull()
    expect(textPage(Buffer.alloc(0), true)?.length).toBe(0)
  })
})

describe('trimPartialRune', () => {
  it.each([
    ['ascii', [0x61, 0x62], [0x61, 0x62]],
    ['complete 2-byte', [0x61, 0xc3, 0xa9], [0x61, 0xc3, 0xa9]],
    ['cut 2-byte', [0x61, 0xc3], [0x61]],
    ['cut 3-byte after 1', [0x61, 0xe2], [0x61]],
    ['cut 3-byte after 2', [0x61, 0xe2, 0x82], [0x61]],
    ['complete 3-byte', [0xe2, 0x82, 0xac], [0xe2, 0x82, 0xac]],
    ['cut 4-byte after 3', [0x61, 0xf0, 0x9f, 0x98], [0x61]],
    ['complete 4-byte', [0xf0, 0x9f, 0x98, 0x80], [0xf0, 0x9f, 0x98, 0x80]],
    ['invalid lead byte', [0x61, 0xff], [0x61, 0xff]],
    ['only continuation bytes', [0x80, 0x80, 0x80], [0x80, 0x80, 0x80]],
    ['empty', [], []],
  ])('%s', (_name, input, expected) => {
    expect([...trimPartialRune(Buffer.from(input))]).toEqual(expected)
  })
})

describe('encodeFileContent', () => {
  it('sets truncated and nextOffset from the returned bytes', () => {
    const file = { name: 'a.txt', size: 10, sha256: 'x', contentType: 'text/plain' }
    expect(encodeFileContent(file, 7, Buffer.from('abc'))).toMatchObject({ length: 3, truncated: false, nextOffset: null })
    expect(encodeFileContent(file, 2, Buffer.from('abc'))).toMatchObject({ length: 3, truncated: true, nextOffset: 5 })
  })
})

describe('findStoredFile', () => {
  const files: FileRefDoc[] = [
    { id: 'f1', name: 'a.txt', size: 1, sha256: 's1', contentType: 'text/plain', key: 'files/k1' },
    { id: 'f2', name: 'b.txt', size: 2, sha256: 's2', contentType: 'text/plain' },
  ]

  it('returns the FileRef with its stored key', () => {
    expect(findStoredFile(files, 'f1')).toEqual({ name: 'a.txt', size: 1, sha256: 's1', contentType: 'text/plain', key: 'files/k1' })
  })

  it('is 404 notFound for an unknown file, a FileRef without a stored object and an analysis without files', () => {
    for (const [list, id] of [
      [files, 'f3'],
      [files, 'f2'],
      [undefined, 'f1'],
    ] as const) {
      expect(() => findStoredFile(list, id)).toThrow(expect.objectContaining({ code: 'notFound', statusCode: 404 }))
    }
  })
})
