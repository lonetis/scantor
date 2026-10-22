// The conformance `template-crux` fixture: the crux proxy passed unwrapped with its types.
import { defineTask, z } from "@scantor/connector";
import { crux } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: crux.ScanConfig,
  analysisConfig: crux.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: crux.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
