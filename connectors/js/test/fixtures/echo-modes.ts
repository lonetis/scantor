// The conformance `echo` fixture (docs/protocol.md §12.2), shared by echo.ts (sync run) and echo-async.ts.
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, Fatal, FileRef, Retry, secret, z, type Context } from "@scantor/connector";

export const TaskConfig = config({ greeting: z.string().default("Hello"), apiToken: secret().optional() });
export const AnalysisConfig = config({
  name: z.string().default("world"),
  mode: z.string().default("ok"),
  sleepMs: z.number().int().default(0),
  bytes: z.number().int().default(0),
});
export const Result = z.object({
  text: z.string(),
  ctx: z.object({
    scanId: z.string(),
    analysisId: z.string().nullable(),
    seq: z.number().int().nullable(),
    attempt: z.number().int(),
    hasDeadline: z.boolean(),
    tmpDirWritable: z.boolean(),
  }),
  secretLength: z.number().int(),
  files: z.array(FileRef),
});

type Ac = z.output<typeof AnalysisConfig>;
type Tc = z.output<typeof TaskConfig>;
type R = z.input<typeof Result>;

function tmpDirWritable(ctx: Context): boolean {
  try {
    writeFileSync(join(ctx.tmpDir, "probe"), "x");
    return true;
  } catch {
    return false;
  }
}

export function ok(ctx: Context, ac: Ac, tc: Tc, files: FileRef[] = [], text = `${tc.greeting}, ${ac.name}!`): R {
  return {
    text,
    ctx: {
      scanId: ctx.scanId,
      analysisId: ctx.analysisId,
      seq: ctx.seq,
      attempt: ctx.attempt,
      hasDeadline: ctx.deadline !== null,
      tmpDirWritable: tmpDirWritable(ctx),
    },
    secretLength: (tc.apiToken ?? "").length,
    files,
  };
}

/** Sleeps in 10 ms steps and stops early once the call is cancelled. */
export async function cooperativeSleep(ctx: Context, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function putFiles(ctx: Context): Promise<FileRef[]> {
  const a = await ctx.files.put("a.bin", new Uint8Array([97, 98, 99]), "application/octet-stream");
  const b = await ctx.files.put("b.txt", "hello");
  const path = join(ctx.tmpDir, "c.json");
  await writeFile(path, JSON.stringify({ c: true }));
  const c = await ctx.files.put("c.json", { path });
  await writeFile(path, "changed after put");
  return [a, b, c];
}

/** Modes that behave the same in the sync and the async variant; undefined for the others. */
export function common(ctx: Context, ac: Ac, tc: Tc): R | undefined {
  switch (ac.mode) {
    case "ok":
      return ok(ctx, ac, tc);
    case "fatal":
      throw new Fatal("fatal requested");
    case "retry":
      throw new Retry("retry requested");
    case "retryAfter":
      throw new Retry("retry requested", 1500);
    case "throw":
      throw new Error("boom");
    case "invalidResult":
      return { ...ok(ctx, ac, tc), text: 42 as unknown as string };
    case "sleepUncooperative":
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ac.sleepMs);
      return ok(ctx, ac, tc);
    case "exit":
      return process.exit(3);
    case "oversized":
      return ok(ctx, ac, tc, [], "x".repeat(ac.bytes));
    case "stdout":
      process.stdout.write('{"type":"result","id":"r0","result":{}}\n');
      process.stderr.write("noise\n");
      return ok(ctx, ac, tc);
    case "log":
      ctx.log("info", "hello", { n: 1 });
      return ok(ctx, ac, tc);
    case "progress":
      ctx.progress(0.5, "half");
      return ok(ctx, ac, tc);
    default:
      return undefined;
  }
}
