import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { assertJsonSize, assertStorableJson } from './limits'
import { jsonByteLength, type ScriptFinishBody } from './schemas'
import { loadMaskableSecrets, maskScriptRunText } from './secrets'
import { flushScriptRunState } from './state'

// scriptRuntimeFinish (docs/scripts.md): the script's own outcome, exactly one of a result (any JSON value, at most
// SCANTOR_MAX_RESULT_BYTES, 413 above) or an error it reports itself (`scriptError`, `validation`; message and stack
// masked like the log). It is stored on the run (the last call wins); the run's job decides the final state when the
// container exits: exit code 0 → `completed` with the result, else `failed` with the reported error. The pending
// progress and checkpoint are written at once, because the script exits right after.

const log = useLogger('script-runtime')

export async function finishScriptRun(
  principal: ScriptRunPrincipal,
  body: ScriptFinishBody,
  config: Pick<Config, 'maxResultBytes'>,
): Promise<{ received: 'result' | 'error' }> {
  let set: Record<string, unknown>
  if ('result' in body) {
    assertJsonSize(jsonByteLength(body.result), config.maxResultBytes, 'the result')
    assertStorableJson(body.result, 'result')
    set = { result: body.result ?? null, error: null }
  } else {
    // Masked like the log, which shows the same text on stderr: the error reaches the API, MCP and push targets.
    const secrets = await loadMaskableSecrets(principal.scriptRun.id, log)
    const error = {
      type: body.error.type,
      message: maskScriptRunText(body.error.message, secrets),
      ...(body.error.stack === undefined ? {} : { stack: maskScriptRunText(body.error.stack, secrets) }),
    }
    set = { result: null, error }
  }
  const { id, userId } = principal.scriptRun
  const written = await useCollections().scriptRuns.updateOne({ _id: id, userId, state: 'running' }, { $set: { ...set, updatedAt: new Date() } })
  if (written.matchedCount === 0) throw apiError('unauthorized', 'the script run is no longer running')
  // A failed write stays pending and is retried; the outcome itself is stored.
  await flushScriptRunState(id).catch((error: unknown) => log.warn('writing the pending progress or checkpoint failed', { scriptRunId: id, err: error }))
  return { received: 'result' in body ? 'result' : 'error' }
}
