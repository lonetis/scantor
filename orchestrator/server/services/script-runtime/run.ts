import type { Document } from 'mongodb'
import type { ScriptRunDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'

// The run of a script-run principal. The token was checked against the run document moments ago (the run was
// `running`); handlers that need more of the document read it again, still requiring `running`, so a run that ended
// in between answers 401 like an expired token.

export async function loadRunningRun(principal: ScriptRunPrincipal, projection?: Document): Promise<ScriptRunDoc> {
  const run = await useCollections().scriptRuns.findOne(
    { _id: principal.scriptRun.id, userId: principal.scriptRun.userId, state: 'running' },
    projection ? { projection } : {},
  )
  if (!run) throw apiError('unauthorized', 'the script run is no longer running')
  return run
}
