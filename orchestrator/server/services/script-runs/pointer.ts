import type { ScriptRunDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { effectiveScriptRunState } from './mappers'

// The script's `latestRun` pointer (docs/data-model.md `scripts`): set when a run is created and updated on every state
// change of that run, but only while it is still the script's newest run. Two starts that race write their pointers
// in any order; the conditional keeps the run created last. When the run it names is deleted (retention, a start that
// failed after the insert), the pointer moves to the newest remaining run, or to null.

export async function setLatestRunPointer(run: Pick<ScriptRunDoc, '_id' | 'scriptId' | 'state' | 'createdAt' | 'finishedAt'>): Promise<void> {
  await useCollections().scripts.updateOne(
    { _id: run.scriptId, $or: [{ latestRun: null }, { 'latestRun.createdAt': { $lte: run.createdAt } }] },
    { $set: { latestRun: { id: run._id, state: run.state, createdAt: run.createdAt, finishedAt: run.finishedAt }, updatedAt: new Date() } },
  )
}

/** Refreshes the pointer of the script's newest run with the state clients see (a pending cancel is `cancelled`). */
export async function updateLatestRunPointer(run: Pick<ScriptRunDoc, '_id' | 'scriptId' | 'state' | 'cancelRequest' | 'finishedAt'>): Promise<void> {
  await useCollections().scripts.updateOne(
    { _id: run.scriptId, 'latestRun.id': run._id },
    { $set: { 'latestRun.state': effectiveScriptRunState(run), 'latestRun.finishedAt': run.finishedAt } },
  )
}

/**
 * Moves a pointer that names the deleted run `deletedRunId` to the script's newest remaining run (with the state
 * clients see), or to null without runs. A start that set its own pointer meanwhile wins: the update is conditional
 * on the pointer still naming the deleted run.
 */
export async function recomputeLatestRunPointer(scriptId: string, deletedRunId: string): Promise<void> {
  const { scriptRuns, scripts } = useCollections()
  const newest = await scriptRuns.findOne(
    { scriptId, _id: { $ne: deletedRunId } },
    { sort: { createdAt: -1 }, projection: { _id: 1, state: 1, cancelRequest: 1, createdAt: 1, finishedAt: 1 } },
  )
  const latestRun = newest ? { id: newest._id, state: effectiveScriptRunState(newest), createdAt: newest.createdAt, finishedAt: newest.finishedAt } : null
  await scripts.updateOne({ _id: scriptId, 'latestRun.id': deletedRunId }, { $set: { latestRun, updatedAt: new Date() } })
}
