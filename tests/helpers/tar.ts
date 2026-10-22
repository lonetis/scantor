import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import tar, { type Header } from 'tar-stream'
import { env } from './env'

// Hostile upload archives from corpora/tar-slip/cases.json (docs/testing.md §7.8, docs/security.md WS-3): traversal,
// absolute names, links, devices, FIFOs, too many files, gzip bombs. The corpus is shared with the Go and vitest unit
// tests, which run every case; e2e specs send one sample per rule through uploadTask. `buildCaseArchive` supports the
// tar.gz cases; zip cases and names that JavaScript strings cannot carry (`nameBase64`) are refused with an error.

export interface TarEntry {
  name?: string
  nameBase64?: string
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'char' | 'block' | 'fifo'
  content?: string
  zeros?: number
  random?: number
  mode?: number
  linkname?: string
  devmajor?: number
  devminor?: number
  generate?: { prefix: string; count: number; content?: string }
  globalPax?: Record<string, string>
}

export interface TarCase {
  id: string
  description: string
  format?: 'tar.gz' | 'zip'
  raw?: string
  entries?: TarEntry[]
  workspace?: TarEntry[]
  limits?: Record<string, number>
  expect: { ok: boolean; code?: string; path?: string; tree?: unknown }
}

export interface TarCorpus {
  version: number
  manifest: string
  cases: TarCase[]
}

export function loadTarCorpus(): TarCorpus {
  return JSON.parse(readFileSync(join(env.paths.tests, 'corpora', 'tar-slip', 'cases.json'), 'utf8')) as TarCorpus
}

const TYPES: Record<NonNullable<TarEntry['type']>, Header['type']> = {
  file: 'file',
  dir: 'directory',
  symlink: 'symlink',
  hardlink: 'link',
  char: 'character-device',
  block: 'block-device',
  fifo: 'fifo',
}

function content(entry: TarEntry): Buffer {
  if (entry.content !== undefined) return Buffer.from(entry.content, 'utf8')
  if (entry.zeros !== undefined) return Buffer.alloc(entry.zeros)
  if (entry.random !== undefined) return randomBytes(entry.random)
  return Buffer.alloc(0)
}

/** Expands `generate` entries into their files. */
function expand(entries: TarEntry[]): TarEntry[] {
  return entries.flatMap((entry) =>
    entry.generate
      ? Array.from({ length: entry.generate.count }, (_, i) => ({
          name: `${entry.generate!.prefix}${i}`,
          type: 'file' as const,
          content: entry.generate!.content ?? '',
        }))
      : [entry],
  )
}

/** A tar.gz of the entries (tar-stream writes PAX path records for long names). */
export async function buildTarGz(entries: TarEntry[]): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve)
    pack.on('error', reject)
  })
  for (const entry of expand(entries)) {
    if (entry.nameBase64 !== undefined) throw new Error('entries with nameBase64 are not supported by helpers/tar.ts')
    const type = entry.type ?? 'file'
    const body = type === 'file' ? content(entry) : Buffer.alloc(0)
    const header: Parameters<typeof pack.entry>[0] = {
      name: entry.name ?? '',
      type: TYPES[type],
      mode: entry.mode ?? (type === 'dir' ? 0o755 : 0o644),
      size: body.length,
      mtime: new Date(0),
      ...(entry.linkname !== undefined ? { linkname: entry.linkname } : {}),
      ...(entry.devmajor !== undefined ? { devmajor: entry.devmajor } : {}),
      ...(entry.devminor !== undefined ? { devminor: entry.devminor } : {}),
      ...(entry.globalPax !== undefined ? { pax: entry.globalPax } : {}),
    }
    await new Promise<void>((resolve, reject) => pack.entry(header, body, (error) => (error ? reject(error) : resolve())))
  }
  pack.finalize()
  await done
  return gzipSync(Buffer.concat(chunks))
}

/** The upload archive of a corpus case: its literal `raw` bytes or the tar.gz of its entries. */
export async function buildCaseArchive(testCase: TarCase): Promise<Buffer> {
  if (testCase.raw !== undefined) return Buffer.from(testCase.raw, 'utf8')
  if (testCase.format === 'zip') throw new Error(`case ${testCase.id}: zip archives are not supported by helpers/tar.ts`)
  return buildTarGz(testCase.entries ?? [])
}
