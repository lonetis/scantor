import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { FakeRuntime } from "./helpers/runtime.ts";

const runtimes: FakeRuntime[] = [];

async function ready(entry: string): Promise<FakeRuntime> {
  const runtime = await FakeRuntime.ready(entry);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
});

for (const entry of ["schedule.ts", "schedule-async.ts"]) {
  describe(`schedule (${entry})`, () => {
    test("S1: analyses in order, then done with the count", async () => {
      const runtime = await ready(entry);
      const { configs, end } = await runtime.collect(runtime.schedule({ count: 3 }));
      assert.deepEqual(configs, [{ n: 0 }, { n: 1 }, { n: 2 }]);
      assert.deepEqual(end, { type: "done", id: end.id, count: 3 });
    });

    test("S2: an empty schedule", async () => {
      const runtime = await ready(entry);
      const { configs, end } = await runtime.collect(runtime.schedule({ count: 0 }));
      assert.deepEqual([configs, end.type, end.count], [[], "done", 0]);
    });

    test("S3: an exception after two analyses is a taskError", async () => {
      const runtime = await ready(entry);
      const { configs, end } = await runtime.collect(runtime.schedule({ count: 5, failAt: 2 }));
      assert.equal(configs.length, 2);
      assert.equal(end.error.type, "taskError");
      assert.match(end.error.message, /failed at 2/);
    });

    test("S4: Fatal before the first analysis", async () => {
      const runtime = await ready(entry);
      const { configs, end } = await runtime.collect(runtime.schedule({ count: 5, fatalAt: 0 }));
      assert.deepEqual([configs.length, end.error.type], [0, "fatal"]);
    });

    test("an invalid scan config is a validation error", async () => {
      const runtime = await ready(entry);
      const { end } = await runtime.collect(runtime.schedule({ count: "3" }));
      assert.equal(end.error.type, "validation");
      assert.equal(end.error.details.issues[0].path, "/count");
    });

    test("S5: pipe backpressure blocks the generator; cancel is still received", async () => {
      const runtime = await ready(entry);
      const id = runtime.schedule({ count: 100_000 });
      await runtime.next("analysis");
      runtime.pauseReading();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runtime.resumeReading();
      runtime.pauseReading();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runtime.resumeReading();
      const { configs, end } = await runtime.collect(id);
      assert.equal(end.type, "done");
      assert.equal(end.count, 100_000);
      assert.equal(configs.length, 100_000 - 1);
      assert.deepEqual(configs.at(-1), { n: 99_999 });

      const cancelled = runtime.schedule({ count: 1_000_000 });
      await runtime.next("analysis");
      runtime.pauseReading();
      await new Promise((resolve) => setTimeout(resolve, 300));
      runtime.send({ type: "cancel", id: cancelled, reason: "stop" });
      runtime.resumeReading();
      const result = await runtime.collect(cancelled);
      assert.deepEqual(result.end.error, { type: "cancelled", message: "cancelled: stop" });
      // Without backpressure the generator would have produced everything before the cancel was read.
      assert.ok(result.configs.length < 1_000_000 - 1);
    });
  });
}

describe("schedule (shapes and misuse)", () => {
  test("a function returning an array (or a promised array) is a schedule", async () => {
    const runtime = await ready("schedule-misuse.ts");
    const array = await runtime.collect(runtime.schedule({ mode: "array" }));
    assert.deepEqual([array.configs, array.end.count], [[{ n: 1 }, { n: 2 }], 2]);
    const promised = await runtime.collect(runtime.schedule({ mode: "promisedArray" }));
    assert.deepEqual([promised.configs, promised.end.count], [[{ n: 1 }], 1]);
  });

  test("a schedule that returns no iterable is a validation error", async () => {
    const runtime = await ready("schedule-misuse.ts");
    const { end } = await runtime.collect(runtime.schedule({ mode: "notIterable" }));
    assert.equal(end.error.type, "validation");
  });

  test("an invalid or non-JSON analysis config fails the schedule with validation", async () => {
    const runtime = await ready("schedule-misuse.ts");
    const invalid = await runtime.collect(runtime.schedule({ mode: "invalidItem" }));
    assert.equal(invalid.configs.length, 1);
    assert.equal(invalid.end.error.type, "validation");
    assert.match(invalid.end.error.message, /analysis config #1 is invalid/);
    assert.equal(invalid.end.error.details.issues[0].path, "/n");
    const nonJson = await runtime.collect(runtime.schedule({ mode: "nonJson" }));
    assert.equal(nonJson.end.error.type, "validation");
    assert.equal(nonJson.end.error.details.issues[0].path, "/extra");
  });

  test("a task without schedule streams template single when asked to schedule", async () => {
    const runtime = await ready("echo.ts");
    const id = runtime.schedule({});
    const template = await runtime.next("template");
    assert.deepEqual([template.parent, template.template, template.scanConfig], [id, "single", {}]);
    runtime.send({ type: "templateItem", id: template.id, config: {} });
    runtime.send({ type: "templateDone", id: template.id, count: 1 });
    const { configs, end } = await runtime.collect(id);
    assert.deepEqual(configs, [{ name: "world", mode: "ok", sleepMs: 0, bytes: 0 }]);
    assert.equal(end.count, 1);
  });
});
