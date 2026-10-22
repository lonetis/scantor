import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeRuntime } from "./helpers/runtime.ts";

const runtimes: FakeRuntime[] = [];
const dirs: string[] = [];

function start(...args: Parameters<typeof FakeRuntime.start>): FakeRuntime {
  const runtime = FakeRuntime.start(...args);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempTask(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scantor-js-task-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("handshake", () => {
  test("H1: hello before import, then ready; import-time prints stay on stdout/stderr", async () => {
    const runtime = start({ entry: "echo.ts" });
    const hello = await runtime.next("hello");
    assert.equal(hello.id, "hello");
    assert.deepEqual(hello.protocol, { min: 1, max: 1 });
    assert.equal(hello.connector.language, "typescript");
    assert.match(hello.connector.runtime, /^node \d+\./);
    assert.equal(hello.pid, runtime.child.pid);
    assert.equal(runtime.stdout, "", "the entry is not imported before welcome");
    runtime.welcome();
    await runtime.next("ready");
    assert.match(runtime.stdout, /importing echo/);
    assert.match(runtime.stderr, /importing echo/);
    assert.deepEqual(runtime.pending(), []);
    assert.equal((await runtime.shutdown()).code, 0);
  });

  test("the language follows the entry extension", async () => {
    const runtime = start({ entry: "minimal.js" });
    assert.equal((await runtime.next("hello")).connector.language, "javascript");
    runtime.welcome();
    await runtime.next("ready");
    assert.equal((await runtime.shutdown()).code, 0);
  });

  test("H2: a rejected hello makes the connector exit non-zero without writing more", async () => {
    const runtime = start({ entry: "echo.ts" });
    await runtime.next("hello");
    runtime.send({ type: "error", id: "hello", error: { type: "validation", message: "connector protocol 1..1 is not supported" } });
    const exit = await runtime.exited;
    assert.notEqual(exit.code, 0);
    assert.equal(runtime.received.length, 1);
  });

  test("H3: an exception at import is a taskError with stack, exit 1", async () => {
    const runtime = start({ entry: "import-error.ts" });
    await runtime.next("hello");
    runtime.welcome();
    const error = await runtime.next("error");
    assert.equal(error.id, "hello");
    assert.equal(error.error.type, "taskError");
    assert.match(error.error.message, /boom at import/);
    assert.match(error.error.stack, /import-error\.ts/);
    assert.equal((await runtime.exited).code, 1);
  });

  test("H4: a default export that is not defineTask(...) is a validation error, exit 1", async () => {
    const runtime = start({ entry: "bad-definition.ts" });
    await runtime.next("hello");
    runtime.welcome();
    const error = await runtime.next("error");
    assert.equal(error.error.type, "validation");
    assert.match(error.error.message, /must be the value returned by defineTask/);
    assert.match(error.error.message, /plain object/);
    assert.equal((await runtime.exited).code, 1);
  });

  // Node's own descriptors on macOS are indistinguishable pipes; the target is Linux.
  test("H5: without fds 3/4 the connector explains itself and exits 2", { skip: process.platform !== "linux" }, async () => {
    const runtime = start({ entry: "echo.ts", withoutProtocolFds: true });
    assert.equal((await runtime.exited).code, 2);
    assert.match(runtime.stderr, /this program is a scantor task connector; run it with "scantor dev run"/);
  });

  test("a config root built with z.object fails the definition", async () => {
    const runtime = start({ entry: "open-config.ts" });
    await runtime.next("hello");
    runtime.welcome();
    const error = await runtime.next("error");
    assert.equal(error.error.type, "validation");
    assert.match(error.error.message, /taskConfig must be created with config\(\) or z\.strictObject\(\)/);
  });

  test("a scan config without a schedule fails the definition", async () => {
    const runtime = start({ entry: "scan-config-without-schedule.ts" });
    await runtime.next("hello");
    runtime.welcome();
    const error = await runtime.next("error");
    assert.equal(error.error.type, "validation");
    assert.match(error.error.message, /scanConfig needs a schedule/);
    assert.equal((await runtime.exited).code, 1);
  });

  test("an unsupported protocol version in welcome is rejected", async () => {
    const runtime = start({ entry: "echo.ts" });
    await runtime.next("hello");
    runtime.welcome({ protocolVersion: 2 });
    const error = await runtime.next("error");
    assert.equal(error.error.type, "validation");
    assert.equal((await runtime.exited).code, 1);
  });

  for (const exports of ['{"./package.json":"./package.json"}', '{".":"./index.js"}']) {
    test(`a connector copy in the task's node_modules (shadowing) fails the definition (exports ${exports})`, async () => {
      const dir = tempTask({
        "main.ts": 'export default 1;\n',
        "package.json": '{"type":"module"}',
        "node_modules/@scantor/connector/package.json": `{"name":"@scantor/connector","exports":${exports}}`,
      });
      const runtime = start({ entry: "main.ts", cwd: dir });
      await runtime.next("hello");
      runtime.welcome();
      const error = await runtime.next("error");
      assert.equal(error.error.type, "validation");
      assert.match(error.error.message, /node_modules\/@scantor\/connector shadows the @scantor\/connector of the base image/);
    });
  }

  test("schemas of another zod copy are rejected", async () => {
    const connectorRoot = fileURLToPath(new URL("../", import.meta.url));
    const dir = tempTask({
      "package.json": '{"type":"module"}',
      "main.ts": [
        'import { z } from "zod";',
        'import { defineTask } from "@scantor/connector";',
        "export default defineTask({ result: z.object({ ok: z.boolean() }), run: () => ({ ok: true }) });",
        "",
      ].join("\n"),
    });
    // The connector under test linked into the task, as the devcontainer links the repository's copy.
    mkdirSync(join(dir, "node_modules/@scantor"), { recursive: true });
    symlinkSync(connectorRoot, join(dir, "node_modules/@scantor/connector"));
    cpSync(join(connectorRoot, "node_modules/zod"), join(dir, "node_modules/zod"), { recursive: true });
    const runtime = start({ entry: "main.ts", cwd: dir });
    await runtime.next("hello");
    runtime.welcome();
    const error = await runtime.next("error");
    assert.equal(error.error.type, "validation");
    assert.match(error.error.message, /result was not created with the z exported by @scantor\/connector/);
  });

  test("P2/P3: unknown fields are ignored, unknown requests answered with validation", async () => {
    const runtime = await FakeRuntime.ready("echo.ts", { xFuture: 1 });
    runtimes.push(runtime);
    runtime.send({ type: "frobnicate", id: "z1" });
    const error = await runtime.next("error");
    assert.equal(error.id, "z1");
    assert.equal(error.error.type, "validation");
    assert.match(error.error.message, /unsupported request frobnicate/);
    const id = runtime.nextRequestId("r");
    runtime.send({ type: "run", id, ctx: runtime.ctx(), analysisConfig: {}, taskConfig: {}, xFuture: 1 });
    const reply = await runtime.reply(id);
    assert.equal(reply.type, "result");
    assert.equal(reply.result.text, "Hello, world!");
  });

  test("C3: shutdown of an idle process exits 0; EOF on fd 3 too", async () => {
    const first = await FakeRuntime.ready("echo.ts");
    runtimes.push(first);
    assert.equal((await first.shutdown()).code, 0);

    const second = await FakeRuntime.ready("echo.ts");
    runtimes.push(second);
    (second.child.stdio[3] as NodeJS.WritableStream).end();
    assert.equal((await second.exited).code, 0);
  });

  test("requests before ready and a second request in flight are rejected", async () => {
    const runtime = start({ entry: "echo.ts" });
    await runtime.next("hello");
    runtime.send({ type: "describe", id: "d0" });
    const early = await runtime.reply("d0");
    assert.equal(early.type, "error");
    assert.match(early.error.message, /not ready/);
    runtime.welcome();
    await runtime.next("ready");
    const first = runtime.run({ mode: "sleep", sleepMs: 300 });
    const second = runtime.run();
    const rejected = await runtime.reply(second);
    assert.equal(rejected.type, "error");
    assert.match(rejected.error.message, /still in flight/);
    assert.equal((await runtime.reply(first)).type, "result");
  });
});
