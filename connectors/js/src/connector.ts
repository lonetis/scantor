import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LineReader, LineWriter } from "./channel.ts";
import { Call, createContext, type Link, type TemplateSink } from "./context.ts";
import { TaskDefinition } from "./define.ts";
import { ScantorError, TaskDefinitionError, toIssues, toWireError, validationError } from "./errors.ts";
import { JsonConversionError, toJsonObject, truncate } from "./json.ts";
import {
  DEFAULT_MAX_LINE_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_ERROR_STACK_CHARS,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  isValidId,
  type DescribedSchemas,
  type FileMessage,
  type JsonObject,
  type Limits,
  type OutgoingMessage,
  type RunMessage,
  type ScheduleKind,
  type ScheduleMessage,
  type TemplateMessage,
  type WireContext,
  type WireError,
  type WireFileRef,
} from "./protocol.ts";
import { exportJsonSchema, type ConfigSchema, type SchemaMode, type z } from "./schema.ts";

export type Language = "typescript" | "javascript";

export interface ConnectorOptions {
  /** The manifest entry, relative to the working directory (/task) or absolute. */
  entry: string;
  language: Language;
  version: string;
  inFd: number;
  outFd: number;
}

/** How long user code may take to settle after its signal aborted before the request is ended anyway. */
const ABORT_SETTLE_MS = 1000;

const DEFAULT_LIMITS: Limits = {
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  maxResultBytes: 1024 * 1024,
  maxAnalysisConfigBytes: 64 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  maxFilesPerAnalysis: 100,
};

type Phase = "hello" | "loading" | "ready" | "exiting";

interface PendingFile {
  call: Call;
  resolve(ref: WireFileRef): void;
  reject(error: Error): void;
}

interface OpenStream {
  call: Call;
  sink: TemplateSink;
}

type Outcome<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "abandoned" };

class AbortReason extends DOMException {
  readonly reply: string;

  constructor(reply: string, name: "AbortError" | "TimeoutError") {
    super(reply, name);
    this.reply = reply;
  }
}

/**
 * The connector side of the protocol for one process: handshake, then one runtime request at a time,
 * with `file` and `template` callbacks and `cancel`/`shutdown` control (docs/protocol.md).
 */
export class Connector implements Link {
  readonly #options: ConnectorOptions;
  readonly #writer: LineWriter;
  readonly #reader: LineReader;
  #phase: Phase = "hello";
  #limits: Limits = DEFAULT_LIMITS;
  #definition: TaskDefinition | undefined;
  #call: Call | undefined;
  readonly #files = new Map<string, PendingFile>();
  readonly #streams = new Map<string, OpenStream>();
  #idCounter = 0;

