import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { env } from './env'

// The static compose and `.env.example` rules for security/compose-lint.spec.ts and security/env-example.spec.ts
// (docs/testing.md §11, §14 decision 12): the specs are thin wrappers over the rule functions of
// tests/scripts/lint-compose.mjs and tests/scripts/lint-env.mjs, run against the checkout and against throwaway
// copies of the inputs with one rule broken each, so every rule is shown to fail.

export interface ComposeLintModule {
  lintCompose(repo: string): string[]
  INFRASTRUCTURE_SERVICES: string[]
}

export interface EnvEntry {
  value: string
  comment: string
  line: number
}

export interface EnvLintModule {
  lintEnv(repo: string): string[]
  parseEnvExample(text: string): Map<string, EnvEntry>
  variablesReadByCode(repo: string): Map<string, string>
  NOT_CONFIGURATION: Set<string>
}

/** Imports a script of tests/scripts by URL: the scripts are plain ESM without type declarations. */
async function loadScript<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(join(env.paths.tests, 'scripts', name)).href)) as T
}

export const loadComposeLint = () => loadScript<ComposeLintModule>('lint-compose.mjs')
export const loadEnvLint = () => loadScript<EnvLintModule>('lint-env.mjs')

/** The compose files lint-compose reads, relative to the repository root. */
export const COMPOSE_FILES = ['docker-compose.dev.yml', 'docker-compose.prod.yml', 'docker-compose.tests.yml', 'tests/docker/stack.tests.yml']

/** Inputs of lint-env that a negative case may change (copied); the Go and orchestrator sources are linked. */
export const ENV_LINT_FILES = [
  '.env.example',
  'justfile',
  'docker-compose.dev.yml',
  'docker-compose.prod.yml',
  'docker-compose.tests.yml',
  'tests/docker/stack.tests.yml',
  'tests/docker/stack.env',
  'tests/helpers/env.ts',
  'orchestrator/server/utils/config.ts',
]

/** A throwaway copy of some repository files; `edit` rewrites one of them. Remove it with `dispose`. */
export class RepoCopy {
  private constructor(readonly root: string) {}

  static async create(files: string[], links: string[] = []): Promise<RepoCopy> {
    const root = await mkdtemp(join(tmpdir(), 'scantor-lint-'))
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await copyFile(join(env.paths.repo, file), join(root, file))
    }
    for (const link of links) {
      await mkdir(dirname(join(root, link)), { recursive: true })
      await symlink(join(env.paths.repo, link), join(root, link))
    }
    return new RepoCopy(root)
  }

  async read(file: string): Promise<string> {
    return readFile(join(this.root, file), 'utf8')
  }

  async write(file: string, content: string): Promise<void> {
    await mkdir(dirname(join(this.root, file)), { recursive: true })
    await writeFile(join(this.root, file), content)
  }

  /** Replaces exactly one occurrence of `search` in a copied file; fails when it is missing, so the case stays real. */
  async replace(file: string, search: string | RegExp, replacement: string): Promise<void> {
    const text = await this.read(file)
    const matches =
      typeof search === 'string' ? text.split(search).length - 1 : (text.match(new RegExp(search.source, `${search.flags.replace('g', '')}g`)) ?? []).length
    if (matches !== 1) throw new Error(`${file}: expected exactly one match of ${String(search)}, found ${matches}`)
    await this.write(
      file,
      text.replace(search, () => replacement),
    )
  }

  async append(file: string, text: string): Promise<void> {
    const current = await this.read(file)
    await this.write(file, `${current.endsWith('\n') ? current : `${current}\n`}${text}\n`)
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }
}
