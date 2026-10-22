// Definitions that must type-check, mirroring docs/tasks.md §5.7.
import { config, defineTask, Empty, FileRef, Fatal, Retry, ScantorError, secret, z, type Context } from "@scantor/connector";
import { crux, range, tranco } from "@scantor/connector/templates";

export const minimal = defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  run: (ctx, analysisConfig, taskConfig) => ({ text: `${taskConfig.greeting}, world!` }),
});

export const full = defineTask({
  taskConfig: config({
    userAgent: z.string().default("scantor-example/1.0"),
    proxyToken: secret().default(""),
    maxBodyBytes: z.number().int().min(0).max(10_000_000).default(1_000_000),
  }),
  scanConfig: crux.ScanConfig,
  analysisConfig: crux.AnalysisConfig,
  result: z.object({
    status: z.number().int(),
    finalUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    body: FileRef.nullable(),
  }),
  schedule: crux.schedule,
  async run(ctx, analysisConfig, taskConfig) {
    const headers: Record<string, string> = { "user-agent": taskConfig.userAgent };
    if (taskConfig.proxyToken) headers["proxy-authorization"] = `Bearer ${taskConfig.proxyToken}`;
    let response: Response;
    try {
      response = await fetch(analysisConfig.origin, { headers, redirect: "follow", signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw new Fatal(`fetch failed: ${(error as Error).message}`);
    }
    if (response.status === 429) throw new Retry("rate limited", 60_000);
    const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, taskConfig.maxBodyBytes);
    ctx.log("info", "fetched", { status: response.status, bytes: bytes.length });
    ctx.progress(1);
    return {
      status: response.status,
      finalUrl: response.url,
      headers: Object.fromEntries(response.headers),
      body: bytes.length > 0 ? await ctx.files.put("body.html", bytes, "text/html") : null,
    };
  },
});

// The template's types are inferred from an unwrapped proxy when the configs are omitted.
export const inferred = defineTask({
  result: z.object({ domain: z.string(), rank: z.number() }),
  schedule: tranco.schedule,
  run: (ctx, analysisConfig) => ({ domain: analysisConfig.domain, rank: analysisConfig.rank }),
});

const ScanConfig = config({ ...tranco.ScanConfig.shape, skipTlds: z.array(z.string()).default(["cn"]) });

export const wrapped = defineTask({
  scanConfig: ScanConfig,
  analysisConfig: config({ url: z.string(), rank: z.number().int() }),
  result: z.object({ url: z.string() }),
  async *schedule(ctx, scanConfig) {
    for await (const item of tranco.schedule(ctx, scanConfig)) {
      if (!scanConfig.skipTlds.includes(item.domain.split(".").at(-1) ?? "")) yield { url: `https://${item.domain}/`, rank: item.rank };
    }
  },
  run: (ctx, analysisConfig) => ({ url: analysisConfig.url }),
});

export const syncGenerator = defineTask({
  scanConfig: config({ count: z.number().int().default(3) }),
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  *schedule(ctx, scanConfig) {
    for (let n = 0; n < scanConfig.count; n++) yield { n };
  },
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});

export const arraySchedule = defineTask({
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ n: z.number() }),
  schedule: () => [{ n: 1 }, { n: 2 }],
  run: (ctx, analysisConfig) => ({ n: analysisConfig.n }),
});

export const explicitEmpty = defineTask({
  taskConfig: Empty,
  result: z.object({ ok: z.boolean() }),
  run: async () => ({ ok: true }),
});

export async function helper(ctx: Context): Promise<FileRef> {
  try {
    return await ctx.files.put("a.txt", "hello");
  } catch (error) {
    if (error instanceof ScantorError && error.type === "validation") throw new Fatal(error.message);
    throw error;
  }
}

export function rangeValues(ctx: Context): AsyncIterable<range.AnalysisConfig> {
  return range.schedule(ctx, { start: 1, end: 11 });
}
