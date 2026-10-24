import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { docker } from '../helpers/docker'
import { attachDebugger, debuggerKind, type DebugSession } from '../helpers/debug'
import { env } from '../helpers/env'
import { spawnScantor } from '../helpers/e2e-examples-cli-process'
import { findPipelineResult, initScaffold, localEvents, localResults, removeDevImages, removeScaffold } from '../helpers/e2e-examples-cli-tasks'
import { extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { expect, test as base, unique } from '../fixtures'

// `scantor dev debug` (docs/tasks.md §11.4, docs/runtime.md §15.5) in every language of schemas/languages.json: the
// CLI builds a debug image, starts one connector process under the base image's SCANTOR_DEBUG_CMD (debugpy, the Node
// inspector, Delve) with timeouts disabled and publishes SCANTOR_DEBUG_PORT on 127.0.0.1; helpers/debug.ts attaches
// with the matching protocol and resumes the program, and the analysis completes. For Go this proves that `dlv exec`
// hands fds 3 and 4 to the debuggee (docs/testing.md §8.3). The debug ports are fixed per base image (typescript and
// javascript share 9229), so the tests of this file run one after another.

// The same `test` as the other e2e CLI specs, so a worker moves between the files without a restart.
const test = extendExamplesCli(base)

test.describe.configure({ mode: 'default' })

const LANGUAGES = (JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'languages.json'), 'utf8')) as { languages: Record<string, { image: string }> })
  .languages

/** SCANTOR_DEBUG_CMD and SCANTOR_DEBUG_PORT of a base image (docs/tasks.md §4.2). */
async function debugContract(image: string): Promise<{ command: string; port: number }> {
  const inspect = await docker(['image', 'inspect', image, '--format', '{{json .Config.Env}}'])
  const variables = Object.fromEntries((JSON.parse(inspect.stdout) as string[]).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
  return { command: variables.SCANTOR_DEBUG_CMD!, port: Number(variables.SCANTOR_DEBUG_PORT) }
}

interface PortBinding {
  HostIp: string
  HostPort: string
}

test.describe('dev debug', () => {
  for (const [language, { image }] of Object.entries(LANGUAGES)) {
    test(`${language}: a debugger attaches, resumes and the analysis completes`, { tag: ['@DEV-014'] }, async () => {
      const contract = await debugContract(`${image}:dev`)
      const kind = debuggerKind(contract.command)
      const name = unique(`debug-${language}`)
      const dir = await initScaffold(language, 'single', name)
      const cli = spawnScantor(['dev', 'debug', dir, '-o', 'json'], { cwd: dir })
      let session: DebugSession | undefined
      let containerId = ''
      try {
        // The debug build first; then the local-mode container starts with the debugger port published on loopback.
        // dev run and dev debug print the task-pipeline events on stderr and the local-mode events on stdout.
        const built = await cli.waitFor((p) => findPipelineResult(p.stderr)?.image?.ref, 240_000, 'the debug build')
        await expect
          .poll(
            async () => {
              containerId = (await docker(['ps', '-q', '--filter', `ancestor=${built}`, '--filter', 'label=scantor.kind=testRun'])).stdout.trim()
              return containerId
            },
            { timeout: 120_000, intervals: [500] },
          )
          .not.toBe('')
        const inspect = JSON.parse((await docker(['inspect', containerId])).stdout)[0] as { HostConfig: { PortBindings: Record<string, PortBinding[]> } }
        expect(inspect.HostConfig.PortBindings).toEqual({ [`${contract.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(contract.port) }] })

        // Without a debugger nothing runs: the connector waits for the attach (hello and ready timeouts are off).
        expect(localEvents(cli.stdout).filter((e) => e.type === 'result')).toEqual([])

        session = await attachDebugger(kind, contract.port, { timeoutMs: 120_000 })
        const exit = await cli.wait(180_000)
        expect(exit.exitCode, `${cli.output()}\n--- debugger ---\n${session.transcript.join('\n')}`).toBe(0)

        const events = localEvents(cli.stdout)
        // The debugger's own output (for example the inspector's banner) may precede the start event.
        expect(events.find((e) => e.type === 'start')).toMatchObject({ debugPort: contract.port, processes: 1, limit: 1 })
        expect(localResults(cli.stdout)).toEqual([expect.objectContaining({ seq: 0, status: 'succeeded', error: null })])
        expect(events.at(-1)).toMatchObject({ type: 'end', exitCode: 0 })
      } finally {
        await session?.close()
        await cli.stop()
        // A CLI killed before its own cleanup leaves the debug container running, and it holds the image.
        if (containerId) await docker(['rm', '--force', containerId], { allowFailure: true })
        await removeDevImages(name)
        await removeScaffold(dir)
      }
    })
  }
})
