import { defineTask, z } from "@scantor/connector";
import { list } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: list.ScanConfig,
  analysisConfig: list.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: list.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
