// http-status: fetches every origin of a CrUX top list and checks its HTTP status code.
//
// The crux template is passed unwrapped, so the scheduler resolves the list and creates the analyses
// natively. An unreachable or silent origin is a result (status null), not a failure; a rate limit is
// retried.
import { config, defineTask, Retry, z } from "@scantor/connector";
import { crux } from "@scantor/connector/templates";

const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** The delay a 429 response asks for (Retry-After in seconds), or undefined for the scan's backoff. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/** fetch rejects with "fetch failed"; the cause names the network problem (DNS, TLS, refused). */
function networkError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${cause.message}` : cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default defineTask({
  taskConfig: config({
    expectedStatus: z.number().int().min(100).max(599).default(200).describe("Status code every origin should answer with."),
    followRedirects: z.boolean().default(true).describe("Follow redirects and check the status of the final response."),
    timeoutMs: z.number().int().min(1000).max(50_000).default(15_000).describe("Time limit of one request."),
    userAgent: z.string().default("scantor-http-status/1.0 (+https://github.com/lonetis/scantor)"),
  }),
  scanConfig: crux.ScanConfig,
  analysisConfig: crux.AnalysisConfig,
  result: z.object({
    origin: z.string(),
    rank: z.number().int(),
    status: z.number().int().nullable(),
    matches: z.boolean(),
    finalUrl: z.string().nullable(),
    durationMs: z.number().int(),
    error: z.string().nullable(),
  }),
  schedule: crux.schedule,
  async run(ctx, analysisConfig, taskConfig) {
    const { origin, rank } = analysisConfig;
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    let response: Response;
    try {
      response = await fetch(origin, {
        redirect: taskConfig.followRedirects ? "follow" : "manual",
        headers: { "user-agent": taskConfig.userAgent },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(taskConfig.timeoutMs)]),
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error; // cancelled or out of time: the runtime classifies it
      const message = error instanceof DOMException && error.name === "TimeoutError"
        ? `no response within ${taskConfig.timeoutMs} ms`
        : networkError(error);
      ctx.log("info", "unreachable", { origin, error: message });
      return { origin, rank, status: null, matches: false, finalUrl: null, durationMs: elapsed(), error: message };
    }
    await response.body?.cancel(); // the status is all this task needs
    if (response.status === 429) throw new Retry(`${origin} is rate limiting`, retryAfterMs(response));

    ctx.log("info", "fetched", { origin, status: response.status });
    return {
      origin,
      rank,
      status: response.status,
      matches: response.status === taskConfig.expectedStatus,
      finalUrl: response.url,
      durationMs: elapsed(),
      error: null,
    };
  },
});
