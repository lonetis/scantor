import { describe, expect, it } from 'vitest'
import { helperContainerSpec, helperMountFor } from '../../../server/services/helpers/spec'
import { EXCLUSIVE_OPS, HELPER_OPS, type HelperOp } from '../../../server/services/helpers/types'

// The helper container profile per operation (docs/editor.md §9.2, security.md WS-2).

const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const ID = '11111111-2222-4333-8444-555555555555'

function spec(op: HelperOp, args: string[] = [], network: 'none' | 'egress' = 'none', env: Record<string, string> = {}) {
  return helperContainerSpec({
    op,
    userId: USER,
    args,
    network,
    mount: helperMountFor(op, args),
    env,
    image: 'scantor:dev',
    memoryBytes: 512 * 1024 ** 2,
    pidsLimit: 256,
    id: ID,
  })
}

describe('helper container spec', () => {
  it.each(HELPER_OPS.filter((op) => op !== 'init' && op !== 'purge'))('%s runs as 1000:1000 on the user subpath only', (op) => {
    const created = spec(op)
    expect(created.User).toBe('1000:1000')
    expect(created.HostConfig?.CapDrop).toEqual(['ALL'])
    expect(created.HostConfig?.CapAdd).toBeUndefined()
    expect(created.HostConfig?.Mounts).toEqual([{ Type: 'volume', Source: 'scantor-workspaces', Target: '/workspace', VolumeOptions: { Subpath: USER } }])
    expect(created.Labels).toMatchObject({ 'scantor.managed': 'true', 'scantor.kind': 'helper', 'scantor.user': USER, 'scantor.op': op, 'traefik.enable': 'false' })
  })

  it('applies the hardening profile and limits', () => {
    const created = spec('snapshot', ['--task', 'echo'])
    expect(created).toMatchObject({
      name: `scantor-h-${ID}`,
      Image: 'scantor:dev',
      Entrypoint: ['/usr/local/bin/scantor'],
      Cmd: ['workspace', 'snapshot', '--task', 'echo'],
      Env: ['HOME=/tmp'],
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
    })
    expect(created.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m' },
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 256,
      Memory: 512 * 1024 ** 2,
      MemorySwap: 512 * 1024 ** 2,
      NanoCpus: 1_000_000_000,
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
    })
  })

  it('runs git operations on scantor-egress with the credential environment', () => {
    const created = spec('git-clone', ['--url', 'https://example.org/r.git'], 'egress', { GIT_CONFIG_COUNT: '1', HOME: '/evil' })
    expect(created.HostConfig?.NetworkMode).toBe('scantor-egress')
    expect(created.Env).toEqual(['GIT_CONFIG_COUNT=1', 'HOME=/tmp'])
  })

  it('mounts no volume for --archive reads', () => {
    for (const op of ['list', 'read'] as const) {
      expect(helperMountFor(op, ['--archive'])).toBe('none')
      expect(spec(op, ['--archive']).HostConfig?.Mounts).toEqual([])
    }
    expect(helperMountFor('list', ['--task', 'echo'])).toBe('user')
  })

  it('runs init and purge as root with CHOWN, DAC_OVERRIDE and FOWNER on both whole volumes', () => {
    for (const op of ['init', 'purge'] as const) {
      const created = spec(op, ['--user', USER])
      expect(created.User).toBe('0:0')
      expect(created.HostConfig?.CapDrop).toEqual(['ALL'])
      expect(created.HostConfig?.CapAdd).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
      expect(created.HostConfig?.Mounts).toEqual([
        { Type: 'volume', Source: 'scantor-workspaces', Target: '/volumes/workspaces' },
        { Type: 'volume', Source: 'scantor-editor-home', Target: '/volumes/editor-home' },
      ])
    }
  })

  it('takes the exclusive per-user lock for writers only', () => {
    expect([...EXCLUSIVE_OPS].sort()).toEqual(['commit', 'delete-files', 'init', 'purge', 'scaffold', 'write-files'])
  })
})
