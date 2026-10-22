import { defineTask } from "@scantor/connector";
import { AnalysisConfig, common, cooperativeSleep, ok, putFiles, Result, TaskConfig } from "./echo-modes.ts";

export default defineTask({
  taskConfig: TaskConfig,
  analysisConfig: AnalysisConfig,
  result: Result,
  async run(ctx, analysisConfig, taskConfig) {
    await Promise.resolve();
    const result = common(ctx, analysisConfig, taskConfig);
    if (result !== undefined) return result;
    switch (analysisConfig.mode) {
      case "sleep":
        await cooperativeSleep(ctx, analysisConfig.sleepMs);
        return ok(ctx, analysisConfig, taskConfig);
      case "sleepIgnoringSignal":
        await new Promise((resolve) => setTimeout(resolve, analysisConfig.sleepMs));
        return ok(ctx, analysisConfig, taskConfig);
      case "file":
        return ok(ctx, analysisConfig, taskConfig, await putFiles(ctx));
      case "fileError":
        await ctx.files.put("bad/name", "x");
        return ok(ctx, analysisConfig, taskConfig);
      default:
        throw new Error(`unknown mode ${analysisConfig.mode}`);
    }
  },
});
