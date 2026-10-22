import { defineTask, z } from "@scantor/connector";

export default defineTask({
  taskConfig: z.object({ greeting: z.string().default("Hello") }) as never,
  result: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});
