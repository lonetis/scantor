import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as playwrightRequest } from '@playwright/test'
import type { Revision } from '#shared/types/revisions'
import { ApiClient, ok } from '../helpers/api-client'
import { CONTAINERS, docker, stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { ThrowawayOrchestrator } from '../helpers/orchestrator'
import { containerImage, copyImageInto, inspectWorker, waitForRunningWorker } from '../helpers/security'
import { fixtureTaskDir, packTask, waitForRevision } from '../helpers/tasks'
import { SMALL_SETTINGS } from '../helpers/scans'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// Container labels and Traefik route hijack (docs/security.md §6.1 LBL-1…LBL-4): forbidden LABEL keys are rejected
// statically, labels inherited from a base image fail the build, and even an image carrying Traefik and compose labels
// (pushed with the orchestrator credential and swapped into a ready revision, white-box) runs with the managed label
// values, so Traefik never routes to it.

const MANAGED = { 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed', 'com.docker.compose.service': '', 'scantor.managed': 'true' }

test.describe('hostile labels', () => {
  test('forbidden LABEL keys are rejected statically, literal, quoted, in any case and ARG-expanded', { tag: ['@SEC-005'] }, async ({ tasks }) => {
    test.setTimeout(180_000)
    // The hostile-label fixture: Traefik routing, compose project and an ARG-expanded scantor.* key.
    const { revision } = await tasks.fixture('hostile-label', { expectState: 'failed' })
    expectD9(revision, [5, 6, 8])

    // More spellings in one Dockerfile; every forbidden key is reported on its own line.
    const variants = [
      'ARG SCANTOR_BASE',
      'FROM ${SCANTOR_BASE}',
      'COPY . .',
      'LABEL Traefik.Http.Routers.x.Rule="Host(`scantor.localhost`)"',
      'LABEL "com.docker.compose.service"="orchestrator"',
      'LABEL "SCANTOR.KIND"=worker',
      'ARG K=traefik.enable',
      'LABEL $K=true',
      'LABEL org.opencontainers.image.title="allowed"',
      '',
    ].join('\n')
    const dir = await mkdtemp(join(tmpdir(), 'labels-'))
    try {
      for (const file of await readdir(fixtureTaskDir('hostile-label'))) {
        if (file === 'Dockerfile') await writeFile(join(dir, file), variants)
        else await copyFile(join(fixtureTaskDir('hostile-label'), file), join(dir, file))
      }
      const { revision: variant } = await tasks.upload(dir, { expectState: 'failed' })
      expectD9(variant, [4, 5, 6, 8])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(
    'an image with Traefik and compose labels swapped into a ready revision runs with the managed labels and gets no route',
    { tag: ['@SEC-008', '@SEC-007'] },
    async ({ env, api, adminApi, docker: inner, shared, scans }) => {
      test.setTimeout(180_000)
      const { task, revision } = await shared.probe()
      const image = revision.image!
      const port = stackEnv().SCANTOR_REGISTRY_PORT ?? '5000'
      const router = `hijack-${randomBytes(4).toString('hex')}`
      const tag = `localhost:${port}/${image.repository}:hostile-${randomBytes(4).toString('hex')}`
      const config = await mkdtemp(join(tmpdir(), 'docker-config-'))
      let pushedDigest: string | undefined
      try {
        // A pre-built image: the revision's own image plus labels that would route the dashboard host to it.
        const dockerfile = [
          `FROM localhost:${port}/${image.repository}@${image.digest}`,
          `LABEL traefik.enable="true" \\`,
          `  traefik.http.routers.${router}.rule="Host(\`${env.domain}\`)" \\`,
          `  traefik.http.routers.${router}.priority="2147483000" \\`,
          `  traefik.http.services.${router}.loadbalancer.server.port="8080" \\`,
          `  com.docker.compose.project="scantor" \\`,
          `  com.docker.compose.service="orchestrator" \\`,
          `  scantor.managed="false" scantor.kind="hostile" scantor.test="true"`,
          '',
        ].join('\n')
        // The orchestrator's registry credential (derived from the stack secret), as the task pipeline uses it.
        await docker(['--config', config, 'login', `localhost:${port}`, '-u', 'orchestrator', '--password-stdin'], {
          input: stackKeys().registryPushPassword(),
        })
        await docker(['--config', config, 'build', '-t', tag, '-'], { input: dockerfile, timeoutMs: 120_000 })
        const pushed = await docker(['--config', config, 'push', tag], { timeoutMs: 120_000 })
        pushedDigest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout)?.[1]
        expect(pushedDigest, pushed.stdout).toBeDefined()

        // White-box: the ready revision now points at the hostile image.
        await inner.mongosh(`db.revisions.updateOne({ _id: '${revision.id}' }, { $set: { 'image.digest': '${pushedDigest}' } })`, { as: 'root' })
        const scan = await scans.start({
          revision: revision.ref,
          taskConfig: { mode: 'hang' },
          settings: { ...SMALL_SETTINGS, timeoutMs: 170_000, maxAttempts: 1 },
        })
        expect(scan.revision.digest).toBe(pushedDigest)
        const worker = await waitForRunningWorker(api, scan.id, 'runner')
        const container = await inspectWorker(worker.id, 'builtin')
        expect(container.Config.Image).toContain(pushedDigest!)

        // The run-time labels win over the image's labels with the same key.
        expect(container.Config.Labels).toMatchObject({ ...MANAGED, 'scantor.kind': 'worker', 'scantor.worker': worker.id, 'scantor.scan': scan.id })
        expect(container.Config.Labels['scantor.test']).toBe('true')

        // Traefik has no router of the container, and the dashboard host still reaches the orchestrator.
        const adminId = ok(await adminApi.getAccount(), 'getAccount').id
        const now = Math.floor(Date.now() / 1000)
        const cookie = stackKeys().toolsCookie({ iss: 'scantor', aud: 'tools', sub: adminId, role: 'admin', iat: now, exp: now + 600, jti: randomUUID() })
        const bare = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
        try {
          for (let check = 0; check < 3; check++) {
            const routers = await bare.get(`https://traefik.${env.domain}/api/http/routers`, { headers: { Cookie: `scantor_tools=${cookie}` } })
            expect(routers.status()).toBe(200)
            const names = ((await routers.json()) as { name: string }[]).map((r) => r.name)
            expect(names.filter((name) => name.includes(router))).toEqual([])
            expect(names).toContain('scantor@docker')
            const health = await bare.get(`${env.publicUrl}/api/health`)
            expect(health.status()).toBe(200)
            expect(((await health.json()) as { status: string }).status).toBeDefined()
          }
        } finally {
          await bare.dispose()
        }
        expect(task.name).toBeTruthy()
      } finally {
        await inner.mongosh(`db.revisions.updateOne({ _id: '${revision.id}' }, { $set: { 'image.digest': '${image.digest}' } })`, { as: 'root' })
        if (pushedDigest) await deleteManifest(env.publicUrl, image.repository, pushedDigest)
        await docker(['rmi', '-f', tag], { allowFailure: true })
        await rm(config, { recursive: true, force: true })
      }
    },
  )

  test(
    'forbidden labels inherited from the base image pass the static check, fail the build and leave no image',
    { tag: ['@SEC-006'] },
    async ({ openapi, throwawayInfra: infra }) => {
      test.setTimeout(180_000)
      // A throwaway orchestrator on the worker's private Docker engine, whose base image carries a forbidden label, so the
      // shared stack's base images stay untouched. The images are removed from that engine again at the end.
      const engine = infra.docker.container
      const base = 'scantor-base-python:dev'
      const runtime = await containerImage(CONTAINERS.node)
      let orchestrator: ThrowawayOrchestrator | undefined
      try {
        await Promise.all([copyImageInto(runtime, engine), copyImageInto(base, engine)])
        await docker(['exec', '-i', engine, 'docker', 'build', '-t', base, '-'], {
          input: `FROM ${base}\nLABEL traefik.http.routers.inherited.rule="Host(\`example.test\`)"\n`,
          timeoutMs: 120_000,
        })

        const password = randomBytes(18).toString('base64url')
        orchestrator = await ThrowawayOrchestrator.start({
          name: 'labels',
          infra,
          env: { SCANTOR_ADMIN_EMAIL: 'labels@example.test', SCANTOR_ADMIN_PASSWORD: password },
        })
        await orchestrator.waitReady()
        const session = await orchestrator.context()
        expect((await session.post('/api/auth/sign-in/email', { data: { email: 'labels@example.test', password } })).status()).toBe(200)
        const api = new ApiClient(session, openapi)
        const uploaded = ok(await api.uploadTask(await packTask(fixtureTaskDir('netprobe'), { name: 'inherited' }), { publish: true, wait: 120 }), 'uploadTask')
        const revision: Revision = await waitForRevision(api, uploaded.task.id, uploaded.revision!.id, 150_000)
        expect(revision.state, JSON.stringify(revision.errors)).toBe('failed')
        expect(revision.errors).toHaveLength(1)
        expect(revision.errors[0]).toMatchObject({ phase: 'build', message: expect.stringContaining('traefik.http.routers.inherited.rule') })
        expect(revision.image).toBeNull()
        const images = await docker(['exec', engine, 'docker', 'images', '--format', '{{.Repository}}:{{.Tag}}'])
        expect(images.stdout.split('\n').filter((line) => line.includes(`tasks/${uploaded.task.id}`))).toEqual([])
      } finally {
        await orchestrator?.dispose()
        await docker(['exec', engine, 'docker', 'rmi', '-f', base, runtime], { allowFailure: true })
      }
    },
  )
})

/** Every error of the failed revision is a static D9 error on the Dockerfile, and each expected line has one. */
function expectD9(revision: Revision, lines: number[]): void {
  const label = JSON.stringify(revision.errors)
  expect(revision.state, label).toBe('failed')
  for (const error of revision.errors) expect(error, label).toMatchObject({ phase: 'static', file: 'Dockerfile', message: expect.stringMatching(/\(D9\)$/) })
  expect(
    [...new Set(revision.errors.map((error) => error.line))].sort((a, b) => (a ?? 0) - (b ?? 0)),
    label,
  ).toEqual(lines)
  expect(revision.image).toBeNull()
}

/** Deletes a manifest from the stack's registry with a token of the orchestrator credential. */
async function deleteManifest(publicUrl: string, repository: string, digest: string): Promise<void> {
  const context = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
  try {
    const basic = Buffer.from(`orchestrator:${stackKeys().registryPushPassword()}`).toString('base64')
    const token = await context.get(`${publicUrl}/api/registry/token`, {
      params: { service: 'scantor-registry', scope: `repository:${repository}:pull,delete` },
      headers: { Authorization: `Basic ${basic}` },
    })
    const bearer = ((await token.json()) as { token: string }).token
    const host = stackEnv().SCANTOR_REGISTRY_PUBLIC_HOST!
    const response = await context.delete(`https://${host}/v2/${repository}/manifests/${digest}`, { headers: { Authorization: `Bearer ${bearer}` } })
    if (![202, 404].includes(response.status())) throw new Error(`deleting ${repository}@${digest} answered ${response.status()}: ${await response.text()}`)
  } finally {
    await context.dispose()
  }
}
