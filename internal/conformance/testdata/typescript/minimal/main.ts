// The conformance `minimal` fixture: only a result type and run.
import { defineTask, z } from "@scantor/connector";

export default defineTask({
  result: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});
