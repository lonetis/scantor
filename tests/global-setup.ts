import { mkdir, writeFile } from 'node:fs/promises'
import { request } from '@playwright/test'
import type { Health } from '#shared/types/instance'
import type { ItemList } from '#shared/types/common'
import type { Node } from '#shared/types/nodes'
import { env } from './helpers/env'
import { verifyVectors } from './helpers/keys'
import { resetLocks } from './helpers/limiter'
import { signIn } from './helpers/users'

// Global setup (docs/testing.md §7.6). Fails loudly: every problem throws, nothing is swallowed, so a broken stack
// stops the run here instead of surfacing as hundreds of unrelated test failures.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHealth(): Promise<void> {
  const context = await request.newContext({ baseURL: env.publicUrl })
  try {
    const deadline = Date.now() + 120_000
    let last = 'no answer'
    for (;;) {
      try {
        const response = await context.get('/api/health')
        const body = (await response.json()) as Health
        if (response.ok() && body.status === 'ok') return
        last = `${response.status()} ${JSON.stringify(body)}`
      } catch (error) {
        last = String(error)
      }
      if (Date.now() > deadline) throw new Error(`${env.publicUrl}/api/health is not ok after 120 s: ${last}`)
      await sleep(2000)
    }
  } finally {
    await context.dispose()
  }
}

/**
 * Waits until the stand-in Cloudflare Tunnel (docs/testing.md §7.3) reaches the orchestrator as a tunnel request. The
 * orchestrator resolves `cloudflared` again after a tunnel request from an unknown peer at most every 5 s, so a stand-in
 * that started after its last lookup gets 421 for a few seconds.
 */
async function waitForTunnel(): Promise<void> {
  const context = await request.newContext({ baseURL: env.tunnelUrl })
  try {
    const deadline = Date.now() + 60_000
    let last = 'no answer'
    for (;;) {
      try {
        const response = await context.get('/api/health')
        if (response.ok() && ((await response.json()) as Health).status === 'ok') return
        last = `${response.status()} ${await response.text()}`
      } catch (error) {
        last = String(error)
      }
      if (Date.now() > deadline) throw new Error(`${env.tunnelUrl}/api/health is not ok through the stand-in tunnel after 60 s: ${last}`)
      await sleep(1000)
    }
  } finally {
    await context.dispose()
  }
}

export default async function globalSetup(): Promise<void> {
  const keyProblems = verifyVectors()
  if (keyProblems.length > 0) throw new Error(`helpers/keys.ts disagrees with corpora/keys-vectors.json:\n  ${keyProblems.join('\n  ')}`)

  await waitForHealth()
  await waitForTunnel()

  await mkdir(env.paths.auth, { recursive: true })
  await resetLocks()

  const admin = await request.newContext({ baseURL: env.publicUrl, extraHTTPHeaders: { Origin: env.publicUrl } })
  try {
    const signedIn = await signIn(admin, env.admin.email, env.admin.password)
    if (signedIn.status !== 200) throw new Error(`the seeded admin ${env.admin.email} cannot sign in: ${signedIn.status} ${signedIn.raw.toString('utf8')}`)
    await admin.storageState({ path: env.paths.adminState })

    const openapi = await admin.get('/api/docs/openapi.json')
    if (!openapi.ok()) throw new Error(`GET /api/docs/openapi.json answered ${openapi.status()}`)
    await writeFile(env.paths.openapi, await openapi.body())

    const nodes = await admin.get('/api/nodes')
    if (!nodes.ok()) throw new Error(`listNodes answered ${nodes.status()}: ${await nodes.text()}`)
    const items = ((await nodes.json()) as ItemList<Node>).items
    for (const name of ['builtin', 'remote-1']) {
      const node = items.find((n) => n.name === name)
      if (node?.state !== 'online') throw new Error(`node ${name} is ${node ? node.state : 'missing'}, expected online`)
    }
  } finally {
    await admin.dispose()
  }
}
