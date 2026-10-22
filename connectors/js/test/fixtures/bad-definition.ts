import { z } from "@scantor/connector";

export default { result: z.object({ ok: z.boolean() }), run: () => ({ ok: true }) };
