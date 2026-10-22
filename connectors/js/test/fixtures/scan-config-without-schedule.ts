// A scan config without a schedule is an invalid definition: template single has no scan config.
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  scanConfig: config({ count: z.number().int().default(3) }),
  result: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});
