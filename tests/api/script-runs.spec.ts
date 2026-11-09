import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '#shared/types/common'
import type { FileContent, FileDownload } from '#shared/types/exports'
import type { ScriptRun } from '#shared/types/scripts'
import { ok } from '../helpers/api-client'
import { download, UNPLACEABLE_SETTINGS } from '../helpers/api-results'
import { errorOf, ISO_DATE, issuePaths, packSha256, readTarGz, SHA256, sha256 } from '../helpers/api-tasks-support'
import { waitForScanState } from '../helpers/scans'
import {
  allScriptRunLogs,
  apiErrorOf,
  cancelScriptRun,
  editScriptManifest,
  FILES_ITEMS,
  filesReportCsv,
  filesReportResult,
  fixtureScriptDir,
  getScript,
  getScriptRun,
  getScriptRunLogs,
  imageExists,
  outputNamed,
  probeScriptFiles,
  probeWaiting,
  readOutputText,
  readScriptFiles,
  restartScriptRun,
  runScript,
  SCRIPT_DOCKERFILE,
  SCRIPT_MANIFEST,
  scriptFileText,
  scriptImageRef,
  scriptRunContainerState,
  scriptRunLimits,
  scriptsTest,
  startRun,
  startScriptRun,
  waitForScriptRun,
  waitForScriptRunContainerGone,
  waitForScriptRunLog,
  writeScriptFiles,
  type ProbeResult,
} from '../helpers/scripts'
import { expect, test as base, unique } from '../fixtures'

// Script runs (docs/scripts.md, docs/api.md tag `script-runs`): the files-report fixture script on the worker's scan of
// the example task `files` end to end (build, stream, file reads, outputs, progress, checkpoint, result, log), sample
// runs and restarts with resume, cancellation, timeouts, failures, build errors, the start checks, the described config
// schema, secrets, the log bounds and the output limit. Every test uploads its own script; runs that need only a scan
// to bind use the generated probe script (helpers/scripts.ts) on the same scan. Script builds share the stack's build
// slots with every other suite and runs queue behind SCANTOR_SCRIPT_RUN_CONCURRENCY, so the timeouts are generous.

const test = scriptsTest(base)

test.describe.configure({ timeout: 360_000 })

const DAY_MS = 86_400_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FILES_REPORT = fixtureScriptDir('files-report')

const systemLine = (text: string) => (line: { stream: string; text: string }) => line.stream === 'system' && line.text === text

