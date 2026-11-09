import { PassThrough, Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelperResult, HelperRunOptions } from '../../../server/services/helpers/types'

// The flags of the typed workspace operations (docs/editor.md §9.4): a task name addresses `--task <name>` exactly as
// before, `{script: name}` addresses the script folder with `--script <name>`; scaffold and extract know the script
// kind.

const calls: { op: string; options: HelperRunOptions }[] = []
let outcome: (op: string) => HelperResult

vi.mock('../../../server/services/helpers/executor', () => ({
  executeHelper: async (op: string, options: HelperRunOptions) => {
    calls.push({ op, options })
    return outcome(op)
  },
  useHelperRuntime: () => ({
    config: { taskMaxFiles: 11, taskMaxBytes: 12, workspaceMaxBytes: 13, taskMaxPackBytes: 14, imagePrefix: 'p/', imageTag: 't' },
  }),
}))

const ops = await import('../../../server/services/helpers/ops')

const SUMMARY = { packSha256: 'a'.repeat(64), fileCount: 1, bytes: 2 }

function ok(stdout: unknown, stderr = ''): HelperResult {
  return { exitCode: 0, stdout: Buffer.from(JSON.stringify(stdout)), stderr }
}

function argsOf(index = 0): string[] {
  return calls[index]!.options.args ?? []
}

beforeEach(() => {
  calls.length = 0
  outcome = () => ok({ entries: [], truncated: false, workspace: SUMMARY, written: [], deleted: [] })
})

describe('folder references', () => {
  it('maps a task name, {task} and {script} to their kind, name and flags', () => {
    expect(ops.folderOf('echo')).toEqual({ kind: 'task', name: 'echo' })
    expect(ops.folderOf({ task: 'echo' })).toEqual({ kind: 'task', name: 'echo' })
    expect(ops.folderOf({ script: 'csp' })).toEqual({ kind: 'script', name: 'csp' })
    expect(ops.folderArgs('echo')).toEqual(['--task', 'echo'])
    expect(ops.folderArgs({ script: 'csp' })).toEqual(['--script', 'csp'])
  })
})

describe('folder operations', () => {
  it('keeps the exact task flags of list, read, write-files and delete-files', async () => {
    await ops.listFiles('u1', 'echo', { path: 'src', recursive: true })
    await ops.readFile('u1', 'echo', 'main.py')
    await ops.writeFiles('u1', 'echo', { 'a.txt': 'x' })
    await ops.deleteFiles('u1', 'echo', 'a.txt', false)
    expect(calls.map((call) => [call.op, call.options.args])).toEqual([
      ['list', ['--task', 'echo', '--path', 'src', '--recursive=true', '--max-entries', String(ops.FILE_LIST_MAX_ENTRIES)]],
      ['read', ['--task', 'echo', '--path', 'main.py', '--max-bytes', String(ops.FILE_READ_MAX_BYTES)]],
      ['write-files', ['--task', 'echo', '--max-files', '11', '--max-bytes', '12', '--max-workspace-bytes', '13']],
      ['delete-files', ['--task', 'echo', '--path', 'a.txt', '--recursive=false']],
    ])
  })

  it('addresses a script folder with --script in every folder operation', async () => {
    const script = { script: 'csp' }
    await ops.listFiles('u1', script, { path: '', recursive: false })
    await ops.readFile('u1', script, 'main.py')
    await ops.writeFiles('u1', script, { 'main.py': 'print(1)' })
    await ops.deleteFiles('u1', script, 'main.py', false)
    outcome = () => ok(SUMMARY)
    await ops.snapshotHash('u1', script)
    for (const [index] of calls.entries()) expect(argsOf(index).slice(0, 2), calls[index]!.op).toEqual(['--script', 'csp'])
    expect(calls.every((call) => !call.options.args?.includes('--task'))).toBe(true)
  })

  it('removes a whole script folder and ignores a missing one', async () => {
    outcome = () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: `${JSON.stringify({ type: 'error', error: { code: 'notFound', message: 'no such folder' } })}\n`,
    })
    await expect(ops.deleteFolder('u1', { script: 'csp' })).resolves.toBeUndefined()
    await expect(ops.deleteTaskFolder('u1', 'echo')).resolves.toBeUndefined()
    expect(argsOf(0)).toEqual(['--script', 'csp', '--path', '', '--recursive=true'])
    expect(argsOf(1)).toEqual(['--task', 'echo', '--path', '', '--recursive=true'])
  })

  it('streams the snapshot of a script folder', async () => {
    outcome = () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: `${JSON.stringify({ type: 'summary', ...SUMMARY, packBytes: 3 })}\n` })
    await expect(ops.snapshotStream('u1', { script: 'csp' }, new PassThrough())).resolves.toMatchObject(SUMMARY)
    expect(argsOf()).toEqual(['--script', 'csp', '--max-files', '11', '--max-bytes', '12', '--max-pack-bytes', '14'])
  })
})

describe('scaffold, extract and commit', () => {
  it('scaffolds a task with its template and a script without one', async () => {
    await ops.scaffold('u1', { task: 'echo', language: 'python', template: 'single', description: 'Echo' })
    await ops.scaffold('u1', { script: 'csp', language: 'python', description: 'CSP stats' })
    await ops.scaffold('u1', { script: 'bare', language: 'python' })
    expect(argsOf(0)).toEqual(['--task', 'echo', '--language', 'python', '--template', 'single', '--description', 'Echo', '--max-workspace-bytes', '13'])
    expect(argsOf(1)).toEqual(['--script', 'csp', '--language', 'python', '--description', 'CSP stats', '--max-workspace-bytes', '13'])
    expect(argsOf(2)).toEqual(['--script', 'bare', '--language', 'python', '--max-workspace-bytes', '13'])
    expect(calls[1]!.options.env).toEqual({ SCANTOR_IMAGE_PREFIX: 'p/', SCANTOR_IMAGE_TAG: 't' })
  })

  it('extracts a task archive with the original flags and a script archive with --kind script', async () => {
    await ops.extract('u1', 'staging-1', Readable.from([Buffer.from('x')]))
    await ops.extract('u1', 'staging-2', Readable.from([Buffer.from('x')]), { kind: 'script' })
    const limits = ['--max-files', '11', '--max-bytes', '12', '--max-workspace-bytes', '13', '--max-pack-bytes', '14']
    expect(argsOf(0)).toEqual(['--staging', 'staging-1', ...limits])
    expect(argsOf(1)).toEqual(['--staging', 'staging-2', '--kind', 'script', ...limits])
  })

  it('commits into a task folder or a script folder', async () => {
    outcome = () => ok({ task: 'x', changed: true, previousPackSha256: null, workspace: SUMMARY })
    await ops.commit('u1', { stagingId: 's1', task: 'echo', expect: 'absent', from: 'sub' })
    await ops.commit('u1', { stagingId: 's2', script: 'csp', expect: 'any' })
    const limits = ['--max-files', '11', '--max-bytes', '12', '--max-workspace-bytes', '13']
    expect(argsOf(0)).toEqual(['--staging', 's1', '--from', 'sub', '--task', 'echo', '--expect', 'absent', ...limits])
    expect(argsOf(1)).toEqual(['--staging', 's2', '--script', 'csp', '--expect', 'any', ...limits])
  })
})
