// @ts-check
// power: computes base^exponent for every base of an integer range.
//
// A custom schedule wraps the range template (the runtime streams its analysis configs into the
// generator) and can skip even bases. Powers are exact: BigInt arithmetic, returned as decimal strings.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, defineTask, Fatal, FileRef, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  taskConfig: config({
    exponent: z.number().int().min(0).max(64).default(2).describe("Exponent applied to every base."),
    report: z.boolean().default(false).describe("Attach a report.txt file to every result."),
  }),
  scanConfig: config({
    start: z.number().int().default(1).describe("First base (inclusive)."),
    end: z.number().int().default(11).describe("Bound (exclusive)."),
    onlyOdd: z.boolean().default(false).describe("Skip even bases."),
  }),
  analysisConfig: config({ base: z.number().int() }),
  result: z.object({ base: z.number().int(), power: z.string(), report: FileRef.nullable() }),
  async *schedule(ctx, scanConfig) {
    for await (const item of range.schedule(ctx, { start: scanConfig.start, end: scanConfig.end, step: 1 })) {
      if (!scanConfig.onlyOdd || item.value % 2 !== 0) yield { base: item.value };
    }
  },
  async run(ctx, analysisConfig, taskConfig) {
    const { base } = analysisConfig;
    if (base < 0) throw new Fatal("negative bases are not supported"); // retrying cannot help
    const power = (BigInt(base) ** BigInt(taskConfig.exponent)).toString();
    let report = null;
    if (taskConfig.report) {
      const path = join(ctx.tmpDir, "report.txt");
      await writeFile(path, `${base}^${taskConfig.exponent} = ${power}\n`);
      report = await ctx.files.put("report.txt", { path }, "text/plain");
    }
    return { base, power, report };
  },
});
