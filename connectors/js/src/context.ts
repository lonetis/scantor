import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScantorError } from "./errors.ts";
import { toLenientJson, truncate } from "./json.ts";
import {
  MAX_LOG_FIELDS_BYTES,
  MAX_LOG_MESSAGE_CHARS,
  MAX_PROGRESS_MESSAGE_CHARS,
  type FileMessage,
  type JsonObject,
  type Limits,
  type OutgoingMessage,
  type TemplateMessage,
  type WireContext,
  type WireError,
  type WireFileRef,
} from "./protocol.ts";
import type { FileRef } from "./schema.ts";

export type LogLevel = "debug" | "info" | "warning" | "error";

export type FileData = Uint8Array | string | { path: string };

export interface Files {
  /**
   * Registers a file of this analysis attempt and returns its reference at once; the platform uploads it
   * only after `run` succeeded. `data`: bytes, UTF-8 text, or `{ path }` of an existing file (copied now).
   * `contentType` defaults to application/octet-stream; pass it for images to be shown inline.
   */
  put(name: string, data: FileData, contentType?: string): Promise<FileRef>;
}

/** Per-call context of `schedule` and `run` (docs/tasks.md §5.2). */
export interface Context {
  readonly scanId: string;
  /** `<scanId>-<seq>`; null in `schedule`. */
  readonly analysisId: string | null;
  /** Position of the analysis in the schedule stream; null in `schedule`. */
  readonly seq: number | null;
  /** 1-based attempt of this analysis; in `schedule` the scheduler start count. */
  readonly attempt: number;
  /** Epoch milliseconds at which the call is ended; null when there is none. */
  readonly deadline: number | null;
  /** Aborts at the deadline and when the worker drains or stops; pass it to fetch and other APIs. */
  readonly signal: AbortSignal;
  /** An empty directory private to this call, deleted afterwards. */
  readonly tmpDir: string;
  readonly files: Files;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  /** Progress of the analysis (fraction 0…1 or null when unknown); ignored in `schedule`. */
  progress(fraction: number | null, message?: string): void;
}

/** Receives the runtime's messages for one wrapped template stream. */
export interface TemplateSink {
  item(config: JsonObject): void;
  done(): void;
  fail(error: WireError): void;
  /** The parent call ended; the runtime closes the stream implicitly. */
  close(): void;
}

/** What a call needs from the connector process: ids, the outgoing channel and pending replies. */
export interface Link {
  readonly limits: Limits;
  nextId(): string;
  send(message: OutgoingMessage): void;
  requestFile(call: Call, message: FileMessage): Promise<WireFileRef>;
  openTemplate(call: Call, message: TemplateMessage, sink: TemplateSink): void;
  closeTemplate(id: string): void;
}

export type CallKind = "run" | "schedule";

/** The state of one runtime request (`run` or `schedule`) while user code handles it. */
export class Call {
  readonly id: string;
  readonly kind: CallKind;
  readonly wire: WireContext;
  readonly link: Link;
  readonly controller = new AbortController();
  #active = true;
  #fileIndex = 0;

  constructor(id: string, kind: CallKind, wire: WireContext, link: Link) {
    this.id = id;
    this.kind = kind;
    this.wire = wire;
    this.link = link;
  }

  get active(): boolean {
    return this.#active;
  }

  end(): void {
    this.#active = false;
  }

  nextFileIndex(): number {
    return this.#fileIndex++;
  }
}

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warning", "error"]);
const contextCalls = new WeakMap<object, Call>();

/** The call behind a `Context`, for template proxies; undefined for anything else. */
export function callOf(ctx: unknown): Call | undefined {
  return typeof ctx === "object" && ctx !== null ? contextCalls.get(ctx) : undefined;
}

export function createContext(call: Call): Context {
  const ctx = new TaskContext(call);
  contextCalls.set(ctx, call);
  return ctx;
}

class TaskContext implements Context {
  readonly files: Files;
  readonly #call: Call;

