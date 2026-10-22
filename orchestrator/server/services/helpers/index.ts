import { executeHelper, ensureUserDirsWith, useHelperRuntime } from './executor'
import { HELPER_OPS, type HelperOp, type HelperResult, type HelperRunOptions, type HelperStreamOptions } from './types'

// Workspace helpers (docs/editor.md §9): the only code that touches workspace content, always through throwaway
// `scantor workspace <op>` containers. Other areas use this entry point:
//
//   runHelper(op, {userId, args, stdin, network, env})   raw run of one operation under the per-user lock and a
//                                                        global slot; check the outcome with ./protocol
//   ensureUserDirs(userId)                               runs `init` once per process (the editor calls it before
//                                                        every start; docs/editor.md §9.8)
//
// Typed operations (list, read, write-files, extract, git, commit, snapshot, …) live in ./ops.

export type { HelperOp, HelperResult, HelperRunOptions, HelperStreamOptions } from './types'
export { checkHelperResult, HelperError, isHelperCode, parseHelperStdout } from './protocol'

export function runHelper(op: HelperOp | string, opts: HelperRunOptions, stream?: HelperStreamOptions): Promise<HelperResult> {
  if (!(HELPER_OPS as readonly string[]).includes(op)) return Promise.reject(new Error(`unknown workspace helper operation ${op}`))
  return executeHelper(op as HelperOp, opts, stream)
}

export function ensureUserDirs(userId: string): Promise<void> {
  return ensureUserDirsWith(useHelperRuntime(), userId)
}
