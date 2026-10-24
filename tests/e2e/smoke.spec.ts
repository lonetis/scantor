import type { Scan } from '#shared/types/scans'
import { ok } from '../helpers/api-client'
import { scantor } from '../helpers/cli'
import { copyTask, exampleTaskDir, removeDir } from '../helpers/tasks'
import { extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { expect, test as base, unique } from '../fixtures'

// Smoke test of the e2e plumbing: the runner's scantor CLI pushes a task to the stack (build, push to the registry)
// and a real scan runs on the built-in node.

// Sessions that survive concurrent runs on one stack (helpers/e2e-examples-cli-fixtures.ts).
const test = extendExamplesCli(base)

test.describe('CLI scan', () => {
  test('a pushed task runs to completion from the CLI', { tag: ['@CLI-004'] }, async ({ user, api, tasks, scans }) => {
    const name = unique('echo')
    const dir = await copyTask(exampleTaskDir('echo'), name)
    tasks.track(name)
    try {
      const push = await scantor(['push', dir, '--wait'], { token: user.apiKey, cwd: dir })
      expect(push.exitCode, push.stdout + push.stderr).toBe(0)

      const settings = JSON.stringify({ resources: { cpus: 0.25, memoryMiB: 256 } })
      const start = await scantor(
        [
          'scans',
          'start',
          `${name}@latest`,
          '--task-config',
          '{"text":"smoke"}',
          '--settings',
          settings,
          '--workers',
          '1',
          '--processes',
          '1',
          '--wait',
          '-o',
          'json',
        ],
        { token: user.apiKey },
      )
      const scan = start.json as Scan | undefined
      if (scan?.id) scans.track(scan.id)
      expect(start.exitCode, start.stdout + start.stderr).toBe(0)
      expect(scan?.state).toBe('completed')

      expect(await scans.counts(scan!.id)).toEqual({ succeeded: 1 })
      const rows = ok(await api.queryAnalyses(scan!.id, { filter: {}, projection: { result: 1 } }), 'queryAnalyses')
      expect(rows.items).toEqual([expect.objectContaining({ result: { echo: 'smoke' } })])
    } finally {
      await removeDir(dir)
    }
  })
})
