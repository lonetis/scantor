// Public API of @scantor/connector (docs/tasks.md §5.7, §5.8).
export { z, config, Empty, secret, FileRef, type ConfigSchema } from "./schema.ts";
export type { Context, Files, FileData, LogLevel } from "./context.ts";
export { Fatal, Retry, ScantorError, TaskDefinitionError, type Issue } from "./errors.ts";
export {
  defineTask,
  TaskDefinition,
  type RunFunction,
  type ScheduleFunction,
  type TaskDefinitionInput,
} from "./define.ts";
