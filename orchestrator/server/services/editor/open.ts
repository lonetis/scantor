import type { CreateEditorSessionBody } from '#shared/schemas/editor'
import { resolveTask } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import type { FolderKind } from '../helpers/types'

// The folder the editor opens after the handoff (docs/editor.md §8.3, docs/scripts.md): `open` names one of the
// caller's tasks, `openScript` one of the caller's scripts. Both are looked up by name among the caller's own
// documents only, never by id and never across users (not even for admins: the editor shows only the caller's
// workspace), and the folder is built from the name, never taken from input.

/** The directory of script folders inside a workspace (hidden from the task list, visible in the editor). */
export const SCRIPTS_DIR = '.scripts'

/**
 * The workspace-relative folder of a task (`<name>`) or a script (`.scripts/<name>`): the one TS twin of the Go
 * helpers' (kind, name) → folder mapping. Names are slugs, so the result never contains `..` or a leading `/`.
 */
export function workspaceFolderPath(kind: FolderKind, name: string): string {
  return kind === 'script' ? `${SCRIPTS_DIR}/${name}` : name
}

/** The workspace-relative folder to open for a session request, or null for the workspace root. 404 for an unknown name. */
export async function resolveEditorFolder(principal: UserPrincipal, body: CreateEditorSessionBody): Promise<string | null> {
  if (body.openScript !== undefined) {
    const script = await useCollections().scripts.findOne(
      { userId: principal.user.id, name: body.openScript, deletingAt: null },
      { projection: { _id: 1, name: 1 } },
    )
    if (!script) throw apiError('notFound', 'script not found')
    return workspaceFolderPath('script', script.name)
  }
  if (body.open !== undefined) {
    // The schema rejects uuid-shaped values, so resolveTask looks the name up among the caller's tasks only.
    const task = await resolveTask(principal, body.open)
    return workspaceFolderPath('task', task.name)
  }
  return null
}
