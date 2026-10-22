// @ts-check
import { defineTask, z } from "@scantor/connector";

export default defineTask({
  result: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});
