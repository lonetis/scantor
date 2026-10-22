import { createReadStream, createWriteStream, fstatSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

const O_ACCMODE = 0o3;
const O_RDONLY = 0o0;
const O_WRONLY = 0o1;

/** Linux open-file flags of `fd` from /proc, or undefined where /proc is not available. */
function linuxFlags(fd: number): number | undefined {
  try {
    const flags = /^flags:\s*([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
    return flags === null ? undefined : Number.parseInt(flags[1]!, 8);
  } catch {
    return undefined;
  }
}

/**
 * True when `fd` looks like a protocol channel the runtime passed in: a pipe or socket open for
 * `direction`. Without them the low descriptors may be closed or belong to Node itself, whose event loop
 * opens descriptors at start (on Linux an epoll instance and the read end of an internal pipe).
 */
export function isProtocolFd(fd: number, direction: "read" | "write"): boolean {
  try {
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) return false;
  } catch {
    return false;
  }
  const flags = linuxFlags(fd);
  if (flags === undefined) return true;
  const access = flags & O_ACCMODE;
  return direction === "read" ? access !== O_WRONLY : access !== O_RDONLY;
}

/** Pipes (the runtime's channels) are opened as non-blocking sockets; anything else as a file stream. */
function openReadable(fd: number): Readable {
  try {
    return new Socket({ fd, readable: true, writable: false });
  } catch {
    return createReadStream("", { fd, autoClose: false });
  }
}

function openWritable(fd: number): Writable {
  try {
    return new Socket({ fd, readable: false, writable: true });
  } catch {
    return createWriteStream("", { fd, autoClose: false });
  }
}

export interface LineHandlers {
  line(line: string): void;
  end(): void;
  error(error: Error): void;
}

/**
 * Splits fd 3 into lines. Reading never waits for writes on fd 4, so `cancel` and template messages are
 * received while a write blocks (docs/protocol.md §6.1).
 */
export class LineReader {
  readonly #stream: Readable;

  constructor(fd: number, handlers: LineHandlers) {
    this.#stream = openReadable(fd);
    let pending: Buffer[] = [];
    this.#stream.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, index));
        const line = Buffer.concat(pending).toString("utf8");
        pending = [];
        start = index + 1;
        if (line.length > 0) handlers.line(line);
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    this.#stream.on("end", () => handlers.end());
    this.#stream.on("error", (error) => handlers.error(error));
  }

  close(): void {
    this.#stream.destroy();
  }
}

/**
 * Writes whole NDJSON lines to fd 4 from a single writer, so lines never interleave. `write` resolves once
 * the line is accepted below the stream's high-water mark: awaiting it propagates pipe backpressure into
 * user code (a schedule generator) instead of queueing without bound.
 */
export class LineWriter {
  readonly #stream: Writable;
  #failed: Error | undefined;

  constructor(fd: number, onError: (error: Error) => void) {
    this.#stream = openWritable(fd);
    this.#stream.on("error", (error) => {
      this.#failed = error;
      onError(error);
    });
  }

  write(line: string): Promise<void> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#stream.write(line)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = (): void => {
        this.#stream.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        this.#stream.off("drain", onDrain);
        reject(error);
      };
      this.#stream.once("drain", onDrain);
      this.#stream.once("error", onError);
    });
  }

  /** Flushes everything written so far and closes fd 4. */
  end(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#failed !== undefined || this.#stream.writableFinished) {
        resolve();
        return;
      }
      this.#stream.end(() => resolve());
    });
  }
}