  constructor(call: Call) {
    this.#call = call;
    this.files = { put: (name, data, contentType) => putFile(call, name, data, contentType) };
  }

  get scanId(): string {
    return this.#call.wire.scanId;
  }

  get analysisId(): string | null {
    return this.#call.wire.analysisId;
  }

  get seq(): number | null {
    return this.#call.wire.seq;
  }

  get attempt(): number {
    return this.#call.wire.attempt;
  }

  get deadline(): number | null {
    return this.#call.wire.deadlineMs;
  }

  get signal(): AbortSignal {
    return this.#call.controller.signal;
  }

  get tmpDir(): string {
    return this.#call.wire.tmpDir;
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const call = this.#call;
    // After the request ended its id is no longer a valid parent.
    if (!call.active) return;
    const entry: OutgoingMessage = {
      type: "log",
      parent: call.id,
      level: LOG_LEVELS.has(level) ? level : "info",
      message: truncate(String(message), MAX_LOG_MESSAGE_CHARS),
    };
    if (fields !== undefined && fields !== null) {
      const json = toLenientJson(fields);
      entry.fields = Buffer.byteLength(JSON.stringify(json)) <= MAX_LOG_FIELDS_BYTES ? json : { truncated: true };
    }
    call.link.send(entry);
  }

  progress(fraction: number | null, message?: string): void {
    const call = this.#call;
    if (!call.active || call.kind !== "run") return;
    const value = typeof fraction === "number" && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
    call.link.send({
      type: "progress",
      parent: call.id,
      fraction: value,
      message: message === undefined || message === null ? null : truncate(String(message), MAX_PROGRESS_MESSAGE_CHARS),
    });
  }
}

const MAX_FILE_NAME_CHARS = 255;
const MAX_FS_NAME_BYTES = 255;

function fileNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") return "file names must be strings";
  const length = [...name].length;
  if (length < 1 || length > MAX_FILE_NAME_CHARS) return `file name must have 1–${MAX_FILE_NAME_CHARS} characters`;
  if (/[/\\\0]/.test(name)) return `file name ${JSON.stringify(name)} must not contain "/", "\\" or NUL`;
  return undefined;
}

/** On-disk name inside filesDir; the runtime only needs a unique regular file there. */
function storedName(index: number, name: string): string {
  const candidate = `${index}-${name}`;
  return Buffer.byteLength(candidate) <= MAX_FS_NAME_BYTES ? candidate : String(index);
}

async function putFile(call: Call, name: string, data: FileData, contentType: string | undefined): Promise<FileRef> {
  if (call.kind !== "run" || call.wire.filesDir === null) {
    throw new ScantorError("validation", "files are only available in run");
  }
  if (!call.active) throw new ScantorError("cancelled", `files.put(${JSON.stringify(name)}) after the call ended`);
  const problem = fileNameProblem(name);
  if (problem !== undefined) throw new ScantorError("validation", problem);
  if (contentType !== undefined && contentType !== null && (typeof contentType !== "string" || contentType.length < 1 || contentType.length > 255)) {
    throw new ScantorError("validation", "contentType must be a string of 1–255 characters");
  }

  const path = join(call.wire.filesDir, storedName(call.nextFileIndex(), name));
  if (typeof data === "string" || data instanceof Uint8Array) {
    await writeFile(path, data, { flag: "wx" });
  } else if (typeof data === "object" && data !== null && typeof data.path === "string") {
    try {
      // A copy, so later changes to the user's file cannot alter what is uploaded.
      await copyFile(data.path, path);
    } catch (error) {
      throw new ScantorError("validation", `cannot copy ${data.path}: ${(error as Error).message}`);
    }
  } else {
    throw new ScantorError("validation", "files.put data must be a Uint8Array, a string or { path }");
  }

  const ref = await call.link.requestFile(call, {
    type: "file",
    id: call.link.nextId(),
    parent: call.id,
    name,
    path,
    contentType: contentType ?? null,
  });
  return { id: ref.id, name: ref.name, size: ref.size, sha256: ref.sha256, contentType: ref.contentType };
}
