import { stackEnv } from '../helpers/docker'
import { cancelIfActive, withMcpTenants } from '../helpers/mcp-tenant'
import { callOk, callToolError, pollTool, unwrap } from '../helpers/mcp-tools'
import { SMALL_SETTINGS } from '../helpers/scans'
import { expect, test as base, unique } from '../fixtures'

// The agent loop of docs/mcp.md §7 with MCP tools only (an API key's write level): learn, scaffold a Python task with
// the `range` template, read and edit its files, test without publishing, publish (first a deliberately broken edit
// that the type check rejects with structured errors, then the fix), start a scan, wait for it, query, aggregate and
// export the results; plus the confirmation round trip of a scan above SCANTOR_SCAN_CONFIRM_THRESHOLD. One serial
// test, because every step builds on the previous one. The task and its scans stay in the worker tenant's account,
// whose deletion at worker teardown purges them: waiting for their scanDelete jobs in the test's teardown, as the
// `tasks` and `scans` fixtures do, outlasted 120 s on the shared stack. A scan still active at the end is cancelled.

const test = withMcpTenants(base)

const FIRST_GREETING = 'greeting: str = "Hello"'
const SCAFFOLD_RESULT = 'return Result(text=f"{task_config.greeting}, {analysis_config.value}!")'

interface TaskFile {
  path: string
  content: unknown
}

interface Revision {
  number: number
  state: 'queued' | 'building' | 'ready' | 'failed'
  ref: string
  errors: unknown
  _wait?: string
}

interface TestRun {
  id: string
  state: string
  errors: unknown
  analyses?: unknown
  summary: { analyses: number; succeeded: number; failed: number }
  _wait?: string
}

interface BuildError {
  phase: string
  file?: string
  line?: number
  column?: number
  message: string
}

interface Scan {
  id: string
  state: string
  _wait?: string
}

