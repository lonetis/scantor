import { expect, type Page, type Response } from '@playwright/test'

// Browser helpers (docs/testing.md §7.8, §9). Select by role and accessible name; never by icon, index or tooltip.

/**
 * page.goto that retries only on net::ERR_NETWORK_CHANGED, which Chromium reports when the inner dockerd changes the
 * runner's network interfaces (a new container network) during the navigation.
 */
export async function gotoWithRetry(page: Page, url: string, attempts = 3): Promise<Response | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url)
    } catch (error) {
      if (attempt >= attempts || !String(error).includes('net::ERR_NETWORK_CHANGED')) throw error
    }
  }
}

/** Expects an open toast with the text (Nuxt UI renders toasts as list items of the "Notifications" region). */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  const toasts = page.getByRole('region', { name: /notifications/i }).locator('li[data-state="open"]')
  await expect(toasts.filter({ hasText: text }).first()).toBeVisible()
}

/** Opens a tab of a tabbed page by its accessible name. */
export async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
