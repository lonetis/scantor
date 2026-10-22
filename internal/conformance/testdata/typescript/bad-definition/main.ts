// The conformance `bad-definition` fixture: the default export is a plain object.
import { z } from "@scantor/connector";

export default { result: z.object({ ok: z.boolean() }), run: () => ({ ok: true }) };
