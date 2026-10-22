// @ts-check
// Definitions that must type-check from plain JavaScript, mirroring docs/tasks.md §5.8.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, defineTask, FileRef, Fatal, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export const minimal = defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  run: (ctx, analysisConfig, taskConfig) => ({ text: `${taskConfig.greeting}, world!` }),
});

export const full = defineTask({
  taskConfig: config({ exponent: z.number().int().min(0).max(64).default(2) }),
  scanConfig: config({ start: z.number().int().default(1), end: z.number().int().default(11), onlyOdd: z.boolean().default(false) }),
  analysisConfig: config({ base: z.number().int() }),
  result: z.object({ power: z.string(), report: FileRef }),
  async *schedule(ctx, scanConfig) {
    for await (const item of range.schedule(ctx, { start: scanConfig.start, end: scanConfig.end, step: 1 })) {
      if (!scanConfig.onlyOdd || item.value % 2 !== 0) yield { base: item.value };
    }
  },
  async run(ctx, analysisConfig, taskConfig) {
    if (analysisConfig.base < 0) throw new Fatal("negative bases are not supported");
    const power = (BigInt(analysisConfig.base) ** BigInt(taskConfig.exponent)).toString();
    const path = join(ctx.tmpDir, "report.txt");
    await writeFile(path, `${analysisConfig.base}^${taskConfig.exponent} = ${power}\n`);
    return { power, report: await ctx.files.put("report.txt", { path }) };
  },
});

export const unwrapped = defineTask({
  result: z.object({ value: z.number() }),
  schedule: range.schedule,
  run: (ctx, analysisConfig) => ({ value: analysisConfig.value }),
});