test.describe('files-report on a scan of the example task files', () => {
  test(
    'a run builds the folder, reads every analysis and file of the scan and stores its result, outputs, progress, checkpoint and log',
    { tag: ['@SRUN-001', '@SRUN-002', '@SRUN-003', '@SRUN-004', '@SRUN-005', '@SRUN-016'] },
    async ({ api, otherApi, scripts, filesScan }) => {
      const { scan, rows } = filesScan
      const scanName = scan.name ?? scan.id
      const files = await readScriptFiles(FILES_REPORT)
      const script = await scripts.upload(files)

      const created = await startRun(api, script.name, { scans: [scan.id] })
      // Created queued; the response reloads it, so an idle stack may already be building it.
      expect(['queued', 'building']).toContain(created.state)
      expect(created).toMatchObject({
        userId: script.userId,
        scriptId: script.id,
        scriptName: script.name,
        scans: [{ id: scan.id, name: scan.name }],
        secrets: [],
        source: { packSha256: script.workspace.packSha256, fileCount: Object.keys(files).length },
        restartedFrom: null,
        errors: [],
        error: null,
        exitCode: null,
        result: null,
        outputs: [],
        finishedAt: null,
        expiresAt: null,
      })
      expect(created.source.packBytes).toBeGreaterThan(0)
      if (created.state === 'queued') {
        expect(created.input).toEqual({ config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: null } })
        expect(created.image).toBeNull()
      }

      const run = await waitForScriptRun(api, created.id, 'completed')
      const limits = scriptRunLimits()
      expect(run).toMatchObject({
        errors: [],
        error: null,
        exitCode: 0,
        image: { ref: scriptImageRef(script.id, run.source.packSha256), cached: false },
        // The effective settings: the manifest's memory, the default CPU and the instance's maximum duration.
        input: { config: {}, settings: { timeoutMs: limits.timeoutMs, resources: { cpus: 1, memoryMiB: 512 }, limit: null } },
      })
      expect(run.result).toEqual(filesReportResult(scanName, rows, false))
      const fileCount = rows.reduce((sum, row) => sum + row.files, 0)
      expect(fileCount).toBe(7 * FILES_ITEMS.length)
      expect(run.progress).toEqual({ done: rows.length, total: rows.length, message: `${fileCount} files read`, updatedAt: expect.stringMatching(ISO_DATE) })
      expect(run.checkpoint).toEqual({ savedAt: expect.stringMatching(ISO_DATE), bytes: expect.any(Number) })
      expect(run.checkpoint!.bytes).toBeGreaterThan(0)
      expect(Date.parse(run.startedAt!)).toBeGreaterThanOrEqual(Date.parse(run.createdAt))
      expect(Date.parse(run.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(run.startedAt!))
      if (limits.retentionDays > 0) expect(Date.parse(run.expiresAt!) - Date.parse(run.finishedAt!)).toBe(limits.retentionDays * DAY_MS)
      else expect(run.expiresAt).toBeNull()

      // Outputs: files.csv with one row per succeeded analysis in seq order, and summary.json.
      expect(run.outputs.map((output) => output.name).sort()).toEqual(['files.csv', 'summary.json'])
      const csv = outputNamed(run, 'files.csv')
      const expectedCsv = filesReportCsv(rows)
      expect(csv).toEqual({
        id: expect.stringMatching(UUID),
        name: 'files.csv',
        size: Buffer.byteLength(expectedCsv),
        sha256: sha256(expectedCsv),
        contentType: expect.stringMatching(/^text\/csv/),
        createdAt: expect.stringMatching(ISO_DATE),
      })
      const location = ok(
        await api.call<FileDownload>('getScriptRunOutputDownload', { path: { scriptRunId: run.id, outputId: csv.id } }),
        'getScriptRunOutputDownload',
      )
      expect(location).toMatchObject({ name: 'files.csv', size: csv.size, sha256: csv.sha256, contentType: csv.contentType })
      expect(Date.parse(location.expiresAt)).toBeGreaterThan(Date.now())
      const downloaded = await download(location.url)
      expect(downloaded.status).toBe(200)
      expect(downloaded.body.toString('utf8')).toBe(expectedCsv)
      const redirect = await api.call('getScriptRunOutputDownload', { path: { scriptRunId: run.id, outputId: csv.id }, query: { redirect: true } })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.location).toMatch(/^https:\/\//)
      const content = ok(await api.call<FileContent>('readScriptRunOutput', { path: { scriptRunId: run.id, outputId: csv.id } }), 'readScriptRunOutput')
      expect(content).toMatchObject({ name: 'files.csv', size: csv.size, sha256: csv.sha256, offset: 0, encoding: 'utf8', truncated: false, nextOffset: null })
      expect(content.content).toBe(expectedCsv)
      const summary = outputNamed(run, 'summary.json')
      expect(summary.contentType).toBe('application/json')
      expect(JSON.parse(await readOutputText(api, run.id, summary.id))).toEqual(run.result)
      for (const operation of ['getScriptRunOutputDownload', 'readScriptRunOutput']) {
        const unknown = await api.call(operation, { path: { scriptRunId: run.id, outputId: randomUUID() } })
        expect(unknown.status, operation).toBe(404)
        expect(errorOf(unknown).code, operation).toBe('notFound')
      }

      // The log: build output, the platform's lines and the script's own, numbered from 1. The job writes its last
      // lines right after the state change.
      await waitForScriptRunLog(api, run.id, systemLine('the script exited with code 0'))
      const lines = await allScriptRunLogs(api, run.id)
      expect(lines.map((line) => line.line)).toEqual(lines.map((_, index) => index + 1))
      expect([...new Set(lines.map((line) => line.stream))]).toEqual(expect.arrayContaining(['build', 'system', 'stdout']))
      expect(lines.map((line) => line.text)).toEqual(
        expect.arrayContaining(['the script started', `report written analyses=${rows.length} files=${fileCount}`, 'the script exited with code 0']),
      )
      for (const line of lines) expect(line.at).toMatch(ISO_DATE)
      const settled = ok(await getScriptRun(api, run.id), 'getScriptRun')
      expect(settled.log).toEqual({ lines: lines.length, firstLine: 1, droppedLines: 0 })
      const tail = settled.logTail!
      expect(tail.length).toBeGreaterThan(0)
      expect(tail.length).toBeLessThanOrEqual(50)
      expect(tail).toEqual(lines.slice(-tail.length))
      expect(ok(await getScriptRunLogs(api, run.id, { limit: 5 }), 'getScriptRunLogs')).toEqual({
        lines: lines.slice(0, 5),
        firstLine: 1,
        nextLine: 5,
        complete: false,
      })
      expect(ok(await getScriptRunLogs(api, run.id, { afterLine: 5, limit: 5 }), 'getScriptRunLogs').lines).toEqual(lines.slice(5, 10))
      expect(ok(await getScriptRunLogs(api, run.id, { afterLine: lines.length - 2 }), 'getScriptRunLogs')).toEqual({
        lines: lines.slice(-2),
        firstLine: 1,
        nextLine: lines.length,
        complete: true,
      })
      for (const limit of [0, 1001]) expect((await getScriptRunLogs(api, run.id, { limit })).status, `limit ${limit}`).toBe(400)

      // The container is gone; the image stays on the master's engine (never pushed).
      await waitForScriptRunContainerGone(run.id)
      expect(await imageExists(run.image!.ref)).toBe(true)

      // The script follows its runs and keeps the schemas the code reported.
      const after = ok(await getScript(api, script.name), 'getScript')
      expect(after.latestRun).toEqual({ id: run.id, state: 'completed', createdAt: run.createdAt, finishedAt: run.finishedAt })
      expect(after.recentRuns).toEqual([{ id: run.id, state: 'completed', createdAt: run.createdAt, finishedAt: run.finishedAt, progress: run.progress }])
      expect(after.describe).toMatchObject({
        packSha256: run.source.packSha256,
        configSchema: { properties: { workers: expect.objectContaining({ default: 8 }) } },
        resultSchema: { properties: expect.objectContaining({ analyses: expect.anything(), resumed: expect.anything() }) },
      })
      const history = ok(await api.call<Page<ScriptRun>>('listScriptRuns', { path: { script: script.name } }), 'listScriptRuns')
      expect(history.items.map((item) => item.id)).toEqual([run.id])
      expect(history.items[0]).not.toHaveProperty('logTail')
      expect(history.items[0]).toMatchObject({ state: 'completed', result: run.result, outputs: run.outputs })

      // The source snapshot of the run.
      const source = ok(
        await api.call<{ url: string; expiresAt: string }>('getScriptRunSourceDownload', { path: { scriptRunId: run.id } }),
        'getScriptRunSourceDownload',
      )
      expect(Object.keys(source).sort()).toEqual(['expiresAt', 'url'])
      const archive = await download(source.url)
      expect(archive.status).toBe(200)
      expect(archive.headers['content-type']).toBe('application/gzip')
      expect(archive.headers['content-disposition']).toMatch(/^attachment;.*\.tar\.gz/)
      expect(packSha256(archive.body)).toBe(run.source.packSha256)
      const entries = (await readTarGz(archive.body)).filter((entry) => entry.type === 'file')
      expect(entries.map((entry) => entry.name).sort()).toEqual(Object.keys(files).sort())
      expect(entries.find((entry) => entry.name === 'main.py')?.content.toString('utf8')).toBe(scriptFileText(files, 'main.py'))
      expect((await api.call('getScriptRunSourceDownload', { path: { scriptRunId: run.id }, query: { redirect: true } })).status).toBe(302)

      // A completed run cannot be cancelled.
      const conflict = await cancelScriptRun(api, run.id)
      expect(conflict.status).toBe(409)
      expect(errorOf(conflict)).toMatchObject({ code: 'invalidState', details: { state: 'completed', allowed: ['queued', 'building', 'running'] } })

      // Another user reaches neither the run nor the script.
      const foreign: [string, Record<string, unknown>][] = [
        ['getScriptRun', { path: { scriptRunId: run.id } }],
        ['getScriptRunLogs', { path: { scriptRunId: run.id } }],
        ['cancelScriptRun', { path: { scriptRunId: run.id } }],
        ['restartScriptRun', { path: { scriptRunId: run.id }, body: {} }],
        ['getScriptRunSourceDownload', { path: { scriptRunId: run.id } }],
        ['getScriptRunOutputDownload', { path: { scriptRunId: run.id, outputId: csv.id } }],
        ['readScriptRunOutput', { path: { scriptRunId: run.id, outputId: csv.id } }],
        ['listScriptRuns', { path: { script: script.id } }],
        ['startScriptRun', { path: { script: script.id }, body: { scans: [scan.id], settings: { limit: 1 } } }],
      ]
      for (const [operation, options] of foreign) {
        const response = await otherApi.call(operation, options)
        expect(response.status, operation).toBe(404)
        expect(errorOf(response).code, operation).toBe('notFound')
      }
    },
  )

  test(
    'a sample run with settings.limit reads limit analyses; a restart with resume continues after its checkpoint with its outputs',
    { tag: ['@SRUN-006', '@SRUN-007'] },
    async ({ api, scripts, filesScan }) => {
      const { scan, rows } = filesScan
      const scanName = scan.name ?? scan.id
      const script = await scripts.fixture('files-report')
      const sample = await runScript(api, script.name, { scans: [scan.id], settings: { limit: 4 } })
      const sampled = rows.slice(0, 4)
      expect(sample.input.settings.limit).toBe(4)
      expect(sample.result).toEqual(filesReportResult(scanName, sampled, false))
      expect(sample.progress).toMatchObject({ done: 4, total: 4 })
      expect(await readOutputText(api, sample.id, outputNamed(sample, 'files.csv').id)).toBe(filesReportCsv(sampled))
      expect(sample.checkpoint).not.toBeNull()

      // The restart reads the rest: files-report copies the sample's files.csv from ctx.resume_outputs and streams
      // after the seq of ctx.resume_state, so every row is written exactly once.
      const restarted = await restartScriptRun(api, sample.id, { resume: true, settings: { limit: null } })
      expect(restarted.status).toBe(201)
      expect(restarted.body).toMatchObject({
        scriptId: script.id,
        scans: [{ id: scan.id, name: scan.name }],
        restartedFrom: { id: sample.id, resume: true },
        source: { packSha256: sample.source.packSha256 },
        // The original's config, now checked against the schema the sample reported (defaults filled).
        input: { config: { workers: 8 }, settings: { limit: null } },
      })
      const resumed = await waitForScriptRun(api, restarted.body.id, 'completed')
      expect(resumed.image).toEqual({ ref: sample.image!.ref, cached: true })
      expect(resumed.result).toEqual(filesReportResult(scanName, rows, true))
      expect(resumed.progress).toMatchObject({ done: rows.length, total: rows.length })
      expect(await readOutputText(api, resumed.id, outputNamed(resumed, 'files.csv').id)).toBe(filesReportCsv(rows))
      // The sample is unchanged.
      expect(ok(await getScriptRun(api, sample.id), 'getScriptRun')).toMatchObject({ state: 'completed', result: sample.result, outputs: sample.outputs })
      const recent = ok(await getScript(api, script.name), 'getScript').recentRuns!.map((run) => run.id)
      expect(recent).toEqual([resumed.id, sample.id])
    },
  )
})

