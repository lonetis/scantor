// The conformance `import-error` fixture: fails at import time.
import { defineTask, z } from "@scantor/connector";

throw new Error("boom at import");

export default defineTask({ result: z.object({}), run: () => ({}) });
