import { defineTask, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: range.ScanConfig,
  analysisConfig: range.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: range.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
