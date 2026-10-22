// No schedule (template single) with an analysis config that rejects {}: describe warns.
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  analysisConfig: config({ url: z.string() }),
  result: z.object({ url: z.string() }),
  run: (ctx, analysisConfig) => ({ url: analysisConfig.url }),
});
