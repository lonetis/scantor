// The conformance `echo-async` fixture: echo with an asynchronous run (docs/protocol.md §12.2).
import { defineTask } from "@scantor/connector";
import { AnalysisConfig, common, cooperativeSleep, ok, putFiles, Result, TaskConfig } from "./echo-modes.js";

console.log("importing echo");
console.error("importing echo");

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
      case "file":
        return ok(ctx, analysisConfig, taskConfig, await putFiles(ctx));
      case "fileError":
        await ctx.files.put("bad.bin", "x");
        return ok(ctx, analysisConfig, taskConfig);
      default:
        throw new Error(`unknown mode ${analysisConfig.mode}`);
    }
  },
});
