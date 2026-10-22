// The conformance `template-tranco` fixture: the tranco proxy passed unwrapped with its types.
import { defineTask, z } from "@scantor/connector";
import { tranco } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: tranco.ScanConfig,
  analysisConfig: tranco.AnalysisConfig,
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  schedule: tranco.schedule,
  run: (ctx, analysisConfig) => ({ config: analysisConfig }),
});