test.describe('stopping runs', () => {
  test(
    'cancelling a running run stops and removes its container and keeps the outputs stored so far',
    { tag: ['@SRUN-008', '@SRUN-007', '@SRUN-019'] },
    async ({ api, scripts, filesScan }) => {
      const script = await scripts.upload(probeScriptFiles())
      const created = await startRun(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'wait', label: 'cancel' } })
      await waitForScriptRunLog(api, created.id, probeWaiting('cancel'))
      expect(await scriptRunContainerState(created.id)).toBe('running')
      const running = ok(await getScriptRun(api, created.id), 'getScriptRun')
      expect(running).toMatchObject({ state: 'running', finishedAt: null, exitCode: null })
      expect(running.startedAt).toMatch(ISO_DATE)
      // The open output stream.txt is pending, so it is not listed.
      expect(running.outputs.map((output) => output.name)).toEqual(['before.txt'])

      // Only a terminal run can be resumed.
      const early = await restartScriptRun(api, created.id, { resume: true })
      expect(early.status).toBe(409)
      expect(errorOf(early)).toMatchObject({ code: 'invalidState', details: { state: 'running', allowed: ['completed', 'failed', 'cancelled'] } })

      const cancelled = ok(await cancelScriptRun(api, created.id), 'cancelScriptRun')
      expect(cancelled).toMatchObject({ id: created.id, state: 'cancelled', error: null })
      expect(cancelled.finishedAt).toMatch(ISO_DATE)
      expect(ok(await cancelScriptRun(api, created.id), 'cancelScriptRun')).toMatchObject({ state: 'cancelled', finishedAt: cancelled.finishedAt })

      // The job stops the container (SIGTERM: the script ends with code 143) and removes it; a wait settles only once
      // the container stopped and its exit code is stored.
      const waited = await getScriptRun(api, created.id, 50)
      expect(waited.headers['scantor-wait']).toBe('settled')
      expect(waited.body).toMatchObject({ state: 'cancelled', exitCode: 143, finishedAt: cancelled.finishedAt })
      await waitForScriptRunContainerGone(created.id)
      await waitForScriptRunLog(api, created.id, systemLine('the script run was cancelled'))
      const final = ok(await getScriptRun(api, created.id), 'getScriptRun')
      expect(final.state).toBe('cancelled')
      expect(await readOutputText(api, final.id, outputNamed(final, 'before.txt').id)).toBe('cancel before the wait')
      expect(ok(await getScript(api, script.name), 'getScript').latestRun).toMatchObject({
        id: created.id,
        state: 'cancelled',
        finishedAt: cancelled.finishedAt,
      })
    },
  )

  test(
    'an output open when the run is cancelled is stored as <name>.partial, which a resume right after the cancel waits for',
    { tag: ['@SRUN-009', '@SRUN-007'] },
    async ({ api, scripts, filesScan }) => {
      const script = await scripts.upload(probeScriptFiles())
      const created = await startRun(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'wait', label: 'partial-cancel' } })
      await waitForScriptRunLog(api, created.id, probeWaiting('partial-cancel'))
      ok(await cancelScriptRun(api, created.id), 'cancelScriptRun')
      // The container is still stopping: the resume waits for it, so the original's .partial output and exit code are
      // stored once the restart returns.
      const resumed = await restartScriptRun(api, created.id, { resume: true, config: { mode: 'ok', label: 'resumed' } })
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(201)
      expect(resumed.body.restartedFrom).toEqual({ id: created.id, resume: true })
      const stopped = ok(await getScriptRun(api, created.id), 'getScriptRun')
      expect(stopped).toMatchObject({ state: 'cancelled', exitCode: 143 })
      expect(stopped.outputs.map((output) => output.name).sort()).toEqual(['before.txt', 'stream.txt.partial'])
      expect(await readOutputText(api, stopped.id, outputNamed(stopped, 'stream.txt.partial').id)).toBe('partial-cancel first line\n')
      await waitForScriptRunContainerGone(created.id)
      expect((await waitForScriptRun(api, resumed.body.id, 'completed')).result).toMatchObject({ mode: 'ok', label: 'resumed' })
    },
  )

  test(
    'a run past settings.timeoutMs fails with timeout; its open output is stored as <name>.partial',
    { tag: ['@SRUN-014', '@SRUN-009'] },
    async ({ api, scripts, filesScan }) => {
      const script = await scripts.upload(probeScriptFiles())
      const run = await runScript(
        api,
        script.name,
        { scans: [filesScan.scan.id], config: { mode: 'wait', label: 'timeout' }, settings: { timeoutMs: 10_000 } },
        { state: 'failed' },
      )
      expect(run).toMatchObject({
        exitCode: 143,
        errors: [],
        error: { type: 'timeout', message: expect.stringContaining('timeout') },
        input: { settings: { timeoutMs: 10_000 } },
      })
      expect(Date.parse(run.finishedAt!) - Date.parse(run.startedAt!)).toBeGreaterThanOrEqual(10_000)
      expect(run.outputs.map((output) => output.name).sort()).toEqual(['before.txt', 'stream.txt.partial'])
      expect(await readOutputText(api, run.id, outputNamed(run, 'stream.txt.partial').id)).toBe('timeout first line\n')
      await waitForScriptRunLog(api, run.id, (line) => line.stream === 'system' && line.text.includes('exceeded its timeout'))
      await waitForScriptRunContainerGone(run.id)
    },
  )

  test('deleting a scan cancels the runs that read it', { tag: ['@SRUN-015'] }, async ({ api, scripts, scans, filesScan }) => {
    test.setTimeout(480_000)
    // A scan that never gets a worker: the run may read a scan that has not finished.
    const scan = await scans.start({ revision: filesScan.revision.ref, scanConfig: { items: ['one'] }, settings: UNPLACEABLE_SETTINGS })
    const script = await scripts.upload(probeScriptFiles())
    const created = await startRun(api, script.name, { scans: [scan.id, filesScan.scan.id], config: { mode: 'wait', label: 'scan-delete' } })
    await waitForScriptRunLog(api, created.id, probeWaiting('scan-delete'))
    // The run says that it reads a scan that has not finished.
    await waitForScriptRunLog(api, created.id, (line) => line.stream === 'system' && line.text.startsWith(`scan ${scan.name ?? scan.id} is `))

    ok(await api.cancelScan(scan.id), 'cancelScan')
    await waitForScanState(api, scan.id, 'cancelled', 120_000)
    expect(ok(await getScriptRun(api, created.id), 'getScriptRun').state).toBe('running')
    expect((await api.deleteScan(scan.id)).status).toBe(202)
    const cancelled = await waitForScriptRun(api, created.id, 'cancelled', 300_000)
    expect(cancelled.error).toEqual({ type: 'platform', message: 'a scan of the run was deleted' })
    await waitForScriptRunContainerGone(created.id)
  })
})

