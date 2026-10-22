import type { CDPSession, Page } from '@playwright/test'

// A virtual WebAuthn authenticator on a Chromium page through the DevTools protocol (docs/testing.md §7.8): CTAP2,
// resident keys, user verification that always succeeds and automatic presence, so passkey registration and
// sign-in run without prompts. Passkey sign-ins must reserve '/passkey/verify-authentication' (helpers/limiter.ts)
// before the click that triggers them.

export interface VirtualCredential {
  credentialId: string
  isResidentCredential: boolean
  rpId?: string
  userHandle?: string
  signCount: number
}

export interface VirtualAuthenticator {
  readonly authenticatorId: string
  listCredentials(): Promise<VirtualCredential[]>
  /** user verification result of the next ceremonies (false simulates a refused fingerprint) */
  setUserVerified(verified: boolean): Promise<void>
  dispose(): Promise<void>
}

export async function installVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const session: CDPSession = await page.context().newCDPSession(page)
  await session.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  let disposed = false
  return {
    authenticatorId,
    async listCredentials() {
      const { credentials } = await session.send('WebAuthn.getCredentials', { authenticatorId })
      return credentials
    },
    async setUserVerified(verified: boolean) {
      await session.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      // The page may already be closed when a test failed; then the authenticator is gone with it.
      if (page.isClosed()) return
      await session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
      await session.detach()
    },
  }
}
