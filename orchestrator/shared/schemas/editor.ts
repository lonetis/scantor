import { z } from 'zod'
import { TOOL_TARGETS } from '../utils/enums'
import { taskNameProblem } from '../utils/slug'

// Request schemas of the editor and tools routes (docs/api.md §4.18; zod, strict objects, docs/api.md §1.5).

/**
 * A task or script name (slug, not reserved, not uuid-shaped; scripts follow the task name rules) that selects the
 * folder the editor opens. A name, never an id: the editor only ever shows the caller's own workspace.
 */
const folderName = (what: 'task' | 'script') =>
  z
    .string()
    .max(64)
    .superRefine((value, ctx) => {
      const problem = taskNameProblem(value)
      if (problem) ctx.addIssue({ code: 'custom', message: `${what} name ${problem}` })
    })

/** `POST /api/editor/session` (`createEditorSession`): `open` (a task) and `openScript` (a script) exclude each other. */
export const createEditorSessionBody = z
  .strictObject({
    open: folderName('task').optional(),
    openScript: folderName('script').optional(),
  })
  .superRefine((body, ctx) => {
    if (body.open !== undefined && body.openScript !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['openScript'], message: 'open and openScript cannot be combined' })
    }
  })
export type CreateEditorSessionBody = z.infer<typeof createEditorSessionBody>

/** `GET /api/tools/session?target=` (`createToolsSession`). */
export const toolsSessionQuery = z.strictObject({
  target: z.enum(TOOL_TARGETS),
})
export type ToolsSessionQuery = z.infer<typeof toolsSessionQuery>
