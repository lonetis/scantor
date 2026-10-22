import { defineTask, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  result: z.object({ value: z.number().int() }),
  schedule: range.schedule,
  run: (ctx, analysisConfig) => ({ value: analysisConfig.value }),
});
