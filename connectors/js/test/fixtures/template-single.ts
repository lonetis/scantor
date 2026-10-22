import { defineTask, z } from "@scantor/connector";
import { single } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: single.ScanConfig,
  analysisConfig: single.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: single.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
