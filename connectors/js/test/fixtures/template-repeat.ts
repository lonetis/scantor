import { defineTask, z } from "@scantor/connector";
import { repeat } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: repeat.ScanConfig,
  analysisConfig: repeat.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: repeat.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
