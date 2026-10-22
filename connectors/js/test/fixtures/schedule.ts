import { config, defineTask, Fatal, z } from "@scantor/connector";

export const ScanConfig = config({
  count: z.number().int().default(3),
  failAt: z.number().int().nullable().default(null),
  fatalAt: z.number().int().nullable().default(null),
});

export default defineTask({
  scanConfig: ScanConfig,
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number().int() }),
  *schedule(ctx, scanConfig) {
    for (let n = 0; n < scanConfig.count; n++) {
      if (n === scanConfig.failAt) throw new Error(`failed at ${n}`);
      if (n === scanConfig.fatalAt) throw new Fatal(`fatal at ${n}`);
      yield { n };
    }
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});
