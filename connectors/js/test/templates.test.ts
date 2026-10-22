import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { FakeRuntime, type Message } from "./helpers/runtime.ts";
import { readJson, TEMPLATE_NAMES, type TemplateFixtures } from "./helpers/schemas.ts";

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

const range = (count: number): Message[] => Array.from({ length: count }, (_, value) => ({ value }));

describe("wrapped template streams", () => {
  test("T1: credit flow control delivers 1000 items without exceeding the allowance", async () => {
    const runtime = await ready("template-wrapped.ts");
    const id = runtime.schedule({ end: 1000 });
    const [report, { configs, end }] = await Promise.all([runtime.serveTemplate(range(1000)), runtime.collect(id)]);
    assert.equal(report.request.parent, id);
    assert.equal(report.request.template, "range");
    assert.deepEqual(report.request.scanConfig, { start: 0, end: 1000, step: 1 });
    assert.equal(report.request.credit, 256);
    assert.ok(report.maxAllowance <= 256 + 128, "credit is granted as items are consumed");
    assert.equal(configs.length, 1000);
    assert.deepEqual(configs.slice(0, 3), [{ n: 0 }, { n: 2 }, { n: 4 }]);
    assert.deepEqual(end, { type: "done", id, count: 1000 });
  });

  test("T2: stopping early cancels the stream and waits for templateDone before done", async () => {
    const runtime = await ready("template-wrapped.ts");
    const id = runtime.schedule({ end: 1000, stopAfter: 5 });
    const collected = runtime.collect(id);
    const report = await runtime.serveTemplate(range(1000), { doneDelayMs: 300 });
    assert.equal(report.cancelled, true);
    const doneIndex = runtime.received.findIndex((message) => message.type === "done" && message.id === id);
    assert.equal(doneIndex, -1, "done is not sent before templateDone");
    const { configs, end } = await collected;
    assert.equal(configs.length, 5);
    assert.deepEqual(end, { type: "done", id, count: 5 });
  });

  test("T3: runtime errors surface as ScantorError; platform becomes taskError", async () => {
    const runtime = await ready("template-wrapped.ts");
    const first = runtime.schedule({ end: 10 });
    const request = await runtime.next("template");
    runtime.send({ type: "error", id: request.id, error: { type: "platform", message: "download failed", retryable: true } });
    const platform = await runtime.collect(first);
    assert.equal(platform.end.error.type, "taskError");
    assert.match(platform.end.error.message, /download failed/);

    const second = runtime.schedule({ end: 10 });
    const again = await runtime.next("template");
    runtime.send({ type: "error", id: again.id, error: { type: "validation", message: "bad config", retryable: false } });
    const validation = await runtime.collect(second);
    assert.deepEqual([validation.end.error.type, validation.end.error.message], ["validation", "bad config"]);
  });

  test("items delivered before an error are consumed first", async () => {
    const runtime = await ready("template-wrapped.ts");
    const id = runtime.schedule({ end: 10 });
    const request = await runtime.next("template");
    for (const item of range(3)) runtime.send({ type: "templateItem", id: request.id, config: item });
    runtime.send({ type: "error", id: request.id, error: { type: "platform", message: "upstream 503", retryable: true } });
    const { configs, end } = await runtime.collect(id);
    assert.equal(configs.length, 3);
    assert.equal(end.error.type, "taskError");
  });

  test("cancelling the schedule ends open streams implicitly", async () => {
    const runtime = await ready("template-wrapped.ts");
    const id = runtime.schedule({ end: 10 });
    await runtime.next("template");
    runtime.send({ type: "cancel", id, reason: "drain" });
    const { end } = await runtime.collect(id);
    assert.deepEqual(end.error, { type: "cancelled", message: "cancelled: drain" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(runtime.received.every((message) => message.type !== "templateCancel"));
  });
});

describe("template models (T4)", () => {
  for (const name of TEMPLATE_NAMES) {
    test(name, async () => {
      const fixtures = readJson<TemplateFixtures>(`templates/${name}.fixtures.json`);
      const runtime = await ready("template-models.ts");

      for (const valid of fixtures.scanConfig.valid) {
        const id = runtime.schedule({ template: name, config: valid.input });
        const request = await runtime.next("template");
        assert.deepEqual(request.scanConfig, valid.effective, `${name}: ${valid.name}`);
        runtime.send({ type: "templateDone", id: request.id, count: 0 });
        assert.equal((await runtime.reply(id)).type, "done");
      }

      for (const invalid of fixtures.scanConfig.invalid) {
        const id = runtime.schedule({ template: name, config: invalid.input });
        if (invalid.kind === "semantic") {
          const request = await runtime.next("template");
          runtime.send({ type: "error", id: request.id, error: { type: "validation", message: `${invalid.path}: rejected`, retryable: false } });
        }
        const reply = await runtime.reply(id);
        assert.equal(reply.type, "error", `${name}: ${invalid.name}`);
        assert.equal(reply.error.type, "validation", `${name}: ${invalid.name}`);
      }

      for (const valid of fixtures.analysisConfig.valid) {
        const reply = await runtime.reply(runtime.run({ template: name, config: valid.input }));
        assert.equal(reply.type, "result", `${name}: ${valid.name}`);
        assert.deepEqual(reply.result.config, valid.input);
      }

      for (const invalid of fixtures.analysisConfig.invalid) {
        const reply = await runtime.reply(runtime.run({ template: name, config: invalid.input }));
        assert.equal(reply.error?.type, "validation", `${name}: ${invalid.name}`);
      }
      assert.ok(runtime.received.every((message) => message.type !== "template" || message.template === name));
    });
  }
});
