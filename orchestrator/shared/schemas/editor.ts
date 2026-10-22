import { z } from 'zod'
import { TOOL_TARGETS } from '../utils/enums'
import { taskNameProblem } from '../utils/slug'

// Request schemas of the editor and tools routes (docs/api.md §4.18; zod, strict objects, docs/api.md §1.5).

/** A task name (slug, not reserved, not uuid-shaped) that selects the folder the editor opens. */
const openTaskName = z
  .string()
  .max(64)
  .superRefine((value, ctx) => {
    const problem = taskNameProblem(value)
    if (problem) ctx.addIssue({ code: 'custom', message: `task name ${problem}` })
  })

/** `POST /api/editor/session` (`createEditorSession`). */
export const createEditorSessionBody = z.strictObject({
  open: openTaskName.optional(),
})
export type CreateEditorSessionBody = z.infer<typeof createEditorSessionBody>

/** `GET /api/tools/session?target=` (`createToolsSession`). */
export const toolsSessionQuery = z.strictObject({
  target: z.enum(TOOL_TARGETS),
})
export type ToolsSessionQuery = z.infer<typeof toolsSessionQuery>
