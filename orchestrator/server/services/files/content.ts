import { isUtf8 } from 'node:buffer'
import { FILE_CONTENT_MAX_BYTES } from '#shared/schemas/analyses'
import type { FileContent } from '#shared/types/exports'
import type { FileRefDoc } from '../../types/documents'
import { apiError, validationError } from '../../utils/errors'
import { getObjectRange, isS3InvalidRange, isS3NotFound } from '../../utils/s3'

// Inline reads of stored files (docs/api.md §4.15, security.md DL-6): one byte range of an S3 object returned as
// JSON, UTF-8 text or base64, for clients that cannot fetch a presigned URL (MCP agents above all). Every content
// route resolves the FileRef through its own ownership check and passes it here; the key always comes from the stored
// FileRef, never from the request.

/**
 * Most bytes of JSON-escaped text in one response. Base64 of a full page is 128 KiB; text whose escaped form would be
 * larger (quotes, backslashes and control characters grow up to sixfold) is returned shorter, so a page always fits
 * the 256 KiB MCP result cap without the bridge cutting the content.
 */
export const FILE_CONTENT_MAX_JSON_BYTES = 2 * FILE_CONTENT_MAX_BYTES

/** A FileRef whose object is stored (`key` set). */
export type StoredFile = Pick<FileRefDoc, 'name' | 'size' | 'sha256' | 'contentType'> & { key: string }

export interface ByteRange {
  /** first byte, default 0; at most the file size */
  offset?: number
  /** bytes to read, default and maximum FILE_CONTENT_MAX_BYTES */
  length?: number
}

/** Reads bytes `start`…`endInclusive` of an object (utils/s3.ts getObjectRange; replaced in unit tests). */
export type RangeReader = (key: string, start: number, endInclusive: number) => Promise<Buffer>

/** The FileRef `fileId` of `files` that has a stored object; 404 notFound otherwise. */
export function findStoredFile(files: readonly FileRefDoc[] | undefined, fileId: string): StoredFile {
  const file = (files ?? []).find((candidate) => candidate.id === fileId)
  if (!file?.key) throw apiError('notFound', 'file not found')
  return { name: file.name, size: file.size, sha256: file.sha256, contentType: file.contentType, key: file.key }
}

/**
 * One page of a stored file. `offset` beyond the file size is 400 validationFailed; `offset` equal to the size (and
 * an empty file) returns an empty page without reading S3. An object that is gone (an expired test-run file) is 404,
 * and so is one shorter than the FileRef size (a test-run file that changed while it was copied out): paging by the
 * declared size would otherwise return an empty page that never advances or end in an unsatisfiable range.
 */
export async function readStoredFileContent(file: StoredFile, range: ByteRange = {}, read: RangeReader = getObjectRange): Promise<FileContent> {
  const offset = range.offset ?? 0
  const length = Math.min(range.length ?? FILE_CONTENT_MAX_BYTES, FILE_CONTENT_MAX_BYTES)
  if (offset > file.size) {
    throw validationError([{ path: 'offset', message: `must be at most ${file.size} (the file size)` }], 'offset is beyond the end of the file')
  }
  const end = Math.min(offset + length, file.size)
  let bytes: Buffer = Buffer.alloc(0)
  if (end > offset) {
    try {
      bytes = await read(file.key, offset, end - 1)
    } catch (error) {
      if (isS3NotFound(error)) throw apiError('notFound', 'the content of the file is no longer stored')
      if (isS3InvalidRange(error)) throw incompleteContent()
      throw error
    }
    if (bytes.length !== end - offset) throw incompleteContent()
  }
  return encodeFileContent(file, offset, bytes)
}

function incompleteContent() {
  return apiError('notFound', 'the stored content of the file is shorter than its size')
}

/** The `FileContent` of the bytes read at `offset`: text when `textPage` accepts them, else base64 of all of them. */
export function encodeFileContent(file: Omit<StoredFile, 'key'>, offset: number, bytes: Buffer): FileContent {
  const text = textPage(bytes, offset + bytes.length >= file.size)
  const length = text ? text.length : bytes.length
  const truncated = offset + length < file.size
  return {
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256,
    offset,
    length,
    encoding: text ? 'utf8' : 'base64',
    content: text ? text.toString('utf8') : bytes.toString('base64'),
    truncated,
    nextOffset: truncated ? offset + length : null,
  }
}

/**
 * The part of a range returned as UTF-8 text, or null for base64. Like the workspace helper's detection
 * (internal/workspace/browse.go readContent), text is valid UTF-8 without NUL, judged here on the range alone: a
 * character cut by the end of a range that does not end the file is dropped (and read by the next page), and the page
 * is shortened on a character boundary until its JSON-escaped form fits FILE_CONTENT_MAX_JSON_BYTES. A range that would
 * lose every byte this way (a read of fewer bytes than one character) is base64, so every read makes progress.
 */
export function textPage(bytes: Buffer, endsFile: boolean): Buffer | null {
  if (bytes.includes(0)) return null
  const text = endsFile ? bytes : trimPartialRune(bytes)
  if (text.length === 0 ? bytes.length > 0 : !isUtf8(text)) return null
  const fitting = jsonEscapedPrefix(text, FILE_CONTENT_MAX_JSON_BYTES)
  return fitting === text.length ? text : trimPartialRune(text.subarray(0, fitting))
}

/** Drops an incomplete UTF-8 sequence at the end of `bytes` (Go `trimPartialRune` of internal/workspace/browse.go). */
export function trimPartialRune(bytes: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    return back < sequenceLength(byte) ? bytes.subarray(0, bytes.length - back) : bytes
  }
  return bytes
}

/** The length of the UTF-8 sequence a lead byte starts; 1 for ASCII and for bytes that start no valid sequence. */
function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 1
}

const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/** The longest prefix of UTF-8 `bytes` whose JSON string escaping (as JSON.stringify writes it) has at most `budget` bytes. */
function jsonEscapedPrefix(bytes: Buffer, budget: number): number {
  let size = 0
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!
    size += byte === 0x22 || byte === 0x5c ? 2 : byte >= 0x20 ? 1 : SHORT_ESCAPES.has(byte) ? 2 : 6
    if (size > budget) return index
  }
  return bytes.length
}