test.describe('failures', () => {
  test(
    'a run fails with the error when its script raises, exits or runs out of memory',
    { tag: ['@SRUN-014', '@SRUN-009'] },
    async ({ api, scripts, filesScan }) => {
      const script = await scripts.upload(probeScriptFiles())
      const scans = [filesScan.scan.id]
      const [raised, exited, oom] = await Promise.all([
        runScript(api, script.name, { scans, config: { mode: 'fail', label: 'raised' } }, { state: 'failed' }),
        runScript(api, script.name, { scans, config: { mode: 'exit', count: 3 } }, { state: 'failed' }),
        runScript(api, script.name, { scans, config: { mode: 'memory' }, settings: { resources: { memoryMiB: 256 } } }, { state: 'failed' }),
      ])
      expect(raised).toMatchObject({
        exitCode: 1,
        errors: [],
        error: { type: 'scriptError', message: expect.stringContaining('probe failure raised'), stack: expect.stringContaining('RuntimeError') },
      })
      // The open output keeps what was written, as <name>.partial.
      expect(raised.outputs.map((output) => output.name)).toEqual(['stream.txt.partial'])
      expect(await readOutputText(api, raised.id, outputNamed(raised, 'stream.txt.partial').id)).toBe('raised first line\n')
      expect(exited).toMatchObject({ exitCode: 3, errors: [], error: { type: 'crash', message: 'exited with code 3' } })
      expect(oom).toMatchObject({
        errors: [],
        error: { type: 'crash', message: 'killed: out of memory' },
        input: { settings: { resources: { memoryMiB: 256 } } },
      })
      for (const run of [raised, exited, oom]) await waitForScriptRunContainerGone(run.id)
    },
  )

  test(
    'a folder that does not build fails the run with BuildErrors of phase static, build or config',
    { tag: ['@SRUN-013'] },
    async ({ api, scripts, filesScan }) => {
      const files = probeScriptFiles()
      const script = await scripts.upload(files)
      const scans = [filesScan.scan.id]
      const manifest = editScriptManifest(scriptFileText(files, SCRIPT_MANIFEST), { name: script.name })
      const unbuilt = { error: null, exitCode: null, image: null, startedAt: null, result: null }

      // static: the manifest names another script.
      ok(await writeScriptFiles(api, script.name, { [SCRIPT_MANIFEST]: editScriptManifest(manifest, { name: unique('another') }) }), 'writeScriptFiles')
      const staticRun = await runScript(api, script.name, { scans }, { state: 'failed' })
      expect(staticRun).toMatchObject(unbuilt)
      expect(staticRun.errors.length).toBeGreaterThan(0)
      expect(staticRun.errors.map((error) => error.phase)).toEqual(staticRun.errors.map(() => 'static'))
      expect(staticRun.errors).toContainEqual(expect.objectContaining({ phase: 'static', file: SCRIPT_MANIFEST }))

      // build: a Dockerfile step fails; its output is in the log.
      ok(
        await writeScriptFiles(api, script.name, { [SCRIPT_MANIFEST]: manifest, Dockerfile: `${SCRIPT_DOCKERFILE}RUN echo probe-build-step && exit 3\n` }),
        'writeScriptFiles',
      )
      const buildRun = await runScript(api, script.name, { scans }, { state: 'failed' })
      expect(buildRun).toMatchObject(unbuilt)
      expect(buildRun.errors).toContainEqual(expect.objectContaining({ phase: 'build' }))
      const buildLines = (await allScriptRunLogs(api, buildRun.id)).filter((line) => line.stream === 'build')
      expect(
        buildLines.some((line) => line.text.includes('probe-build-step')),
        JSON.stringify(buildLines.slice(-20)),
      ).toBe(true)

      // config: manifest defaults above the instance limits.
      const limits = scriptRunLimits()
      ok(
        await writeScriptFiles(api, script.name, {
          Dockerfile: SCRIPT_DOCKERFILE,
          [SCRIPT_MANIFEST]: editScriptManifest(manifest, { defaults: { timeoutMs: limits.timeoutMs + 1000, resources: { cpus: 64, memoryMiB: 256 } } }),
        }),
        'writeScriptFiles',
      )
      expect(limits.maxCpus).toBeLessThan(64)
      const configRun = await runScript(api, script.name, { scans }, { state: 'failed' })
      expect(configRun).toMatchObject(unbuilt)
      expect(configRun.errors).toHaveLength(2)
      expect(configRun.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: 'config', file: SCRIPT_MANIFEST, message: expect.stringMatching(/timeoutMs.*SCANTOR_SCRIPT_RUN_TIMEOUT/) }),
          expect.objectContaining({ phase: 'config', file: SCRIPT_MANIFEST, message: expect.stringMatching(/cpus.*SCANTOR_SCRIPT_RUN_MAX_CPUS/) }),
        ]),
      )
    },
  )
})

