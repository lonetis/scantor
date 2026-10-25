import type { Condition, Scan } from '#shared/types/scans'
import type { Page } from '@playwright/test'
import { expect, test, unique } from '../fixtures'
import { ok, type ApiClient } from '../helpers/api-client'
import { packTask, waitForRevision } from '../helpers/tasks'
import {
  SHARED_SETUP_TIMEOUT_MS,
  CRASH_LOOP_SETTINGS,
  PENDING_SETTINGS,
  badges,
  crashLoopTask,
  deleteOwnScans,
  expectAfterRefresh,
  gotoApp,
  headerState,
  openScanPage,
  patchJsonResponses,
  schedulingFailedScan,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  startOwnScan,
  waitForOwnScan,
  expectToast,
} from '../helpers/ui-scans-kit'

// The overview tab's health and settings cards of a scan (docs/ui.md §5.13.1): conditions sorted by severity with
// their type-specific details, and the effective settings, configs and template resolutions. Real conditions come
// from real scans (an impossible node selector, a connector killed before its handshake, a 100 %-failing scan, a
// failing schedule); conditions the shared stack must not be driven into (broker alarms, image pull failures, lost
// analyses) are injected into the page's getScan answers.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks of this spec are built before its first test in a worker, outside the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await sharedTasksOf(user, openapi, ['throws', 'schema-zoo', 'tranco-echo'])
})
test.afterEach(deleteOwnScans)

const healthCard = (page: Page) => page.getByTestId('scan-health')
const conditionItem = (page: Page, type: string) => healthCard(page).getByTestId(`condition-${type}`)
const settingsCard = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Settings and configuration' }) })

/** The condition types of the health card in display order. */
async function conditionOrder(page: Page): Promise<string[]> {
  return healthCard(page)
    .locator('li[data-testid^="condition-"]')
    .evaluateAll((items) => items.map((item) => (item.getAttribute('data-testid') ?? '').replace(/^condition-/, '')))
}

