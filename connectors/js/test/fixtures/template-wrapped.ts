import { config, defineTask, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: config({
    start: z.number().int().default(0),
    end: z.number().int().default(10),
    stopAfter: z.number().int().nullable().default(null),
  }),
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number().int() }),
  async *schedule(ctx, scanConfig) {
    let yielded = 0;
    for await (const item of range.schedule(ctx, { start: scanConfig.start, end: scanConfig.end, step: 1 })) {
      if (scanConfig.stopAfter !== null && yielded >= scanConfig.stopAfter) break;
      yield { n: item.value * 2 };
      yielded += 1;
    }
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});
