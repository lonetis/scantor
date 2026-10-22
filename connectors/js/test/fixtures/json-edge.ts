// Results that pass their schema but are not plain JSON.
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  analysisConfig: config({ mode: z.string().default("date") }),
  result: z.object({ value: z.unknown() }),
  run: (ctx, analysisConfig) => {
    switch (analysisConfig.mode) {
      case "date":
        return { value: new Date(Date.UTC(2026, 9, 21)) };
      case "infinity":
        return { value: { nested: [1, Number.POSITIVE_INFINITY] } };
      case "bigint":
        return { value: 10n };
      case "map":
        return { value: new Map([["a", 1]]) };
      case "undefinedInArray":
        return { value: [1, undefined] };
      case "undefinedProperty":
        return { value: { kept: 1, dropped: undefined } };
      default:
        throw new Error(`unknown mode ${analysisConfig.mode}`);
    }
  },
});
