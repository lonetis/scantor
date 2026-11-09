import type { ScriptDescribeDoc } from '../../types/documents'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { isoDate } from '../../utils/serialize'
import { loadRunningRun } from './run'
import type { ScriptDescribeBody } from './schemas'

// scriptRuntimeDescribe (docs/scripts.md): the script's code reports the JSON Schemas of its config and result models
// at start. They are stored on the script for the pack the run was built from (`run.source.packSha256`), so the run form
// and startScriptRun validate a config only while the folder still holds that code. The last report wins.

export async function describeScript(principal: ScriptRunPrincipal, body: ScriptDescribeBody, now = new Date()): Promise<{ packSha256: string; at: string }> {
  const run = await loadRunningRun(principal, { _id: 1, scriptId: 1, 'source.packSha256': 1 })
  const describe: ScriptDescribeDoc = { packSha256: run.source.packSha256, configSchema: body.configSchema, resultSchema: body.resultSchema, at: now }
  const written = await useCollections().scripts.updateOne({ _id: run.scriptId, userId: principal.scriptRun.userId }, { $set: { describe } })
  if (written.matchedCount === 0) throw apiError('notFound', 'the script of this run no longer exists')
  return { packSha256: describe.packSha256, at: isoDate(now) }
}