test.describe('inputs', () => {
  test('start inputs are checked before a run is queued', { tag: ['@SRUN-011'] }, async ({ api, scripts, filesScan }) => {
    const script = await scripts.upload(probeScriptFiles())
    const scanId = filesScan.scan.id
    const limits = scriptRunLimits()
    const invalid: [string, Record<string, unknown>][] = [
      ['scans', {}],
      ['scans', { scans: [] }],
      ['scans', { scans: Array.from({ length: 21 }, () => randomUUID()) }],
      ['scans', { scans: ['not-a-uuid'] }],
      ['config', { scans: [scanId], config: 'text' }],
      ['config', { scans: [scanId], config: [1] }],
      ['settings', { scans: [scanId], settings: { limit: 0 } }],
      ['settings', { scans: [scanId], settings: { timeoutMs: 999 } }],
      ['settings', { scans: [scanId], settings: { resources: { memoryMiB: 255 } } }],
      ['settings', { scans: [scanId], settings: { resources: { cpus: 0 } } }],
      ['settings', { scans: [scanId], settings: { workers: 2 } }],
      ['secrets', { scans: [scanId], secrets: { lower: 'value-1' } }],
      ['secrets', { scans: [scanId], secrets: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`SECRET_${n}`, 'value-1'])) }],
      ['secrets', { scans: [scanId], secrets: { BIG: 'x'.repeat(8193) } }],
    ]
    for (const [path, body] of invalid) {
      const label = JSON.stringify(body).slice(0, 120)
      const response = await startScriptRun(api, script.name, body)
      expect(response.status, label).toBe(400)
      expect(errorOf(response).code, label).toBe('validationFailed')
      expect(
        issuePaths(response).some((issue) => issue.replace(/^\//, '').startsWith(path)),
        `${label}: ${JSON.stringify(issuePaths(response))}`,
      ).toBe(true)
    }
    const unknownKey = await startScriptRun(api, script.name, { scans: [scanId], unknownKey: true })
    expect(unknownKey.status).toBe(400)
    expect(errorOf(unknownKey).code).toBe('validationFailed')

    // Every scan must be one of the owner's.
    const missing = await startScriptRun(api, script.name, { scans: [scanId, randomUUID()] })
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('notFound')

    // Settings above the instance limits.
    const caps = await startScriptRun(api, script.name, {
      scans: [scanId],
      settings: { timeoutMs: limits.timeoutMs + 1, resources: { cpus: limits.maxCpus + 1, memoryMiB: limits.maxMemoryMiB + 1 } },
    })
    expect(caps.status).toBe(400)
    expect(errorOf(caps).code).toBe('validationFailed')
    const capPaths = issuePaths(caps)
    for (const setting of [/timeoutMs$/, /cpus$/, /memoryMiB$/])
      expect(
        capPaths.some((path) => setting.test(path)),
        `${setting}: ${capPaths}`,
      ).toBe(true)

    // A config above SCANTOR_MAX_SCAN_CONFIG_BYTES.
    const tooLarge = await startScriptRun(api, script.name, { scans: [scanId], config: { pad: 'x'.repeat(limits.maxScanConfigBytes) } })
    expect(tooLarge.status).toBe(413)
    expect(errorOf(tooLarge)).toMatchObject({ code: 'payloadTooLarge', details: { limit: limits.maxScanConfigBytes } })

    // None of these queued a run.
    expect(ok(await api.call<Page<ScriptRun>>('listScriptRuns', { path: { script: script.name } }), 'listScriptRuns').items).toEqual([])

    // A scan given twice is read once.
    const deduplicated = await startRun(api, script.name, { scans: [scanId, scanId], settings: { limit: 1 } })
    expect(deduplicated.scans.map((scan) => scan.id)).toEqual([scanId])
    ok(await cancelScriptRun(api, deduplicated.id), 'cancelScriptRun')
  })

  test('a reported config schema checks the config of the next run of the same folder content', { tag: ['@SRUN-012'] }, async ({ api, scripts, filesScan }) => {
    const script = await scripts.upload(probeScriptFiles())
    const scans = [filesScan.scan.id]
    expect(script.describe).toBeNull()
    const first = await runScript(api, script.name, { scans, config: { label: 'first' } })
    expect(first.input.config).toEqual({ label: 'first' })
    expect(first.result).toEqual({
      mode: 'ok',
      label: 'first',
      scans: [filesScan.scan.name ?? filesScan.scan.id],
      totals: [FILES_ITEMS.length],
      limit: null,
      secrets: {},
      resumed: null,
      outputs: [],
    } satisfies ProbeResult)
    expect(ok(await getScript(api, script.name), 'getScript').describe).toMatchObject({
      packSha256: first.source.packSha256,
      configSchema: {
        additionalProperties: false,
        properties: { mode: expect.objectContaining({ default: 'ok' }), label: expect.anything(), count: expect.anything() },
      },
      resultSchema: { properties: expect.objectContaining({ mode: expect.anything(), totals: expect.anything() }) },
      at: expect.stringMatching(ISO_DATE),
    })

    const invalid = await startScriptRun(api, script.name, { scans, config: { mode: 'nonsense', count: 1001, extra: true } })
    const issues = apiErrorOf(invalid, 422, 'configInvalid').details?.issues as { path: string; message: string }[]
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['/config/mode', '/config/count', '/config/extra']))

    // Omitted fields get their defaults.
    const second = await startRun(api, script.name, { scans, config: { label: 'second' } })
    expect(second.input.config).toEqual({ mode: 'ok', label: 'second', count: 1 })
    expect((await waitForScriptRun(api, second.id, 'completed')).result).toMatchObject({ label: 'second' })

    // A changed folder has no reported schema yet: the script itself rejects the config.
    ok(await writeScriptFiles(api, script.name, { 'notes.txt': 'changed\n' }), 'writeScriptFiles')
    const changed = await startRun(api, script.name, { scans, config: { mode: 'nonsense' } })
    expect(changed.input.config).toEqual({ mode: 'nonsense' })
    const rejected = await waitForScriptRun(api, changed.id, 'failed')
    expect(rejected).toMatchObject({ exitCode: 1, errors: [], error: { type: 'validation', message: expect.stringContaining('mode') } })
    expect(ok(await getScript(api, script.name), 'getScript').describe?.packSha256).toBe(changed.source.packSha256)
  })

  test(
    'secrets reach the script as ctx.secrets, are listed by name only and masked in the log; a restart carries them',
    { tag: ['@SRUN-010', '@SRUN-007'] },
    async ({ api, scripts, filesScan }) => {
      const script = await scripts.upload(probeScriptFiles())
      const secrets = { API_TOKEN: `token-${randomBytes(8).toString('hex')}`, DB_PASSWORD: `password-${randomBytes(8).toString('hex')}` }
      const leaks = (text: string) => Object.values(secrets).filter((value) => text.includes(value))

      const created = await startScriptRun(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'secrets' }, secrets })
      expect(created.status).toBe(201)
      expect(leaks(created.raw.toString('utf8'))).toEqual([])
      expect([...created.body.secrets].sort()).toEqual(['API_TOKEN', 'DB_PASSWORD'])
      const run = await waitForScriptRun(api, created.body.id, 'completed')
      expect((run.result as ProbeResult).secrets).toEqual({ API_TOKEN: sha256(secrets.API_TOKEN), DB_PASSWORD: sha256(secrets.DB_PASSWORD) })

      await waitForScriptRunLog(api, run.id, systemLine('the script exited with code 0'))
      const lines = await allScriptRunLogs(api, run.id)
      expect(leaks(JSON.stringify(lines))).toEqual([])
      for (const name of Object.keys(secrets)) {
        expect(lines).toContainEqual(expect.objectContaining({ stream: 'stdout', text: `stdout ${name}=***` }))
        expect(lines).toContainEqual(expect.objectContaining({ stream: 'stderr', text: `stderr ${name}=***` }))
      }
      // The run's own token is redacted as well.
      expect(lines).toContainEqual(expect.objectContaining({ stream: 'stdout', text: 'token ssr_***' }))
      for (const response of [
        await getScriptRun(api, run.id),
        await getScriptRunLogs(api, run.id),
        await api.call('listScriptRuns', { path: { script: script.name } }),
      ]) {
        expect(response.status).toBe(200)
        expect(leaks(response.raw.toString('utf8'))).toEqual([])
      }

      // A restart carries the secrets (sealed again for the new run).
      const restarted = await restartScriptRun(api, run.id)
      expect(restarted.status).toBe(201)
      expect(restarted.body).toMatchObject({ restartedFrom: { id: run.id, resume: false }, input: { config: { mode: 'secrets' } } })
      expect([...restarted.body.secrets].sort()).toEqual(['API_TOKEN', 'DB_PASSWORD'])
      const again = await waitForScriptRun(api, restarted.body.id, 'completed')
      expect(again.result).toMatchObject({ secrets: (run.result as ProbeResult).secrets, resumed: null })
      expect(leaks(JSON.stringify(await allScriptRunLogs(api, again.id)))).toEqual([])
    },
  )
})

