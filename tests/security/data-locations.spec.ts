import { randomUUID } from 'node:crypto'
import { CONTAINERS, docker, stackEnv } from '../helpers/docker'
import { expect, test } from '../fixtures'

// Data locations (docs/deployment.md §5.1): the test stack keeps the registry and the workspaces in host directories of
// the runner (tests/docker/stack.env) and every other service in its named volume. The runner's dockerd binds runner
// paths, so a throwaway container shows what a directory holds.

const IMAGE = 'scantor:dev'

interface Mount {
  Type: string
  Name?: string
  Source: string
  Destination: string
}

async function mounts(container: string): Promise<Mount[]> {
  const { stdout } = await docker(['inspect', '--format', '{{json .Mounts}}', container])
  return JSON.parse(stdout) as Mount[]
}

async function volumeOptions(volume: string): Promise<Record<string, string>> {
  const { stdout } = await docker(['volume', 'inspect', '--format', '{{json .Options}}', volume])
  return (JSON.parse(stdout) as Record<string, string> | null) ?? {}
}

/** The entries of a host directory of the runner. */
async function listHostDirectory(path: string): Promise<string[]> {
  const { stdout } = await docker(['run', '--rm', '--label', 'scantor.test=true', '--entrypoint', 'ls', '-v', `${path}:/data:ro`, IMAGE, '-A', '/data'])
  return stdout.split('\n').filter(Boolean)
}

test.describe('data locations', () => {
  // No session is needed: the checks read Docker only.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('a service keeps its data in the host directory of its variable, the others in their volumes', { tag: ['@OPS-009'] }, async () => {
    const path = stackEnv().SCANTOR_REGISTRY_DATA!
    expect(path, 'stack.env sets SCANTOR_REGISTRY_DATA to a host path').toMatch(/^\//)
    expect(await mounts(CONTAINERS.registry)).toContainEqual(expect.objectContaining({ Type: 'bind', Source: path, Destination: '/var/lib/registry' }))
    expect(await mounts(CONTAINERS.mongo)).toContainEqual(expect.objectContaining({ Type: 'volume', Name: 'scantor-mongo-data', Destination: '/data/db' }))
    expect(await mounts(CONTAINERS.rustfs)).toContainEqual(expect.objectContaining({ Type: 'volume', Name: 'scantor-rustfs-data', Destination: '/data' }))

    const probe = `.scantor-test-${randomUUID()}`
    await docker(['exec', CONTAINERS.registry, 'touch', `/var/lib/registry/${probe}`])
    try {
      expect(await listHostDirectory(path)).toContain(probe)
    } finally {
      await docker(['exec', CONTAINERS.registry, 'rm', '-f', `/var/lib/registry/${probe}`])
    }
  })

  test('the orchestrator binds scantor-workspaces to the directory of SCANTOR_WORKSPACES_DATA', { tag: ['@OPS-009'] }, async () => {
    const path = stackEnv().SCANTOR_WORKSPACES_DATA!
    expect(path, 'stack.env sets SCANTOR_WORKSPACES_DATA to a host path').toMatch(/^\//)
    expect(await volumeOptions('scantor-workspaces')).toEqual({ type: 'none', o: 'bind', device: path })
    expect(await volumeOptions('scantor-editor-home'), 'SCANTOR_EDITOR_HOME_DATA keeps its default').toEqual({})

    const probe = `.scantor-test-${randomUUID()}`
    const inVolume = ['run', '--rm', '--label', 'scantor.test=true', '--mount', 'type=volume,src=scantor-workspaces,dst=/w', '--entrypoint']
    await docker([...inVolume, 'touch', IMAGE, `/w/${probe}`])
    try {
      expect(await listHostDirectory(path)).toContain(probe)
    } finally {
      await docker([...inVolume, 'rm', IMAGE, '-f', `/w/${probe}`])
    }
  })
})
