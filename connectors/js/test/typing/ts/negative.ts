// Each @ts-expect-error marks a definition tsc must reject (docs/tasks.md §5.7 "tsc 6.0 checks").
import { config, defineTask, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export const wrongField = defineTask({
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  // @ts-expect-error the analysis config has no field m
  run: (ctx, analysisConfig) => ({ n: analysisConfig.m }),
});

export const wrongYield = defineTask({
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  // @ts-expect-error yields a string where n is a number
  *schedule() {
    yield { n: "x" };
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});

export const wrongReturn = defineTask({
  result: z.object({ text: z.string() }),
  // @ts-expect-error returns a number for text
  run: () => ({ text: 42 }),
});

export const swapped = defineTask({
  taskConfig: config({ greeting: z.string().default("x") }),
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  // @ts-expect-error the second parameter is the analysis config, the third the task config
  run: (ctx, taskConfig: { greeting: string }, analysisConfig: { n: number }) => ({ n: analysisConfig.n + taskConfig.greeting.length }),
});

export const foreignTemplateTypes = defineTask({
  analysisConfig: config({ other: z.string() }),
  result: z.object({ value: z.number() }),
  // @ts-expect-error an unwrapped template requires its own analysis config
  schedule: range.schedule,
  run: () => ({ value: 1 }),
});

// @ts-expect-error result is required
export const missingResult = defineTask({ run: () => ({}) });

export const missingRun = defineTask(
  // @ts-expect-error run is required
  { result: z.object({}) },
);