  constructor(options: ConnectorOptions) {
    this.#options = options;
    this.#writer = new LineWriter(options.outFd, (error) => this.#channelLost(error));
    this.#reader = new LineReader(options.inFd, {
      line: (line) => this.#receive(line),
      end: () => void this.#exit(0),
      error: (error) => this.#channelLost(error),
    });
  }

  get limits(): Limits {
    return this.#limits;
  }

  /** Writes `hello` before the entry is imported, so version problems surface even for broken entries. */
  start(): void {
    this.send({
      type: "hello",
      id: "hello",
      protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
      connector: { language: this.#options.language, version: this.#options.version, runtime: `node ${process.versions.node}` },
      pid: process.pid,
    });
  }

  // Link

  nextId(): string {
    this.#idCounter += 1;
    return `c${this.#idCounter}`;
  }

  send(message: OutgoingMessage): void {
    if (this.#phase === "exiting") return;
    if ((message.type === "templateCredit" || message.type === "templateCancel") && !this.#streams.has(message.id)) return;
    this.#writer.write(`${JSON.stringify(message)}\n`).catch(() => {
      // The writer reports the broken channel through #channelLost.
    });
  }

  requestFile(call: Call, message: FileMessage): Promise<WireFileRef> {
    if (!call.active || this.#call !== call) {
      return Promise.reject(new ScantorError("cancelled", "the call ended before the file was registered"));
    }
    return new Promise((resolve, reject) => {
      this.#files.set(message.id, { call, resolve, reject });
      this.send(message);
    });
  }

  openTemplate(call: Call, message: TemplateMessage, sink: TemplateSink): void {
    this.#streams.set(message.id, { call, sink });
    this.send(message);
  }

  closeTemplate(id: string): void {
    this.#streams.delete(id);
  }

  // Incoming messages

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`scantor connector: ignoring a line on fd ${this.#options.inFd} that is not JSON\n`);
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    this.#dispatch(message as Record<string, unknown>);
  }

  #dispatch(message: Record<string, unknown>): void {
    const { type, id } = message;
    if (this.#phase === "hello") {
      if (type === "welcome") this.#welcome(message);
      else if (type === "error" && id === "hello") void this.#exit(1);
      else if ((type === "describe" || type === "schedule" || type === "run") && isValidId(id)) {
        this.send({ type: "error", id, error: validationError("the connector is not ready") });
      }
      return;
    }
    switch (type) {
      case "describe":
      case "schedule":
      case "run":
        this.#request(type, message);
        return;
      case "cancel":
        this.#cancel(id, message.reason);
        return;
      case "shutdown":
        void this.#exit(0);
        return;
      case "fileRef":
        this.#fileReply(id, message.fileRef as WireFileRef, undefined);
        return;
      case "templateItem":
        if (typeof id === "string") this.#streams.get(id)?.sink.item(message.config as JsonObject);
        return;
      case "templateDone":
        if (typeof id === "string") this.#endStream(id, undefined);
        return;
      case "error":
        if (typeof id === "string") this.#errorReply(id, message.error as WireError);
        return;
      case "welcome":
        return;
      default:
        if (isValidId(id)) {
          this.send({ type: "error", id, error: validationError(`unsupported request ${String(type)}`) });
        }
    }
  }

  #welcome(message: Record<string, unknown>): void {
    const version = message.protocolVersion;
    if (typeof version !== "number" || version < PROTOCOL_MIN || version > PROTOCOL_MAX) {
      this.#failHandshake(validationError(`the runtime chose protocol ${String(version)}; this connector speaks ${PROTOCOL_MIN}..${PROTOCOL_MAX}`));
      return;
    }
    if (typeof message.limits === "object" && message.limits !== null) {
      this.#limits = { ...DEFAULT_LIMITS, ...(message.limits as Partial<Limits>) };
    }
    this.#phase = "loading";
    void this.#load();
  }

  async #load(): Promise<void> {
    let definition: TaskDefinition;
    try {
      definition = await loadDefinition(this.#options.entry);
    } catch (error) {
      this.#failHandshake(handshakeError(error));
      return;
    }
    if (this.#phase !== "loading") return;
    this.#definition = definition;
    this.#phase = "ready";
    this.send({ type: "ready", id: "hello" });
  }

  #failHandshake(error: WireError): void {
    this.send({ type: "error", id: "hello", error });
    void this.#exit(1);
  }

  #request(type: "describe" | "schedule" | "run", message: Record<string, unknown>): void {
    const id = message.id;
    if (!isValidId(id)) return;
    const definition = this.#definition;
    if (this.#phase !== "ready" || definition === undefined) {
      this.send({ type: "error", id, error: validationError("the connector is not ready") });
      return;
    }
    if (this.#call !== undefined) {
      this.send({ type: "error", id, error: validationError(`request ${this.#call.id} is still in flight`) });
      return;
    }
    if (type === "describe") {
      this.#describe(id, definition);
      return;
    }
    const call = new Call(id, type, message.ctx as WireContext, this);
    this.#call = call;
    // User code awaiting a template stream must not wait for items the runtime will never send.
    call.controller.signal.addEventListener("abort", () => this.#closeStreams(call), { once: true });
    const handler = type === "run" ? this.#run(call, message as unknown as RunMessage, definition) : this.#schedule(call, message as unknown as ScheduleMessage, definition);
    handler
      .catch((error: unknown) => this.#finish(call, { type: "error", id, error: toWireError(error) }))
      .catch((error: unknown) => process.stderr.write(`scantor connector: ${String(error)}\n`));
  }

  #describe(id: string, definition: TaskDefinition): void {
    let schemas: DescribedSchemas;
    try {
      schemas = {
        taskConfig: exportSchema("taskConfig", definition.taskConfig, "input"),
        scanConfig: exportSchema("scanConfig", definition.scanConfig, "input"),
        analysisConfig: exportSchema("analysisConfig", definition.analysisConfig, "input"),
        result: exportSchema("result", definition.result, "output"),
      };
    } catch (error) {
      this.send({ type: "error", id, error: validationError((error as Error).message) });
      return;
    }
    const schedule: ScheduleKind =
      definition.template === undefined ? { kind: "custom" } : { kind: "template", template: definition.template.template };
    this.send({ type: "description", id, schemas, schedule, warnings: describeWarnings(definition) });
  }

  async #run(call: Call, message: RunMessage, definition: TaskDefinition): Promise<void> {
    const disarm = this.#armDeadline(call);
    try {
      const taskConfig = parseConfig("task config", definition.taskConfig, message.taskConfig);
      const analysisConfig = parseConfig("analysis config", definition.analysisConfig, message.analysisConfig);
      if ("error" in taskConfig) return this.#finish(call, { type: "error", id: call.id, error: taskConfig.error });
      if ("error" in analysisConfig) return this.#finish(call, { type: "error", id: call.id, error: analysisConfig.error });

      const ctx = createContext(call);
      const outcome = await settleOrAbort(
        (async () => definition.run(ctx, analysisConfig.value, taskConfig.value))(),
        call.controller.signal,
      );
      if (outcome.kind !== "value") {
        const error = call.controller.signal.aborted ? cancelledError(call) : toWireError(outcome.kind === "error" ? outcome.error : undefined);
        return this.#finish(call, { type: "error", id: call.id, error });
      }

      const parsed = definition.result.safeParse(outcome.value);
      if (!parsed.success) {
        return this.#finish(call, { type: "error", id: call.id, error: validationError("result is invalid", toIssues(parsed.error)) });
      }
      let result: JsonObject;
      try {
        result = toJsonObject(parsed.data);
      } catch (error) {
        return this.#finish(call, { type: "error", id: call.id, error: jsonError("result", error) });
      }
      const line = `${JSON.stringify({ type: "result", id: call.id, result })}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > this.#limits.maxLineBytes) {
        const error = validationError(`result is ${bytes} bytes, above the ${this.#limits.maxLineBytes}-byte message limit; store large data with ctx.files`);
        return this.#finish(call, { type: "error", id: call.id, error });
      }
      this.#finishWithLine(call, line);
    } finally {
      disarm();
    }
  }

  async #schedule(call: Call, message: ScheduleMessage, definition: TaskDefinition): Promise<void> {
    const taskConfig = parseConfig("task config", definition.taskConfig, message.taskConfig);
    const scanConfig = parseConfig("scan config", definition.scanConfig, message.scanConfig);
    if ("error" in taskConfig) return this.#finish(call, { type: "error", id: call.id, error: taskConfig.error });
    if ("error" in scanConfig) return this.#finish(call, { type: "error", id: call.id, error: scanConfig.error });

    const ctx = createContext(call);
    const signal = call.controller.signal;
    // Unwrapped templates run natively in the runtime; asked anyway, the proxy streams them through it.
    const source =
      definition.schedule !== undefined
        ? definition.schedule(ctx, scanConfig.value, taskConfig.value)
        : definition.template?.(ctx, scanConfig.value);

    let iterator: Iterator<unknown> | AsyncIterator<unknown>;
    try {
      iterator = await iteratorOf(source);
    } catch (error) {
      return this.#finish(call, { type: "error", id: call.id, error: toWireError(error) });
    }

    let count = 0;
    for (;;) {
      const outcome = await settleOrAbort(Promise.resolve().then(() => iterator.next()), signal);
      if (signal.aborted) {
        this.#finish(call, { type: "error", id: call.id, error: cancelledError(call) });
        closeQuietly(iterator);
        return;
      }
      if (outcome.kind !== "value") {
        this.#finish(call, { type: "error", id: call.id, error: toWireError(outcome.kind === "error" ? outcome.error : undefined) });
        closeQuietly(iterator);
        return;
      }
      if (outcome.value.done === true) break;

      const parsed = definition.analysisConfig.safeParse(outcome.value.value);
      let error: WireError | undefined;
      let line = "";
      if (!parsed.success) {
        error = validationError(`analysis config #${count} is invalid`, toIssues(parsed.error));
      } else {
        try {
          line = `${JSON.stringify({ type: "analysis", id: call.id, config: toJsonObject(parsed.data) })}\n`;
          const bytes = Buffer.byteLength(line);
          if (bytes > this.#limits.maxLineBytes) {
            error = validationError(`analysis config #${count} is ${bytes} bytes, above the ${this.#limits.maxLineBytes}-byte message limit`);
          }
        } catch (conversion) {
          error = jsonError(`analysis config #${count}`, conversion);
        }
      }
      if (error !== undefined) {
        this.#finish(call, { type: "error", id: call.id, error });
        closeQuietly(iterator);
        return;
      }
      // Awaiting the write applies pipe backpressure to the generator (protocol §6.1).
      await this.#writer.write(line);
      count += 1;
    }
    this.#finish(call, { type: "done", id: call.id, count });
  }

  #armDeadline(call: Call): () => void {
    const deadline = call.wire.deadlineMs;
    if (deadline === null || deadline === undefined) return () => {};
    const timer = setTimeout(
      () => call.controller.abort(new AbortReason("deadline exceeded", "TimeoutError")),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }

  #cancel(id: unknown, reason: unknown): void {
    const call = this.#call;
    if (call === undefined || call.id !== id || call.controller.signal.aborted) return;
    call.controller.abort(new AbortReason(`cancelled: ${String(reason)}`, "AbortError"));
  }

  #fileReply(id: unknown, fileRef: WireFileRef | undefined, error: WireError | undefined): void {
    if (typeof id !== "string") return;
    const pending = this.#files.get(id);
    if (pending === undefined) return;
    this.#files.delete(id);
    if (error !== undefined) pending.reject(new ScantorError(error.type, error.message, error.retryable ?? false));
    else if (fileRef !== undefined) pending.resolve(fileRef);
  }

  #errorReply(id: string, error: WireError): void {
    if (this.#files.has(id)) {
      this.#fileReply(id, undefined, error);
      return;
    }
    this.#endStream(id, error);
  }

  #endStream(id: string, error: WireError | undefined): void {
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    this.#streams.delete(id);
    if (error === undefined) stream.sink.done();
    else stream.sink.fail(error);
  }

  /** Ends the in-flight request with its reply; later messages of user code for it are dropped. */
  #finish(call: Call, reply: OutgoingMessage): void {
    this.#finishWithLine(call, `${JSON.stringify(reply)}\n`);
  }

  #finishWithLine(call: Call, line: string): void {
    if (!call.active) return;
    this.#endCall(call);
    if (this.#phase === "exiting") return;
    this.#writer.write(line).catch(() => {});
  }

  #endCall(call: Call): void {
    call.end();
    if (this.#call === call) this.#call = undefined;
    for (const [id, pending] of this.#files) {
      if (pending.call !== call) continue;
      this.#files.delete(id);
      pending.reject(new ScantorError("cancelled", "the call ended before the file was registered"));
    }
    this.#closeStreams(call);
  }

  #closeStreams(call: Call): void {
    for (const [id, stream] of this.#streams) {
      if (stream.call !== call) continue;
      this.#streams.delete(id);
      stream.sink.close();
    }
  }

  #channelLost(error: Error): void {
    process.stderr.write(`scantor connector: protocol channel failed: ${error.message}\n`);
    process.exit(1);
  }

  async #exit(code: number): Promise<void> {
    if (this.#phase === "exiting") return;
    this.#phase = "exiting";
    this.#reader.close();
    await this.#writer.end();
    process.exit(code);
  }
}