test.describe('MCP agent loop', () => {
  test.describe.configure({ mode: 'serial' })

  test(
    'an agent authors, tests, publishes, runs and analyses a task with tools only',
    { tag: ['@MCP-018', '@MCP-019', '@MCP-005', '@MCP-004'] },
    async ({ request, api, mcpKey }) => {
      // Three builds (the test run, the failed and the ready revision) and a scan.
      test.setTimeout(360_000)
      const name = unique('mcp-agent')
      const scanIds: string[] = []
      try {
        await test.step('learn', async () => {
          const guide = await mcpKey.callTool({ name: 'get_authoring_guide', arguments: { language: 'python' } })
          expect(guide.isError).toBeFalsy()
          const templates = await callOk<{ items: { name: string }[] }>(mcpKey, 'list_templates', {})
          expect(templates.items.map((template) => template.name)).toContain('range')
        })

        const mainPy = await test.step('scaffold and read', async () => {
          const created = await callOk<{ name: string; description: unknown }>(mcpKey, 'create_task', {
            name,
            language: 'python',
            template: 'range',
            description: 'Doubles every integer of a range',
          })
          expect(created.name).toBe(name)
          expect(unwrap<string>(created.description, 'create_task description')).toBe('Doubles every integer of a range')

          const listed = await callOk<{ entries: { path: string }[] }>(mcpKey, 'list_task_files', { task: name })
          expect(listed.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(['scantor.yaml', 'Dockerfile', 'main.py']))
          const manifest = await callOk<TaskFile>(mcpKey, 'read_task_file', { task: name, path: 'scantor.yaml' })
          expect(unwrap<string>(manifest.content, 'scantor.yaml content')).toContain(`name: ${name}`)
          const entry = await callOk<TaskFile>(mcpKey, 'read_task_file', { task: name, path: 'main.py' })
          const content = unwrap<string>(entry.content, 'main.py content')
          expect(content).toContain('schedule=templates.range.schedule')
          expect(content).toContain(FIRST_GREETING)
          expect(content).toContain(SCAFFOLD_RESULT)
          return content
        })

        const fixed = mainPy
          .replace(FIRST_GREETING, 'greeting: str = "Agent"')
          .replace(SCAFFOLD_RESULT, 'return Result(text=f"{task_config.greeting} {analysis_config.value * 2}")')
        const broken = mainPy.replace(SCAFFOLD_RESULT, 'return Result(text=analysis_config.value)')

        await test.step('edit and test without publishing', async () => {
          const written = await callOk<{ written: string[]; workspace: { dirty: boolean } }>(mcpKey, 'write_task_files', {
            task: name,
            files: { 'main.py': fixed },
          })
          expect(written.written).toEqual(['main.py'])
          expect(written.workspace.dirty).toBe(true)

          let run = await callOk<TestRun>(mcpKey, 'test_task', { task: name, scanConfig: { start: 0, end: 3 }, limit: 3, wait: 50 })
          expect(['settled', 'timeout']).toContain(run._wait)
          run = await pollTool<TestRun & Record<string, unknown>>(
            mcpKey,
            'get_test_run',
            { testRunId: run.id },
            (value) => ['completed', 'failed', 'cancelled'].includes(value.state),
            180_000,
          )
          expect(run.state, JSON.stringify(run.errors)).toBe('completed')
          expect(run.summary).toEqual({ analyses: 3, succeeded: 3, failed: 0 })
          const analyses = unwrap<{ seq: number; status: string; result: { text: string } }[]>(run.analyses, 'test run analyses')
          expect(analyses.map((analysis) => analysis.result.text).sort()).toEqual(['Agent 0', 'Agent 2', 'Agent 4'])
        })

        await test.step('a broken edit fails the publish with structured check errors', async () => {
          await callOk(mcpKey, 'write_task_files', { task: name, files: { 'main.py': broken } })
          const published = await callOk<Revision>(mcpKey, 'publish_revision', { task: name, message: 'broken on purpose', wait: 50 })
          const revision = await pollTool<Revision & Record<string, unknown>>(
            mcpKey,
            'get_revision',
            { task: name, revision: String(published.number) },
            (value) => value.state === 'ready' || value.state === 'failed',
            150_000,
          )
          expect(revision.state).toBe('failed')
          const errors = unwrap<BuildError[]>(revision.errors, 'revision errors')
          const line = broken.split('\n').findIndex((text) => text.includes('Result(text=analysis_config.value)')) + 1
          expect(errors).toContainEqual(
            expect.objectContaining({ phase: 'check', file: 'main.py', line, column: expect.any(Number), message: expect.stringMatching(/"int".*"str"/) }),
          )
        })

        const ready = await test.step('the fix publishes a ready revision', async () => {
          await callOk(mcpKey, 'write_task_files', { task: name, files: { 'main.py': fixed } })
          const published = await callOk<Revision>(mcpKey, 'publish_revision', { task: name, message: 'double the values', wait: 50 })
          const revision = await pollTool<Revision & Record<string, unknown>>(
            mcpKey,
            'get_revision',
            { task: name, revision: String(published.number) },
            (value) => value.state === 'ready' || value.state === 'failed',
            150_000,
          )
          expect(revision.state, JSON.stringify(revision.errors)).toBe('ready')
          expect(unwrap(revision.errors, 'ready revision errors')).toEqual([])
          const latest = await callOk<Revision>(mcpKey, 'get_revision', { task: name, revision: 'latest' })
          expect(latest.number).toBe(revision.number)
          return revision
        })

        const scanId = await test.step('run the scan to completion', async () => {
          const started = await callOk<Scan>(mcpKey, 'start_scan', {
            revision: `${name}@latest`,
            name: 'agent loop',
            scanConfig: { start: 0, end: 5 },
            settings: SMALL_SETTINGS,
          })
          scanIds.push(started.id)
          expect(started.state).toBe('creating')
          const done = await pollTool<Scan & Record<string, unknown>>(
            mcpKey,
            'get_scan',
            { scanId: started.id },
            (value) => !['creating', 'running'].includes(value.state),
            150_000,
          )
          expect(done.state).toBe('completed')
          return started.id
        })

        await test.step('query, aggregate and export the results', async () => {
          const queried = await callOk<{ items: unknown[] }>(mcpKey, 'query_analyses', { scanId, filter: {}, sort: { seq: -1 }, limit: 10 })
          const items = queried.items.map((item, index) => unwrap<{ seq: number; status: string; result: { text: string } }>(item, `items[${index}]`))
          expect(items.map((item) => item.seq)).toEqual([4, 3, 2, 1, 0])
          expect(items.map((item) => item.result.text)).toEqual(['Agent 8', 'Agent 6', 'Agent 4', 'Agent 2', 'Agent 0'])

          const aggregated = await callOk<{ items: unknown[] }>(mcpKey, 'aggregate_analyses', {
            scanId,
            pipeline: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
          })
          expect(aggregated.items.map((item) => unwrap(item, 'aggregate item'))).toEqual([{ _id: 'succeeded', n: 5 }])

          const exported = await callOk<{ id: string; state: string }>(mcpKey, 'export_scan', { scanId, format: 'jsonl', wait: 50 })
          const finished = await pollTool<{ id: string; state: string; rows: number; download?: { url: string } } & Record<string, unknown>>(
            mcpKey,
            'get_export',
            { exportId: exported.id },
            (value) => value.state === 'ready' || value.state === 'failed',
            120_000,
          )
          expect(finished.state).toBe('ready')
          expect(finished.rows).toBe(5)
          const download = await request.get(finished.download!.url)
          expect(download.status()).toBe(200)
          const lines = (await download.text())
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { seq: number; result: { text: string } })
          expect(lines.map((line) => line.seq).sort()).toEqual([0, 1, 2, 3, 4])
          expect(lines.find((line) => line.seq === 3)?.result.text).toBe('Agent 6')
        })

        await test.step('a scan above the confirmation threshold needs confirm: true', async () => {
          const threshold = Number(stackEnv().SCANTOR_SCAN_CONFIRM_THRESHOLD)
          expect(threshold).toBeGreaterThan(0)
          const body = { revision: ready.ref, scanConfig: { start: 0, end: threshold + 1 }, settings: SMALL_SETTINGS }
          const refused = await callToolError(mcpKey, 'start_scan', body)
          expect(refused).toMatchObject({ httpStatus: 422, code: 'confirmationRequired', details: expect.objectContaining({ expectedTotal: threshold + 1 }) })

          const confirmed = await callOk<Scan>(mcpKey, 'start_scan', { ...body, confirm: true })
          scanIds.push(confirmed.id)
          expect(confirmed.state).toBe('creating')
          const cancelled = await callOk<Scan>(mcpKey, 'cancel_scan', { scanId: confirmed.id })
          expect(cancelled.state).toBe('cancelled')
        })
      } finally {
        for (const scanId of scanIds) await cancelIfActive(api, scanId)
      }
    },
  )
})
