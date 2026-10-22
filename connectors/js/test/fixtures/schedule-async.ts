import { config, defineTask, Fatal, z } from "@scantor/connector";
import { ScanConfig } from "./schedule.ts";

export default defineTask({
  scanConfig: ScanConfig,
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number().int() }),
  async *schedule(ctx, scanConfig) {
    for (let n = 0; n < scanConfig.count; n++) {
      await Promise.resolve();
      if (ctx.signal.aborted) return;
      if (n === scanConfig.failAt) throw new Error(`failed at ${n}`);
      if (n === scanConfig.fatalAt) throw new Fatal(`fatal at ${n}`);
      yield { n };
    }
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});
