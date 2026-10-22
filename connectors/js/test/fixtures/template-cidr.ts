import { defineTask, z } from "@scantor/connector";
import { cidr } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: cidr.ScanConfig,
  analysisConfig: cidr.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: cidr.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
