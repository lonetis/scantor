// In-process cancellation of script runs (docs/scripts.md): cancelScriptRun aborts the run's job at once when this
// process runs it; a job in another process notices the cancellation at its next lease renewal (at most 10 s).

const controllers = new Map<string, AbortController>()

/** The cancellation signal of a run this process executes; released with releaseCancellation. */
export function cancellationFor(scriptRunId: string): AbortController {
  let controller = controllers.get(scriptRunId)
  if (!controller || controller.signal.aborted) {
    controller = new AbortController()
    controllers.set(scriptRunId, controller)
  }
  return controller
}

export function releaseCancellation(scriptRunId: string, controller: AbortController): void {
  if (controllers.get(scriptRunId) === controller) controllers.delete(scriptRunId)
}

/** Aborts the run's job when this process executes it; a no-op otherwise. */
export function requestCancellation(scriptRunId: string): void {
  controllers.get(scriptRunId)?.abort(new Error('the script run was cancelled'))
}