test.describe('limits', () => {
  test(
    'the log is bounded: long lines are cut, floods are dropped and the middle of a long log goes',
    { tag: ['@SRUN-017'] },
    async ({ api, scripts, filesScan }) => {
      // The probe logs about 4.6 MiB: two kept heads of 1 MiB do not fit SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES (tests/docker/stack.env).
      expect(scriptRunLimits().maxLogBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
      const script = await scripts.upload(probeScriptFiles())
      const run = await runScript(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'logs' } })
      await waitForScriptRunLog(api, run.id, systemLine('the script exited with code 0'))
      const settled = ok(await getScriptRun(api, run.id), 'getScriptRun')
      const lines = await allScriptRunLogs(api, run.id)
      const numbers = lines.map((line) => line.line)
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
      expect(numbers[0]).toBe(1)
      expect(numbers.at(-1)).toBe(settled.log.lines)
      expect(settled.log.firstLine).toBe(1)

      // A line over 16 KiB is cut with a marker.
      const long = lines.find((line) => line.stream === 'stdout' && line.text.startsWith('LLLL'))
      expect(long?.text.endsWith(' [line truncated]')).toBe(true)
      expect(Buffer.byteLength(long!.text)).toBeLessThanOrEqual(16 * 1024)

      // The flood exceeded 2000 lines/s: lines were dropped (never numbered) with one marker per window.
      expect(lines).toContainEqual(
        expect.objectContaining({ stream: 'system', text: expect.stringContaining('lines are dropped for the rest of this 10 s window') }),
      )
      expect(lines.filter((line) => line.text.startsWith('flood ')).length).toBeLessThan(45_000)

      // Beyond the cap the head and the newest lines stay: numbered lines in between are gone.
      // Exactly one retention marker, after the gap: a later pass that drops the chunk holding it appends it again.
      const markers = lines.filter((line) => line.stream === 'system' && line.text.includes('lines in between are dropped'))
      expect(markers).toHaveLength(1)
      const gap = numbers.findIndex((number, index) => index > 0 && number > numbers[index - 1]! + 1)
      expect(markers[0]!.line).toBeGreaterThanOrEqual(numbers[gap]!)
      expect(numbers.some((number, index) => index > 0 && number > numbers[index - 1]! + 1)).toBe(true)
      expect(lines.map((line) => line.text)).toContain(`bulk 1999 ${'b'.repeat(2048)}`)
      const removed = settled.log.lines - lines.length
      expect(removed).toBeGreaterThan(0)
      // droppedLines counts both: the numbered lines the retention removed and the lines the rate limit refused.
      expect(settled.log.droppedLines).toBeGreaterThan(removed)
    },
  )

  test('a run stores at most SCANTOR_SCRIPT_RUN_MAX_OUTPUTS outputs', { tag: ['@SRUN-018'] }, async ({ api, scripts, filesScan }) => {
    const { maxOutputs } = scriptRunLimits()
    const script = await scripts.upload(probeScriptFiles())
    const run = await runScript(api, script.name, { scans: [filesScan.scan.id], config: { mode: 'outputs', count: maxOutputs + 1 } }, { state: 'failed' })
    expect(run).toMatchObject({ exitCode: 1, error: { type: 'scriptError' } })
    expect(run.outputs.map((output) => output.name).sort()).toEqual(Array.from({ length: maxOutputs }, (_, n) => `out-${n}.txt`).sort())
    const first = outputNamed(run, 'out-0.txt')
    expect(first).toMatchObject({ size: 'output 0'.length, sha256: sha256('output 0'), contentType: 'text/plain' })
    expect(first.sha256).toMatch(SHA256)
    expect(await readOutputText(api, run.id, first.id)).toBe('output 0')
  })
})
