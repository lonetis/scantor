import type { ScriptRunDoc } from '../../types/documents'
import { writeEvent } from '../scans/events'

// Script-run events (docs/data-model.md §4.11): `scriptRun.completed` (info) and `scriptRun.failed` (error) for the
// run's owner, with the subject refs scriptId and scriptRunId and data {scriptName, durationMs, error?}. A cancelled
// run writes none (the user cancelled it, or the cascade that cancelled it reports itself). Written through
// writeEvent, so the push notifications (triggers scriptRunCompleted, scriptRunFailed) see them.

export async function scriptRunEvent(run: ScriptRunDoc): Promise<void> {
  if (run.state !== 'completed' && run.state !== 'failed') return
  const durationMs = run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null
  const failed = run.state === 'failed'
  const reason = run.error?.message ?? run.errors[0]?.message
  await writeEvent({
    type: failed ? 'scriptRun.failed' : 'scriptRun.completed',
    level: failed ? 'error' : 'info',
    userId: run.userId,
    scriptId: run.scriptId,
    scriptRunId: run._id,
    message: failed ? `Script run of ${run.scriptName} failed${reason ? `: ${reason}` : ''}` : `Script run of ${run.scriptName} completed`,
    data: {
      scriptName: run.scriptName,
      durationMs,
      ...(failed ? { error: run.error ? { type: run.error.type, message: run.error.message } : { type: 'build', message: reason ?? 'the build failed' } } : {}),
    },
  })
}
