import { defineEventHandler, getQuery, getRequestHeader } from 'h3'
import { useAuth } from '../utils/auth'
import { apiError } from '../utils/errors'
import { SESSION_COOKIE_NAMES } from '../utils/principal'
import { routedPathname } from '../utils/request-path'
import { credentialSummary } from '../utils/users'

// Credential invariant and passkey freshness guard (docs/auth.md §6.4):
// - deleting the last passkey of a user without a password is 409 lastCredential;
// - registering a passkey for a signed-in user needs a session younger than 24 h (403 sessionRequired), because
//   the passkey plugin runs with `requireSession: false` for the passkey-first setup flow;
// - without a session, generate-register-options needs the `context` (spk_ setup token) that
//   resolvePasskeySetupUser validates; verify-registration then completes the setup user.
// The rules key on the path better-auth routes (dot segments resolved), never on the raw request path.

const FRESH_SESSION_MS = 24 * 3_600_000

interface SessionResult {
  session: { createdAt: string | Date }
  user: { id: string }
}

async function currentSession(cookie: string | undefined): Promise<SessionResult | null> {
  if (!cookie || !cookie.split(';').some((part) => SESSION_COOKIE_NAMES.includes(part.split('=')[0]!.trim()))) return null
  try {
    return ((await useAuth().api.getSession({ headers: new Headers({ cookie }) })) as SessionResult | null) ?? null
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const pathname = routedPathname(event)
  if (!pathname.startsWith('/api/auth/passkey/')) return
  const action = pathname.slice('/api/auth/passkey/'.length)

  if (action === 'delete-passkey' && event.method === 'POST') {
    const session = await currentSession(getRequestHeader(event, 'cookie'))
    if (!session) return
    const summary = await credentialSummary(session.user.id)
    if (!summary.hasPassword && summary.passkeyCount <= 1) {
      throw apiError('lastCredential', 'cannot delete your last passkey while no password is set')
    }
    return
  }

  const registering =
    (action === 'generate-register-options' && event.method === 'GET') || (action === 'verify-registration' && event.method === 'POST')
  if (!registering) return
  const session = await currentSession(getRequestHeader(event, 'cookie'))
  if (session) {
    if (Date.now() - new Date(session.session.createdAt).getTime() > FRESH_SESSION_MS) {
      throw apiError('sessionRequired', 'registering a passkey needs a session younger than 24 hours; sign in again')
    }
    return
  }
  if (action === 'generate-register-options' && typeof getQuery(event).context !== 'string') {
    throw apiError('unauthorized', 'sign in to register a passkey')
  }
})
