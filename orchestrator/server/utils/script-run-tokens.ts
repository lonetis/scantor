import { timingSafeEqual } from 'node:crypto'
import type { ScriptRunDoc } from '../types/documents'
import { apiError } from './errors'
import { parseScriptRunToken, useKeys } from './keys'
import { useLogger } from './logger'
import { useCollections } from './mongo'
import type { ScriptRunPrincipal } from './principal'
import { getCachedUser, isUserBanned } from './user-cache'

// Script-run tokens (docs/scripts.md, docs/auth.md): `ssr_<scriptRunId>.<mac>` with the MAC over the run id, its script
// and its owner, derived from HKDF "script-run-token", never stored. Validation reads the run document on every request
// (no cache), so a token stops working as soon as its run leaves `running`; a banned owner's runs are refused at once,
// before the lockout hook has cancelled them. A failed read of the run or the owner is 503 `unavailable`, never 401,
// like the user credential lookups (utils/credential-lookup.ts): a MongoDB election must not end a running script.

const log = useLogger('auth')

/** The token handed to the container of a script run. */
export function mintScriptRunToken(run: Pick<ScriptRunDoc, '_id' | 'scriptId' | 'userId'>): string {
  return useKeys().scriptRunToken(run._id, run.scriptId, run.userId)
}

/** Resolves a script-run token to its principal, or null when malformed, unknown, not running, forged or banned. */
export async function resolveScriptRunToken(token: string): Promise<ScriptRunPrincipal | null> {
  const parsed = parseScriptRunToken(token)
  if (!parsed) return null
  const run = await checked(() =>
    useCollections().scriptRuns.findOne(
      { _id: parsed.scriptRunId },
      { projection: { _id: 1, userId: 1, scriptId: 1, scanIds: 1, state: 1, 'input.settings.limit': 1 } },
    ),
  )
  if (!run || run.state !== 'running') return null
  const expected = Buffer.from(useKeys().scriptRunTokenMac(run._id, run.scriptId, run.userId))
  const presented = Buffer.from(parsed.mac)
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null
  const owner = await checked(() => getCachedUser(run.userId))
  if (!owner || isUserBanned(owner)) return null
  return {
    kind: 'scriptRun',
    scriptRun: { id: run._id, userId: run.userId, scriptId: run.scriptId, scanIds: [...run.scanIds], limit: run.input?.settings?.limit ?? null },
  }
}

/** A lookup of the token check; a failure throws 503 `unavailable` (the token could not be checked, not rejected). */
async function checked<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup()
  } catch (error) {
    log.error('the script-run token lookup failed', { err: error })
    throw apiError('unavailable', 'the script-run token cannot be checked right now; retry shortly')
  }
}