test.describe('scan health', () => {
  test(
    'a finished scan is healthy and its settings card shows settings, masked secrets, configs and its resolution',
    { tag: ['@UI-SCAN-028', '@UI-SCAN-033'] },
    async ({ page, user, openapi }) => {
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      const secret = `zoo-secret-${unique('value')}`
      const scan = await startOwnScan(user, openapi, {
        revision: zoo.revision.id,
        name: unique('health-zoo'),
        taskConfig: { text: 'settings card', api_token: secret },
      })
      const done = await waitForOwnScan(user, openapi, scan.id, 'completed', 120_000)

      await openScanPage(page, scan.id)
      await expect(healthCard(page)).toContainText('Healthy')
      await expect(healthCard(page).locator('[data-testid^="condition-"]')).toHaveCount(0)

      const settings = settingsCard(page)
      const effective = settings.locator('dl').first()
      for (const [label, value] of [
        ['Workers', '1'],
        ['Processes per worker', '1'],
        ['Resources per process', '0.25 CPU, 256 MiB'],
        ['Node pool', 'shared'],
        ['Node labels', '–'],
        ['Privileged', 'no'],
      ] as const) {
        await expect(effective.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]')).toHaveText(value)
      }
      const taskConfig = settings.locator('div', { has: page.getByRole('heading', { name: 'Task config' }) }).last()
      await expect(taskConfig).toContainText('"text"')
      await expect(taskConfig).toContainText('"settings card"')
      // The secret arrives as "***" and renders as a locked "secret"; its plaintext is nowhere on the page.
      const masked = taskConfig.getByTitle('Secret value, not shown')
      await expect(masked).toHaveText('secret')
      await expect(page.locator('body')).not.toContainText(secret)
      await expect(page.locator('body')).not.toContainText('***')
      // Every unwrapped template records its resolution under the key `schedule`, also the `single` template.
      expect(Object.keys(done.scheduling.resolved)).toEqual(['schedule'])
      await expect(settings.getByText('Template resolutions')).toBeVisible()
      const resolution = settings.locator('div.rounded-lg', { hasText: 'analyses expected' })
      await expect(resolution).toContainText('schedule')
      await expect(resolution).toContainText('single')
      await expect(resolution).toContainText('1 analyses expected')
      await expect(settings.getByText('Scheduling failed')).toHaveCount(0)
    },
  )

  test('template resolutions show the resolved scan config and its provenance', { tag: ['@UI-SCAN-033'] }, async ({ page, api, user, openapi }) => {
    const tranco = await sharedTask(user, openapi, 'tranco-echo')
    const scan = await startOwnScan(user, openapi, { revision: tranco.revision.id, name: unique('health-tranco'), scanConfig: { list: 'latest', limit: 3 } })
    const done = await waitForOwnScan(user, openapi, scan.id, 'completed', 120_000)
    const [key, resolution] = Object.entries(done.scheduling.resolved)[0]!
    expect(resolution.template).toBe('tranco')

    await openScanPage(page, scan.id)
    const settings = settingsCard(page)
    await expect(settings.getByText('Template resolutions')).toBeVisible()
    const card = settings.locator('div.rounded-lg', { hasText: '3 analyses expected' })
    await expect(card).toContainText(key)
    await expect(card).toContainText('tranco')
    expect(Object.keys(resolution.provenance).length).toBeGreaterThan(0)
    for (const [name, value] of Object.entries(resolution.provenance)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      await expect(card.locator('dt', { hasText: name }).first().locator('xpath=following-sibling::dd[1]')).toHaveText(text)
    }
    // The resolved scan config: the list pinned at scan start.
    await expect(card.locator('[data-slot="json-view"]')).toContainText('"limit"')
    expect(ok(await api.getScan(scan.id), 'getScan').scheduling.resolved[key]!.scanConfig).toMatchObject({ limit: 3 })
  })

  test(
    'an impossible node selector shows the pending workers with a readable reason',
    { tag: ['@UI-SCAN-029', '@UI-SCAN-028'] },
    async ({ page, api, user, openapi }) => {
      const throws = await sharedTask(user, openapi, 'throws')
      const scan = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('health-pending'), settings: PENDING_SETTINGS })
      const pending = await waitForCondition(api, scan.id, 'workersPending')

      await openScanPage(page, scan.id)
      const item = conditionItem(page, 'workersPending')
      await expect(item).toContainText('Workers cannot be placed')
      await expect(badges(item)).toHaveText('warning')
      await expect(item).toContainText(pending.reason)
      await expect(item).toContainText(pending.message)
      await expect(item).toContainText(/since (just now|\d+ min ago)/)
      const count = pending.details!.count as number
      await expect(item).toContainText(`${count} ${count === 1 ? 'worker' : 'workers'} pending`)
      const reasons = item.getByRole('table', { name: 'Pending reasons' })
      await expect(reasons.getByRole('row').filter({ hasText: 'No node matches the node selector' })).toContainText(String(count))
      await expect(reasons).not.toContainText('selectorMismatch')
      await expect(healthCard(page)).not.toContainText('Healthy')
    },
  )

  test(
    'a 100 %-failing scan trips the breaker, and "Resume scan" resumes it and clears the condition',
    { tag: ['@UI-SCAN-031', '@UI-SCAN-015'] },
    async ({ page, api, user, openapi }) => {
      test.setTimeout(180_000)
      const throws = await sharedTask(user, openapi, 'throws')
      // 30 analyses that fail without retry: the breaker trips after SCANTOR_BREAKER_MIN_ATTEMPTS (20) attempts, and the
      // fresh window after the resume never reaches 20 attempts again.
      const scan = await startOwnScan(user, openapi, {
        revision: throws.revision.id,
        name: unique('health-breaker'),
        taskConfig: { mode: 'fatal' },
        scanConfig: { start: 0, end: 30 },
      })
      const paused = await waitForOwnScan(user, openapi, scan.id, 'paused', 150_000)
      expect(paused.stateReason?.code).toBe('failureRate')
      const condition = await waitForCondition(api, scan.id, 'breakerTripped', 30_000)

      await openScanPage(page, scan.id)
      await expect(headerState(page)).toHaveText(/paused\s*· failure rate/)
      await expect(page.locator('header')).toContainText(paused.stateReason!.message)
      const item = conditionItem(page, 'breakerTripped')
      await expect(item).toContainText('Paused: failure rate')
      const details = condition.details as { ratio: number; attempts: number; windowMs: number }
      await expect(item).toContainText(`${(Math.round(details.ratio * 1000) / 10).toFixed(1)} % of ${details.attempts} attempts failed within 5m 00s`)

      await item.getByRole('button', { name: 'Resume scan' }).click()
      await expectToast(page, 'Scan resumed')
      await expect(conditionItem(page, 'breakerTripped')).toHaveCount(0)
      await expect(headerState(page)).toHaveText(/running|completed/)
      await waitForOwnScan(user, openapi, scan.id, 'completed', 120_000)
      await expectAfterRefresh(page, async () => {
        await expect(headerState(page)).toHaveText(/completed/, { timeout: 2000 })
      })
      await expect(conditionItem(page, 'breakerTripped')).toHaveCount(0)
    },
  )

  test(
    'a failing schedule shows schedulingFailed and the "Scheduling failed" alert; other conditions render their details',
    { tag: ['@UI-SCAN-032', '@UI-SCAN-033', '@UI-SCAN-028'] },
    async ({ page, user, openapi }) => {
      const failed = await schedulingFailedScan(user, openapi)
      const scan = failed
      const error = failed.scheduling.error!
      expect(error).not.toBeNull()
      expect(failed.stateReason?.code).toBe('schedulingFailed')

      await openScanPage(page, scan.id)
      await expect(headerState(page)).toHaveText(/failed\s*· scheduling failed/)
      const schedulingFailed = conditionItem(page, 'schedulingFailed')
      await expect(schedulingFailed).toContainText('Scheduling failed')
      await expect(badges(schedulingFailed).first()).toHaveText('error')
      await expect(schedulingFailed).toContainText(error.type)
      await expect(schedulingFailed).toContainText(error.phase)
      await expect(schedulingFailed).toContainText('demo exception in schedule')
      const settings = settingsCard(page)
      await expect(settings).toContainText('Scheduling failed')
      await expect(settings).toContainText(`${error.type} in ${error.phase}: ${error.message}`)

      // Conditions the shared stack must not be driven into, injected into this scan's getScan answers.
      const now = new Date().toISOString()
      const condition = (type: string, severity: Condition['severity'], details: Record<string, unknown>): Condition => ({
        type: type as Condition['type'],
        severity,
        reason: `${type}Reason`,
        message: `${type} message`,
        since: now,
        updatedAt: now,
        details,
      })
      const injected: Condition[] = [
        condition('workerErrors', 'warning', {
          workerId: 'aaaaaaaa-0000-4000-8000-000000000001',
          error: { type: 'platform', phase: 'upload', message: 'presign failed three times' },
        }),
        condition('schedulerRestarting', 'warning', { restarts: 2, error: { type: 'taskError', phase: 'schedule', message: 'schedule raised' } }),
        condition('imagePullFailed', 'error', { nodeId: 'bbbbbbbb-0000-4000-8000-000000000002', message: 'manifest unknown' }),
        condition('brokerAlarm', 'error', { alarms: ['memory', 'disk'] }),
        condition('stalled', 'warning', { lost: 3 }),
      ]
      // The real scan's own conditions of these types are replaced (one item per type).
      const injectedTypes = new Set(injected.map((entry) => entry.type))
      await patchJsonResponses(page, `**/api/scans/${scan.id}`, (body) => ({
        ...body,
        conditions: [...((body as unknown as Scan).conditions ?? []).filter((entry) => !injectedTypes.has(entry.type)), ...injected],
      }))
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()

      // Most severe first, then by type.
      await expect(conditionItem(page, 'stalled')).toBeVisible()
      expect(await conditionOrder(page)).toEqual(['brokerAlarm', 'imagePullFailed', 'schedulingFailed', 'schedulerRestarting', 'stalled', 'workerErrors'])
      const workerErrors = conditionItem(page, 'workerErrors')
      await expect(workerErrors).toContainText('Worker errors')
      await expect(workerErrors.locator('code[data-id="aaaaaaaa-0000-4000-8000-000000000001"]')).toHaveText('aaaaaaaa')
      await expect(workerErrors).toContainText('platform')
      await expect(workerErrors).toContainText('upload')
      await expect(workerErrors).toContainText('presign failed three times')
      const restarting = conditionItem(page, 'schedulerRestarting')
      await expect(restarting).toContainText('Scheduler restarting')
      await expect(restarting).toContainText('2 restarts')
      await expect(restarting).toContainText('taskError')
      await expect(restarting).toContainText('schedule raised')
      const pull = conditionItem(page, 'imagePullFailed')
      await expect(pull).toContainText('Image pull failed')
      await expect(pull.locator('dt', { hasText: 'Node' }).locator('xpath=following-sibling::dd[1]')).toHaveText('bbbbbbbb')
      await expect(pull).toContainText('manifest unknown')
      await expect(conditionItem(page, 'brokerAlarm')).toContainText('Alarms: memory, disk')
      await expect(conditionItem(page, 'stalled')).toContainText('3 analyses recorded as lost')
    },
  )
})