function exportSchema(field: string, schema: z.ZodType, mode: SchemaMode): JsonObject {
  try {
    return exportJsonSchema(schema, mode);
  } catch (error) {
    throw new Error(`${field} cannot be represented as JSON Schema: ${(error as Error).message}`, { cause: error });
  }
}

function describeWarnings(definition: TaskDefinition): string[] {
  const warnings: string[] = [];
  if (definition.template?.template === "single" && !definition.analysisConfig.safeParse({}).success) {
    warnings.push(
      "the task has no schedule, so every analysis gets the analysis config {}, which analysisConfig rejects; give its fields defaults or add a schedule",
    );
  }
  return warnings;
}

function parseConfig<S extends ConfigSchema>(label: string, schema: S, value: unknown): { value: z.output<S> } | { error: WireError } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { value: parsed.data };
  return { error: validationError(`${label} is invalid`, toIssues(parsed.error)) };
}

function jsonError(label: string, error: unknown): WireError {
  if (error instanceof JsonConversionError) {
    return validationError(`${label} is not JSON-serialisable`, [{ path: error.path, message: error.message }]);
  }
  return toWireError(error);
}

function cancelledError(call: Call): WireError {
  const reason: unknown = call.controller.signal.reason;
  const message = reason instanceof AbortReason ? reason.reply : "cancelled";
  return { type: "cancelled", message };
}

