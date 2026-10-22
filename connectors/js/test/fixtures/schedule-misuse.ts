// Schedules that break the rules, selected by scan config `mode`.
import { config, defineTask, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: config({ mode: z.string().default("array") }),
  analysisConfig: config({ n: z.number().int(), extra: z.unknown().optional() }),
  result: z.object({ n: z.number().int() }),
  schedule: (ctx, scanConfig) => {
    switch (scanConfig.mode) {
      case "array":
        return [{ n: 1 }, { n: 2 }];
      case "promisedArray":
        return Promise.resolve([{ n: 1 }]) as unknown as Iterable<{ n: number }>;
      case "notIterable":
        return 42 as unknown as Iterable<{ n: number }>;
      case "invalidItem":
        return [{ n: 1 }, { n: "two" as unknown as number }];
      case "nonJson":
        return [{ n: 1, extra: Number.POSITIVE_INFINITY }];
      case "files":
        return (async function* () {
          await ctx.files.put("a.txt", "x");
          yield { n: 1 };
        })();
      default:
        throw new Error(`unknown mode ${scanConfig.mode}`);
    }
  },
  async run(ctx, analysisConfig) {
    if (analysisConfig.n === 99) {
      for await (const item of range.schedule(ctx, {})) return { n: item.value };
    }
    return { n: analysisConfig.n };
  },
});