test.describe('crash loops of a user with a worker limit', () => {
  test.use({ pageUser: 'fresh' })
  // A fresh user signs in through the limiter, which the whole suite shares.
  test.describe.configure({ timeout: 180_000 })

  test(
    'crashLoop shows the worker, node, exit code, OOM badge, restarts and an ANSI-free log tail above workersPending',
    { tag: ['@UI-SCAN-030', '@UI-SCAN-029', '@UI-SCAN-028', '@UI-SCAN-016'] },
    async ({ page, freshUser, freshApi, adminApi, user, openapi }) => {
      // Two workers at most: the scheduler and one runner are placed, the other runners wait (userMaxWorkers).
      ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { maxWorkers: 2 } }), 'updateUser')
      const folder = await crashLoopTask()
      let revisionId: string
      try {
        const uploaded = ok(await freshApi.uploadTask(await packTask(folder.dir, { name: unique('crash-loop') }), { publish: true, wait: 120 }), 'uploadTask')
        revisionId = (await waitForRevision(freshApi, uploaded.task.id, uploaded.revision!.id)).id
      } finally {
        await folder.dispose()
      }
      // The fresh user and its scan are deleted at the end of the test (deleteUser purges them).
      const scan = ok(
        await freshApi.startScan({ revision: revisionId, name: unique('health-crash'), settings: { ...CRASH_LOOP_SETTINGS, workers: 3 } }),
        'startScan',
      )
      const crash = await waitForCondition(freshApi, scan.id, 'crashLoop', 150_000)
      const pending = await waitForCondition(freshApi, scan.id, 'workersPending', 60_000)
      expect((crash.details as { oomKilled: boolean }).oomKilled).toBe(true)

      await openScanPage(page, scan.id)
      // crashLoop is an error, workersPending a warning: the crash loop comes first.
      await expect(conditionItem(page, 'workersPending')).toBeVisible()
      const order = await conditionOrder(page)
      expect(order[0]).toBe('crashLoop')
      expect(order).toContain('workersPending')

      const item = conditionItem(page, 'crashLoop')
      await expect(item).toContainText('Worker crash loop')
      await expect(badges(item).first()).toHaveText('error')
      const field = (label: string) => item.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]')
      // The condition follows the latest crashing runner: compare with the scan's workers and the stack's nodes.
      const workerIds = ok(await freshApi.listScanWorkers(scan.id, { limit: 200 }), 'listScanWorkers').items.map((worker) => worker.id)
      const nodeIds = ok(await adminApi.listNodes(), 'listNodes').items.map((node) => node.id)
      const shownWorker = field('Worker').locator('code[data-id]')
      await expect(shownWorker).toHaveText(/^[0-9a-f]{8}$/)
      expect(workerIds).toContain(await shownWorker.getAttribute('data-id'))
      // Node pages are admin-only: the user sees the node's short id as text, not as a link.
      await expect(field('Node')).toHaveText(/^\s*[0-9a-f]{8}\s*$/)
      await expect(field('Node').getByRole('link')).toHaveCount(0)
      const shownNode = (await field('Node').textContent())!.trim()
      expect(nodeIds.some((id) => id.startsWith(shownNode))).toBe(true)
      await expect(field('Exit code')).toHaveText(/^\s*-?\d+/)
      await expect(field('Exit code').getByText('OOM killed')).toBeVisible()
      await expect(field('Restarts')).toHaveText(/^\d+$/)
      const log = item.getByTestId('condition-crashLoop-log')
      await expect(log).toContainText('crash-loop marker: allocating past the memory limit')
      expect(await log.textContent()).not.toContain('\u001b')

      const pendingItem = conditionItem(page, 'workersPending')
      await expect(pendingItem.getByRole('table', { name: 'Pending reasons' })).toContainText('Your worker limit is reached')
      expect(Object.keys(pending.details!.reasons as Record<string, number>)).toContain('userMaxWorkers')

      // Another user's scan (the tenant's), and an unknown scan, show "Scan not found" and nothing about the scan.
      const throws = await sharedTask(user, openapi, 'throws')
      const foreign = await startOwnScan(user, openapi, { revision: throws.revision.id, name: unique('foreign-scan'), settings: PENDING_SETTINGS })
      for (const scanId of [foreign.id, '00000000-0000-4000-8000-000000000000']) {
        await gotoApp(page, `/scans/${scanId}`)
        await expect(page.getByText('Scan not found', { exact: true })).toBeVisible()
        await expect(page.getByText('It does not exist or belongs to someone else.')).toBeVisible()
        await expect(page.getByRole('toolbar', { name: 'Scan controls' })).toHaveCount(0)
        await expect(page.locator('body')).not.toContainText(foreign.name!)
        await expect(page.locator('body')).not.toContainText(throws.revision.ref)
      }
    },
  )
})

async function waitForCondition(api: ApiClient, scanId: string, type: string, timeoutMs = 90_000): Promise<Condition> {
  let found: Condition | undefined
  await expect
    .poll(
      async () => {
        found = ok(await api.getScan(scanId), 'getScan').conditions.find((condition) => condition.type === type)
        return found?.type
      },
      { timeout: timeoutMs, intervals: [1000, 2000, 3000] },
    )
    .toBe(type)
  return found!
}
