import type { Context } from "./context.ts";
import { TaskDefinitionError } from "./errors.ts";
import { Empty, isClosedObject, isConnectorSchema, type ConfigSchema, type z } from "./schema.ts";
import { templateOf, type TemplateRef, type TemplateSchedule } from "./templates/proxy.ts";
import { schedule as singleSchedule } from "./templates/single.ts";

type Awaitable<T> = T | Promise<T>;

export type ScheduleFunction<SC extends ConfigSchema, TC extends ConfigSchema, AC extends ConfigSchema> = (
  ctx: Context,
  scanConfig: z.output<SC>,
  taskConfig: z.output<TC>,
) => Iterable<z.input<AC>> | AsyncIterable<z.input<AC>>;

export type RunFunction<AC extends ConfigSchema, TC extends ConfigSchema, R extends z.ZodType> = (
  ctx: Context,
  analysisConfig: z.output<AC>,
  taskConfig: z.output<TC>,
) => Awaitable<z.input<R>>;

export interface TaskDefinitionInput<
  TC extends ConfigSchema,
  SC extends ConfigSchema,
  AC extends ConfigSchema,
  R extends z.ZodType,
> {
  /** Behaviour parameters, constant for all analyses of a scan. Default: Empty. */
  taskConfig?: TC;
  /** Parameters of `schedule`. Default: Empty, or the template's when `schedule` is a template proxy. */
  scanConfig?: SC;
  /** The input of one analysis. Default: Empty, or the template's when `schedule` is a template proxy. */
  analysisConfig?: AC;
  /** The typed output of one successful analysis. */
  result: R;
  /**
   * A generator (sync or async) or a function returning an iterable of analysis configs; or a template
   * proxy such as `tranco.schedule`, which then runs natively in the runtime. Omitted: template `single`.
   * Must be deterministic for a given scan config and task config.
   */
  schedule?: ScheduleFunction<SC, TC, AC> | TemplateRef<SC, AC>;
  run: RunFunction<AC, TC, R>;
}

/** A validated task definition; the entry's default export. */
export class TaskDefinition<
  TC extends ConfigSchema = ConfigSchema,
  SC extends ConfigSchema = ConfigSchema,
  AC extends ConfigSchema = ConfigSchema,
  R extends z.ZodType = z.ZodType,
> {
  readonly taskConfig: TC;
  readonly scanConfig: SC;
  readonly analysisConfig: AC;
  readonly result: R;
  /** The custom schedule; undefined when `template` is set. */
  readonly schedule: ScheduleFunction<SC, TC, AC> | undefined;
  /** The template proxy the task schedules with unwrapped (`single` when no schedule is defined). */
  readonly template: TemplateSchedule<SC, AC> | undefined;
  readonly run: RunFunction<AC, TC, R>;

  constructor(parts: {
    taskConfig: TC;
    scanConfig: SC;
    analysisConfig: AC;
    result: R;
    schedule: ScheduleFunction<SC, TC, AC> | undefined;
    template: TemplateSchedule<SC, AC> | undefined;
    run: RunFunction<AC, TC, R>;
  }) {
    this.taskConfig = parts.taskConfig;
    this.scanConfig = parts.scanConfig;
    this.analysisConfig = parts.analysisConfig;
    this.result = parts.result;
    this.schedule = parts.schedule;
    this.template = parts.template;
    this.run = parts.run;
    Object.freeze(this);
  }
}

const FOREIGN_ZOD =
  'was not created with the z exported by @scantor/connector; import { z } from "@scantor/connector" instead of "zod"';

function checkConfigSchema(field: string, schema: unknown): ConfigSchema {
  if (!isConnectorSchema(schema)) throw new TaskDefinitionError(`${field} ${FOREIGN_ZOD}`);
  if (!isClosedObject(schema)) {
    throw new TaskDefinitionError(
      `${field} must be created with config() or z.strictObject(): a config root has to reject unknown keys`,
    );
  }
  return schema as unknown as ConfigSchema;
}

function sameSchema(field: "scanConfig" | "analysisConfig", given: unknown, template: TemplateRef): void {
  const expected = field === "scanConfig" ? template.ScanConfig : template.AnalysisConfig;
  if (given === undefined || given === expected) return;
  const name = field === "scanConfig" ? "ScanConfig" : "AnalysisConfig";
  throw new TaskDefinitionError(
    `schedule is the ${template.template} template passed unwrapped, so ${field} must be omitted or ${template.template}.${name}`,
  );
}

/**
 * Defines a task: its config and result schemas and its `schedule` and `run` functions. The entry module
 * exports the returned value as its default export. Throws TaskDefinitionError for an invalid definition.
 */
export function defineTask<
  TC extends ConfigSchema = typeof Empty,
  SC extends ConfigSchema = typeof Empty,
  AC extends ConfigSchema = typeof Empty,
  R extends z.ZodType = z.ZodType,
>(definition: TaskDefinitionInput<TC, SC, AC, R>): TaskDefinition<TC, SC, AC, R> {
  if (typeof definition !== "object" || definition === null) {
    throw new TaskDefinitionError("defineTask expects an object with result and run");
  }
  if (definition.result === undefined) throw new TaskDefinitionError("defineTask: result is required");
  if (!isConnectorSchema(definition.result)) throw new TaskDefinitionError(`result ${FOREIGN_ZOD}`);
  if (typeof definition.run !== "function") throw new TaskDefinitionError("defineTask: run must be a function");

  const taskConfig = definition.taskConfig === undefined ? Empty : checkConfigSchema("taskConfig", definition.taskConfig);
  const template = templateOf(definition.schedule);
  let scanConfig: ConfigSchema;
  let analysisConfig: ConfigSchema;
  if (template !== undefined) {
    sameSchema("scanConfig", definition.scanConfig, template);
    sameSchema("analysisConfig", definition.analysisConfig, template);
    scanConfig = template.ScanConfig;
    analysisConfig = template.AnalysisConfig;
  } else {
    if (definition.schedule !== undefined && typeof definition.schedule !== "function") {
      throw new TaskDefinitionError("defineTask: schedule must be a function or a template proxy such as tranco.schedule");
    }
    scanConfig = definition.scanConfig === undefined ? Empty : checkConfigSchema("scanConfig", definition.scanConfig);
    if (definition.schedule === undefined && Object.keys(scanConfig.shape).length > 0) {
      throw new TaskDefinitionError(
        "scanConfig needs a schedule: without one the task uses the template single, whose scan config is Empty",
      );
    }
    analysisConfig =
      definition.analysisConfig === undefined ? Empty : checkConfigSchema("analysisConfig", definition.analysisConfig);
  }
  const schedule = template === undefined ? definition.schedule : undefined;

  return new TaskDefinition<TC, SC, AC, R>({
    taskConfig: taskConfig as TC,
    scanConfig: scanConfig as SC,
    analysisConfig: analysisConfig as AC,
    result: definition.result,
    schedule: schedule as ScheduleFunction<SC, TC, AC> | undefined,
    // Without a schedule the task uses template single: one analysis whose config is {} plus defaults.
    template: (schedule === undefined ? (template ?? singleSchedule) : undefined) as TemplateSchedule<SC, AC> | undefined,
    run: definition.run,
  });
}
