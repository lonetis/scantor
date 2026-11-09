import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pack as tarPack } from 'tar-stream'

// The runtime injection tar that test-run and script-run containers receive by CopyToContainer at `/` (docs/runtime.md
// §3.1, docs/scripts.md §6.4): `scantor/` (0755) and `scantor/scantor` (0755, the runtime binary), then the caller's
// own entries, all owned by 0:0 with mtime 0. Entries stream; nothing is buffered whole. Destroying the returned stream
// (an aborted CopyToContainer) also closes the file or upload stream being copied.

const OWNER = { uid: 0, gid: 0, uname: '', gname: '', mtime: new Date(0) }

/** Adds entries after the runtime binary. */
export interface InjectionEntries {
  directory(name: string, mode: number): void
  file(name: string, mode: number, content: string): void
  /** Streams `source` as one file entry of exactly `size` bytes. */
  copy(source: Readable, header: { name: string; mode: number; size: number }): Promise<void>
}

export function runtimeInjectionArchive(binaryPath: string, more?: (entries: InjectionEntries) => Promise<void>): Readable {
  const pack = tarPack()
  const entries: InjectionEntries = {
    directory: (name, mode) => pack.entry({ name, type: 'directory', mode, ...OWNER }),
    file: (name, mode, content) => pack.entry({ name, type: 'file', mode, ...OWNER }, content),
    copy: async (source, header) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const entry = pack.entry({ ...header, type: 'file', ...OWNER }, (error) => (error ? reject(error) : resolve()))
          source.on('error', reject).pipe(entry)
        })
      } finally {
        // A destroyed pack only unpipes the source; an open S3 response would otherwise stay paused.
        source.destroy()
      }
    },
  }
  const run = async () => {
    const binary = await stat(binaryPath)
    entries.directory('scantor/', 0o755)
    await entries.copy(createReadStream(binaryPath), { name: 'scantor/scantor', mode: 0o755, size: binary.size })
    await more?.(entries)
    pack.finalize()
  }
  run().catch((error: unknown) => pack.destroy(error as Error))
  return Readable.from(pack)
}
