import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Paths of repository files read by unit tests (shared corpora, schemas, .env.example, docs).

export function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url))
}

export function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8')
}

export function repoFileExists(relative: string): boolean {
  return existsSync(repoPath(relative))
}

/** The `KEY=VALUE` lines of .env.example (comments and blank lines skipped). */
export function envExample(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of readRepoFile('.env.example').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (match) values[match[1]!] = match[2]!
  }
  return values
}