/**
 * Waits for user code; once the call's signal aborts, user code gets ABORT_SETTLE_MS to finish (for
 * example by rethrowing the AbortError of fetch) before the request is ended without it.
 */
async function settleOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  const outcome = promise.then(
    (value): Outcome<T> => ({ kind: "value", value }),
    (error: unknown): Outcome<T> => ({ kind: "error", error }),
  );
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const abandoned = new Promise<Outcome<T>>((resolve) => {
    const giveUp = (): void => {
      timer = setTimeout(() => resolve({ kind: "abandoned" }), ABORT_SETTLE_MS);
    };
    if (signal.aborted) giveUp();
    else {
      onAbort = giveUp;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([outcome, abandoned]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function iteratorOf(source: unknown): Promise<Iterator<unknown> | AsyncIterator<unknown>> {
  const value: unknown = isThenable(source) ? await source : source;
  if (typeof value === "object" && value !== null) {
    const asyncIterator = (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator];
    if (typeof asyncIterator === "function") return asyncIterator.call(value);
    const syncIterator = (value as Partial<Iterable<unknown>>)[Symbol.iterator];
    if (typeof syncIterator === "function") return syncIterator.call(value);
  }
  throw new ScantorError("validation", "schedule must be a generator or return an iterable, an async iterable or an array");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** Lets a generator run its `finally` blocks without waiting for it; the reply was already sent. */
function closeQuietly(iterator: Iterator<unknown> | AsyncIterator<unknown>): void {
  try {
    const closing: unknown = iterator.return?.();
    if (isThenable(closing)) Promise.resolve(closing).catch(() => {});
  } catch {
    // The generator's cleanup failed after its call ended; there is nobody left to report to.
  }
}

async function loadDefinition(entry: string): Promise<TaskDefinition> {
  const entryPath = resolve(process.cwd(), entry);
  assertNotShadowed(entryPath);
  const module = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
  const exported = module.default;
  if (exported instanceof TaskDefinition) return exported;
  const found = exported === undefined ? "nothing" : typeof exported === "object" && exported !== null ? "a plain object" : typeof exported;
  throw new TaskDefinitionError(
    `the default export of ${entry} must be the value returned by defineTask(...) from @scantor/connector, but it is ${found}`,
  );
}

/**
 * The @scantor/connector directory that `entryPath` imports. Node's own resolution (which also covers a
 * package importing itself) answers when the package exports its package.json; a copy that does not is
 * found the way Node finds packages, in the nearest node_modules that has one.
 */
function connectorSeenBy(entryPath: string): string | undefined {
  try {
    return realpathSync(dirname(createRequire(entryPath).resolve("@scantor/connector/package.json")));
  } catch {
    for (let dir = dirname(entryPath); ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", "@scantor", "connector");
      if (existsSync(candidate)) return realpathSync(candidate);
      if (dirname(dir) === dir) return undefined;
    }
  }
}

/** A copy of the connector in the task's own node_modules would load a second, incompatible definition API. */
function assertNotShadowed(entryPath: string): void {
  const ownRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const seen = connectorSeenBy(entryPath);
  if (seen !== undefined && seen !== ownRoot) {
    throw new TaskDefinitionError(
      `${seen} shadows the @scantor/connector of the base image; remove @scantor/connector (and zod) from the task's package.json`,
    );
  }
}

function handshakeError(error: unknown): WireError {
  if (error instanceof TaskDefinitionError) {
    const wire: WireError = { type: "validation", message: truncate(error.message, MAX_ERROR_MESSAGE_CHARS) };
    if (error.stack !== undefined) wire.stack = truncate(error.stack, MAX_ERROR_STACK_CHARS);
    return wire;
  }
  return { ...toWireError(error), type: "taskError" };
}
