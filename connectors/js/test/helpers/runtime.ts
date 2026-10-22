// A scripted fake of the scantor runtime: spawns a connector process with the protocol on fds 3/4,
// validates every line it writes against schemas/protocol, and lets tests drive it message by message.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { validateConnectorLine } from "./schemas.ts";

export const SERVE_JS = fileURLToPath(new URL("../../serve.js", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The connector as the base image installs it; tasks outside this package resolve it there. */
export const INSTALLED_CONNECTOR = "/node_modules/@scantor/connector";
/** Skip reason for tests that need the installed connector (they run in the base image's test stage). */
export const NEEDS_INSTALLED_CONNECTOR = existsSync(`${INSTALLED_CONNECTOR}/package.json`)
  ? false
  : `needs ${INSTALLED_CONNECTOR} of the base image; runs in the test stage of connectors/js/Dockerfile`;

export type Message = Record<string, any>;

export const DEFAULT_LIMITS = {
  maxLineBytes: 8 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxAnalysisConfigBytes: 64 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  maxFilesPerAnalysis: 100,
};

export interface StartOptions {
  /** Entry path; relative entries are resolved against the fixtures directory (the cwd). */
  entry: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Spawn without fds 3/4. */
  withoutProtocolFds?: boolean;
  /** Serve with the connector installed in the base image instead of this package's sources. */
  installed?: boolean;
}

export interface TemplateReport {
  request: Message;
  sent: number;
  maxAllowance: number;
  cancelled: boolean;
}

interface Waiter {
  predicate: (message: Message) => boolean;
  resolve: (message: Message) => void;
}

export class FakeRuntime {
  readonly child: ChildProcess;
  readonly received: Message[] = [];
  readonly violations: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout = "";
  stderr = "";
  readonly #toConnector: Writable | undefined;
  readonly #fromConnector: Readable | undefined;
  readonly #queue: Message[] = [];
  #waiters: Waiter[] = [];
  #ids = 0;
  #pending: Buffer[] = [];

  constructor(options: StartOptions) {
    const stdio = options.withoutProtocolFds
      ? (["ignore", "pipe", "pipe"] as const)
      : (["ignore", "pipe", "pipe", "pipe", "pipe"] as const);
    const command = options.installed
      ? [`${INSTALLED_CONNECTOR}/serve.js`, options.entry]
      : ["--conditions=scantor-source", SERVE_JS, options.entry];
    this.child = spawn(process.execPath, command, {
      cwd: options.cwd ?? FIXTURES,
      stdio: [...stdio],
      env: { ...process.env, ...options.env },
    });
    this.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (this.stdout += chunk));
    this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => this.child.on("exit", (code, signal) => resolve({ code, signal })));
    if (!options.withoutProtocolFds) {
      this.#toConnector = this.child.stdio[3] as Writable;
      this.#fromConnector = this.child.stdio[4] as Readable;
      this.#toConnector.on("error", () => {});
      this.#fromConnector.on("data", (chunk: Buffer) => this.#data(chunk));
    }
  }

  static start(options: StartOptions): FakeRuntime {
    return new FakeRuntime(options);
  }

  /** hello → welcome → ready; returns the hello message. */
  static async ready(entry: string, welcome: Partial<Message> = {}, options: Partial<StartOptions> = {}): Promise<FakeRuntime> {
    const runtime = FakeRuntime.start({ entry, ...options });
    await runtime.next("hello");
    runtime.welcome(welcome);
    await runtime.next("ready");
    return runtime;
  }

  welcome(overrides: Partial<Message> = {}): void {
    this.send({
      type: "welcome",
      id: "hello",
      protocolVersion: 1,
      mode: "local",
      runtime: { version: "test" },
      limits: DEFAULT_LIMITS,
      cancelGraceMs: 5000,
      ...overrides,
    });
  }

  send(message: Message): void {
    this.#toConnector?.write(`${JSON.stringify(message)}\n`);
  }

  nextRequestId(prefix: string): string {
    this.#ids += 1;
    return `${prefix}${this.#ids}`;
  }

  /** Pauses reading fd 4, so the connector's writes block once the pipe is full. */
  pauseReading(): void {
    this.#fromConnector?.pause();
  }

  resumeReading(): void {
    this.#fromConnector?.resume();
  }

  /** The next message (optionally of `type`, skipping others into `skipped`), within `timeoutMs`. */
  next(type?: string | ((message: Message) => boolean), timeoutMs = 10_000): Promise<Message> {
    const predicate = typeof type === "function" ? type : (message: Message) => type === undefined || message.type === type;
    const index = this.#queue.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.#queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== done);
        reject(new Error(`timed out waiting for ${typeof type === "string" ? type : "a message"}; stderr: ${this.stderr}`));
      }, timeoutMs);
      const done = (message: Message): void => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push({ predicate, resolve: done });
    });
  }

  /** Messages that arrived but were not consumed by `next`. */
  pending(): Message[] {
    return [...this.#queue];
  }

  ctx(overrides: Partial<Message> = {}, kind: "run" | "schedule" = "run"): Message {
    const executionId = `e${this.nextRequestId("")}`;
    const root = mkdtempSync(join(tmpdir(), "scantor-js-x-"));
    mkdirSync(join(root, "tmp"));
    if (kind === "run") mkdirSync(join(root, "files"));
    this.#dirs.push(root);
    return {
      scanId: "scan-1",
      analysisId: kind === "run" ? "scan-1-7" : null,
      seq: kind === "run" ? 7 : null,
      round: kind === "run" ? 1 : null,
      attempt: 1,
      executionId: kind === "run" ? executionId : null,
      deadlineMs: kind === "run" ? Date.now() + 60_000 : null,
      tmpDir: join(root, "tmp"),
      filesDir: kind === "run" ? join(root, "files") : null,
      ...overrides,
    };
  }

  /** Sends `run` and returns its id. */
  run(analysisConfig: Message = {}, taskConfig: Message = {}, ctx: Partial<Message> = {}): string {
    const id = this.nextRequestId("r");
    this.send({ type: "run", id, ctx: this.ctx(ctx, "run"), analysisConfig, taskConfig });
    return id;
  }

  schedule(scanConfig: Message = {}, taskConfig: Message = {}): string {
    const id = this.nextRequestId("s");
    this.send({ type: "schedule", id, ctx: this.ctx({}, "schedule"), scanConfig, taskConfig });
    return id;
  }

  /** The reply (`result`, `done`, `description` or `error`) to request `id`. */
  reply(id: string, timeoutMs = 10_000): Promise<Message> {
    return this.next(
      (message) => message.id === id && ["result", "done", "description", "error"].includes(message.type),
      timeoutMs,
    );
  }

  /** The `analysis` configs of schedule `id` and the message that ends it (`done` or `error`). */
  async collect(id: string): Promise<{ configs: Message[]; end: Message }> {
    const configs: Message[] = [];
    for (;;) {
      const message = await this.next((candidate) => candidate.id === id && ["analysis", "done", "error"].includes(candidate.type));
      if (message.type !== "analysis") return { configs, end: message };
      configs.push(message.config);
    }
  }

  /**
   * Plays the runtime's side of the next template stream: sends `items` strictly within the granted
   * allowance (template.credit + every templateCredit) and answers templateCancel with templateDone.
   */
  async serveTemplate(items: Message[], options: { doneDelayMs?: number } = {}): Promise<TemplateReport> {
    const request = await this.next("template");
    let allowance: number = request.credit;
    let maxAllowance = allowance;
    let sent = 0;
    const isControl = (message: Message): boolean =>
      message.id === request.id && (message.type === "templateCredit" || message.type === "templateCancel");
    for (;;) {
      while (sent < items.length && sent < allowance) {
        this.send({ type: "templateItem", id: request.id, config: items[sent] });
        sent += 1;
      }
      if (sent === items.length) break;
      const control = await this.next(isControl);
      if (control.type === "templateCancel") {
        if (options.doneDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.doneDelayMs));
        this.send({ type: "templateDone", id: request.id, count: sent });
        return { request, sent, maxAllowance, cancelled: true };
      }
      allowance += control.credit;
      maxAllowance = Math.max(maxAllowance, allowance - sent);
    }
    this.send({ type: "templateDone", id: request.id, count: sent });
    return { request, sent, maxAllowance, cancelled: false };
  }

  /** Answers a `file` request with a FileRef computed from the file's content, as the runtime does. */
  answerFile(request: Message): Message {
    const content = readFileSync(request.path);
    const fileRef = {
      id: randomUUID(),
      name: request.name,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentType: request.contentType ?? "application/octet-stream",
    };
    this.send({ type: "fileRef", id: request.id, fileRef });
    return fileRef;
  }

  async shutdown(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.send({ type: "shutdown", id: this.nextRequestId("x"), graceMs: 5000 });
    return this.exited;
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  cleanup(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.kill();
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
  }

  readonly #dirs: string[] = [];

  #data(chunk: Buffer): void {
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      this.#pending.push(chunk.subarray(start, index));
      this.#line(Buffer.concat(this.#pending).toString("utf8"));
      this.#pending = [];
      start = index + 1;
    }
    if (start < chunk.length) this.#pending.push(chunk.subarray(start));
  }

  #line(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.violations.push(`not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (!validateConnectorLine(message)) {
      this.violations.push(`${line.slice(0, 300)}: ${JSON.stringify(validateConnectorLine.errors?.slice(0, 3))}`);
    }
    this.received.push(message);
    const waiter = this.#waiters.find((candidate) => candidate.predicate(message));
    if (waiter !== undefined) {
      this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(message);
    } else {
      this.#queue.push(message);
    }
  }
}
