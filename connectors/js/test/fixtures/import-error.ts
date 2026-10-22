import { defineTask, z } from "@scantor/connector";

throw new Error("boom at import");

export default defineTask({ result: z.object({}), run: () => ({}) });
