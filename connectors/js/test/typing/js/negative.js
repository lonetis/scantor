// @ts-check
import { config, defineTask, z } from "@scantor/connector";

export const wrongField = defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  // @ts-expect-error the task config has no field greting
  run: (ctx, analysisConfig, taskConfig) => ({ text: taskConfig.greting }),
});

export const wrongYield = defineTask({
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  // @ts-expect-error yields a string where n is a number
  *schedule() {
    yield { n: "x" };
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});
