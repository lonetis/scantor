import { defineTask } from "@scantor/connector";
import { AnalysisConfig, common, cooperativeSleep, ok, putFiles, Result, TaskConfig } from "./echo-modes.ts";

console.log("importing echo");
console.error("importing echo");

export default defineTask({
  taskConfig: TaskConfig,
  analysisConfig: AnalysisConfig,
  result: Result,
  run: (ctx, analysisConfig, taskConfig) => {
    const result = common(ctx, analysisConfig, taskConfig);
    if (result !== undefined) return result;
    switch (analysisConfig.mode) {
      case "sleep":
        return cooperativeSleep(ctx, analysisConfig.sleepMs).then(() => ok(ctx, analysisConfig, taskConfig));
      case "file":
        return putFiles(ctx).then((files) => ok(ctx, analysisConfig, taskConfig, files));
      case "fileError":
        return ctx.files.put("bad/name", "x").then(() => ok(ctx, analysisConfig, taskConfig));
      case "fileRuntimeError":
        return ctx.files.put("big.bin", "x").then(() => ok(ctx, analysisConfig, taskConfig));
      default:
        throw new Error(`unknown mode ${analysisConfig.mode}`);
    }
  },
});
