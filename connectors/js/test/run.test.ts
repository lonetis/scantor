import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, test } from "node:test";
import { FakeRuntime, type Message } from "./helpers/runtime.ts";

const runtimes: FakeRuntime[] = [];

async function ready(entry = "echo.ts", welcome: Partial<Message> = {}): Promise<FakeRuntime> {
  const runtime = await FakeRuntime.ready(entry, welcome);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
});

let nextRefId = 0;

/** Plays the runtime's side of `file`: checks the path and answers with a FileRef. */
async function answerFile(runtime: FakeRuntime, runId: string): Promise<Message> {
  const file = await runtime.next("file");
  assert.equal(file.parent, runId);
  nextRefId += 1;
  const content = readFileSync(file.path);
  runtime.send({
    type: "fileRef",
    id: file.id,
    fileRef: {
      id: `00000000-0000-4000-8000-${String(nextRefId).padStart(12, "0")}`,
      name: file.name,
      size: content.length,
      sha256: "0".repeat(64),
      contentType: file.contentType ?? "application/octet-stream",
    },
  });
  return { ...file, content: content.toString("utf8") };
}

for (const entry of ["echo.ts", "echo-async.ts"]) {
  describe(`run (${entry})`, () => {
    test("R1: results use defaults and the task config", async () => {
      const runtime = await ready(entry);
      const first = await runtime.reply(runtime.run({}, {}));
      assert.equal(first.type, "result");
      assert.equal(first.result.text, "Hello, world!");
      const second = await runtime.reply(runtime.run({}, { greeting: "Hi" }));
      assert.equal(second.result.text, "Hi, world!");
    });

    test("R2: ctx mirrors the request", async () => {
      const runtime = await ready(entry);
      const id = runtime.run({}, {}, { scanId: "scan-x", analysisId: "scan-x-12", seq: 12, attempt: 3 });
      const reply = await runtime.reply(id);
      assert.deepEqual(reply.result.ctx, {
        scanId: "scan-x",
        analysisId: "scan-x-12",
        seq: 12,
        attempt: 3,
        hasDeadline: true,
        tmpDirWritable: true,
      });
    });

    test("R3: an invalid analysis config is a validation error with issues", async () => {
      const runtime = await ready(entry);
      for (const analysisConfig of [{ name: 5 }, { nmae: "x" }]) {
        const reply = await runtime.reply(runtime.run(analysisConfig));
        assert.equal(reply.type, "error");
        assert.equal(reply.error.type, "validation");
        assert.match(reply.error.message, /analysis config is invalid/);
        assert.ok(reply.error.details.issues.length > 0);
      }
      const typed = await runtime.reply(runtime.run({ name: 5 }));
      assert.equal(typed.error.details.issues[0].path, "/name");
      const task = await runtime.reply(runtime.run({}, { greeting: 1 }));
      assert.match(task.error.message, /task config is invalid/);
    });

    test("R4: Fatal, Retry and exceptions are classified", async () => {
      const runtime = await ready(entry);
      const fatal = await runtime.reply(runtime.run({ mode: "fatal" }));
      assert.deepEqual([fatal.error.type, fatal.error.message], ["fatal", "fatal requested"]);
      const retry = await runtime.reply(runtime.run({ mode: "retry" }));
      assert.equal(retry.error.type, "retry");
      assert.equal(retry.error.delayMs, undefined);
      const retryAfter = await runtime.reply(runtime.run({ mode: "retryAfter" }));
      assert.deepEqual([retryAfter.error.type, retryAfter.error.delayMs], ["retry", 1500]);
      const thrown = await runtime.reply(runtime.run({ mode: "throw" }));
      assert.equal(thrown.error.type, "taskError");
      assert.equal(thrown.error.message, "boom");
      assert.match(thrown.error.stack, /echo-modes\.ts/);
    });

    test("R5: an invalid result is a validation error", async () => {
      const runtime = await ready(entry);
      const reply = await runtime.reply(runtime.run({ mode: "invalidResult" }));
      assert.equal(reply.error.type, "validation");
      assert.equal(reply.error.details.issues[0].path, "/text");
    });

    test("R6: results above maxResultBytes travel; the runtime enforces that limit", async () => {
      const runtime = await ready(entry);
      const reply = await runtime.reply(runtime.run({ mode: "oversized", bytes: 2 * 1024 * 1024 }));
      assert.equal(reply.type, "result");
      assert.equal(reply.result.text.length, 2 * 1024 * 1024);
    });

    test("results above the line limit are a validation error", async () => {
      const runtime = await ready(entry, { limits: { maxLineBytes: 4096, maxResultBytes: 1024, maxAnalysisConfigBytes: 1024, maxFileBytes: 1024, maxFilesPerAnalysis: 1 } });
      const reply = await runtime.reply(runtime.run({ mode: "oversized", bytes: 8192 }));
      assert.equal(reply.error.type, "validation");
      assert.match(reply.error.message, /store large data with ctx\.files/);
    });

    test("R7: prints never reach fd 4", async () => {
      const runtime = await ready(entry);
      const reply = await runtime.reply(runtime.run({ mode: "stdout" }));
      assert.equal(reply.type, "result");
      assert.match(runtime.stdout, /"type":"result","id":"r0"/);
      assert.match(runtime.stderr, /noise/);
      assert.ok(runtime.received.every((message) => message.id !== "r0"));
    });

    test("R8/R9: log and progress carry the run id as parent", async () => {
      const runtime = await ready(entry);
      const logId = runtime.run({ mode: "log" });
      const log = await runtime.next("log");
      assert.deepEqual(log, { type: "log", parent: logId, level: "info", message: "hello", fields: { n: 1 } });
      await runtime.reply(logId);
      const progressId = runtime.run({ mode: "progress" });
      const progress = await runtime.next("progress");
      assert.deepEqual(progress, { type: "progress", parent: progressId, fraction: 0.5, message: "half" });
      await runtime.reply(progressId);
    });

    test("R10: files are written into filesDir and registered", async () => {
      const runtime = await ready(entry);
      const id = runtime.run({ mode: "file" });
      const files = [await answerFile(runtime, id), await answerFile(runtime, id), await answerFile(runtime, id)];
      const reply = await runtime.reply(id);
      assert.deepEqual(
        files.map((file) => [file.name, file.content, file.contentType]),
        [
          ["a.bin", "abc", "application/octet-stream"],
          ["b.txt", "hello", null],
          ["c.json", '{"c":true}', null],
        ],
      );
      const filesDir = dirname(files[0]!.path);
      for (const file of files) assert.equal(dirname(file.path), filesDir);
      assert.equal(new Set(files.map((file) => file.id)).size, 3);
      assert.deepEqual(
        reply.result.files.map((ref: Message) => ref.name),
        ["a.bin", "b.txt", "c.json"],
      );
      assert.equal(reply.result.files[0].size, 3);
    });

    test("R11: an invalid file name fails the run with validation before any file message", async () => {
      const runtime = await ready(entry);
      const reply = await runtime.reply(runtime.run({ mode: "fileError" }));
      assert.equal(reply.error.type, "validation");
      assert.match(reply.error.message, /must not contain "\/"/);
      assert.ok(runtime.received.every((message) => message.type !== "file"));
    });

    test("R12: secrets arrive in plaintext", async () => {
      const runtime = await ready(entry);
      const reply = await runtime.reply(runtime.run({}, { apiToken: "s3cret" }));
      assert.equal(reply.result.secretLength, 6);
    });

    test("R14: 50 sequential runs on one process", async () => {
      const runtime = await ready(entry);
      for (let index = 0; index < 50; index++) {
        const reply = await runtime.reply(runtime.run({ name: `n${index}` }));
        assert.equal(reply.result.text, `Hello, n${index}!`);
        assert.equal(reply.result.ctx.tmpDirWritable, true);
      }
    });

    test("C1: cancel ends a cooperative run with cancelled", async () => {
      const runtime = await ready(entry);
      const id = runtime.run({ mode: "sleep", sleepMs: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      runtime.send({ type: "cancel", id, reason: "drain" });
      const reply = await runtime.reply(id);
      assert.deepEqual(reply.error, { type: "cancelled", message: "cancelled: drain" });
      assert.ok(Date.now() - started < 5000);
    });

    test("C5: the deadline timer cancels user code", async () => {
      const runtime = await ready(entry);
      const deadlineMs = Date.now() + 300;
      const id = runtime.run({ mode: "sleep", sleepMs: 60_000 }, {}, { deadlineMs });
      const reply = await runtime.reply(id);
      assert.deepEqual(reply.error, { type: "cancelled", message: "deadline exceeded" });
      assert.ok(Date.now() >= deadlineMs);
      assert.ok(Date.now() - deadlineMs < 2000);
    });

    test("C4: process exit during a run produces no reply", async () => {
      const runtime = await ready(entry);
      const id = runtime.run({ mode: "exit" });
      assert.equal((await runtime.exited).code, 3);
      assert.ok(runtime.received.every((message) => message.id !== id));
    });
  });
}

describe("run (connector behaviour)", () => {
  test("a file error from the runtime fails the run with that error", async () => {
    const runtime = await ready("echo.ts");
    const id = runtime.run({ mode: "fileRuntimeError" });
    const file = await runtime.next("file");
    runtime.send({ type: "error", id: file.id, error: { type: "validation", message: "file big.bin is too large", retryable: false } });
    const reply = await runtime.reply(id);
    assert.deepEqual([reply.error.type, reply.error.message], ["validation", "file big.bin is too large"]);
  });

  test("an uncooperative async run is ended shortly after cancel", async () => {
    const runtime = await ready("echo-async.ts");
    const id = runtime.run({ mode: "sleepIgnoringSignal", sleepMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.send({ type: "cancel", id, reason: "stop" });
    const reply = await runtime.reply(id, 4000);
    assert.deepEqual(reply.error, { type: "cancelled", message: "cancelled: stop" });
  });

  test("a cancel for another id is ignored", async () => {
    const runtime = await ready("echo.ts");
    const id = runtime.run({ mode: "sleep", sleepMs: 200 });
    runtime.send({ type: "cancel", id: "r999", reason: "drain" });
    assert.equal((await runtime.reply(id)).type, "result");
  });

  test("files are not available in schedule, templates not in run", async () => {
    const runtime = await ready("schedule-misuse.ts");
    const scheduled = await runtime.reply(runtime.schedule({ mode: "files" }));
    assert.deepEqual([scheduled.error.type, scheduled.error.message], ["validation", "files are only available in run"]);
    const ran = await runtime.reply(runtime.run({ n: 99 }));
    assert.equal(ran.error.type, "validation");
    assert.match(ran.error.message, /templates are only available in schedule/);
  });

  test("results are converted to plain JSON or rejected", async () => {
    const runtime = await ready("json-edge.ts");
    const date = await runtime.reply(runtime.run({ mode: "date" }));
    assert.deepEqual(date.result, { value: "2026-10-21T00:00:00.000Z" });
    const dropped = await runtime.reply(runtime.run({ mode: "undefinedProperty" }));
    assert.deepEqual(dropped.result, { value: { kept: 1 } });
    for (const [mode, path] of [
      ["infinity", "/value/nested/1"],
      ["bigint", "/value"],
      ["map", "/value"],
      ["undefinedInArray", "/value/1"],
    ]) {
      const reply = await runtime.reply(runtime.run({ mode }));
      assert.equal(reply.error.type, "validation", mode);
      assert.match(reply.error.message, /result is not JSON-serialisable/);
      assert.equal(reply.error.details.issues[0].path, path, mode);
    }
  });

  test("JavaScript entries run", async () => {
    const runtime = await ready("minimal.js");
    const reply = await runtime.reply(runtime.run());
    assert.deepEqual(reply.result, { ok: true });
  });
});
