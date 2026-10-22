import type { APIRequestContext } from '@playwright/test'
import { env } from './env'

// The fixtures server of the test stack (tests/docker/fixtures, docs/testing.md §7.9): Tranco and CrUX fakes on
// http://fixtures.<domain>:8089 and read-only git repositories on https://git.<domain> (through Traefik with the test
// CA). Pull tests copy a repository per test and move the copy's main branch through the control API.

export const FIXTURES_URL = `http://fixtures.${env.domain}:8089`
export const GIT_URL = `https://git.${env.domain}`

/** The repositories the image ships (tests/docker/fixtures/build-repos.sh). */
export const GIT_REPOS = {
  /** one task at the root: git-single */
  single: `${GIT_URL}/single.git`,
  /** two tasks in alpha/ (git-multi-alpha) and beta/ (git-multi-beta) */
  multi: `${GIT_URL}/multi.git`,
  /** one task (git-private) behind Basic auth with PRIVATE_GIT_CREDENTIAL */
  private: `${GIT_URL}/private.git`,
  /** main = git-diverge; branches "advanced" (a fast-forward) and "rewritten" (a divergence) */
  diverge: `${GIT_URL}/diverge.git`,
} as const

/** The Basic-auth credential of the private repositories (tests/docker/fixtures/main.go has the same values). */
export const PRIVATE_GIT_CREDENTIAL = { username: 'scantor-test', token: 'fixtures-token' } as const

/** Copies a repository for one test; returns the copy's clone URL. Copies of private repositories stay private. */
export async function copyGitRepo(request: APIRequestContext, from: keyof typeof GIT_REPOS): Promise<string> {
  const response = await request.post(`${FIXTURES_URL}/control/repos`, { data: { from } })
  if (response.status() !== 201) throw new Error(`copying the ${from} repository failed: ${response.status()} ${await response.text()}`)
  const { name } = (await response.json()) as { name: string }
  return `${GIT_URL}/${name}.git`
}

/** Points the main branch of a copied repository at another branch ("advanced" or "rewritten"). */
export async function moveGitMain(request: APIRequestContext, repoUrl: string, branch: string): Promise<void> {
  const name = new URL(repoUrl).pathname.replace(/^\//, '').replace(/\.git$/, '')
  const response = await request.post(`${FIXTURES_URL}/control/repos/${name}/main`, { data: { branch } })
  if (response.status() !== 204) throw new Error(`moving main of ${name} failed: ${response.status()} ${await response.text()}`)
}
