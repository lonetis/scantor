import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { FakeRuntime, type Message } from "./helpers/runtime.ts";
import { readJson, TEMPLATE_NAMES } from "./helpers/schemas.ts";

const runtimes: FakeRuntime[] = [];

async function describeTask(entry: string): Promise<Message> {
  const runtime = await FakeRuntime.ready(entry, { mode: "describe" });
  runtimes.push(runtime);
  runtime.send({ type: "describe", id: "d1" });
  return runtime.reply("d1");
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
});

type Schema = Record<string, any>;

function withoutAnnotations(schema: Schema): Schema {
  const { $schema: _schema, title: _title, description: _description, ...rest } = schema;
  return rest;
}

/** The canonical schema as the connector exports it: root annotations aside, every keyword must match. */
function assertCanonical(actual: Schema, canonical: Schema, label: string): void {
  assert.deepEqual(withoutAnnotations(actual), withoutAnnotations(canonical), label);
}

describe("describe", () => {
  test("D1: echo exports closed input-mode configs, a secret and FileRefs in output mode", async () => {
    const description = await describeTask("echo.ts");
    assert.equal(description.type, "description");
    const { taskConfig, analysisConfig, result } = description.schemas;
    assert.equal(taskConfig.additionalProperties, false);
    assert.equal(taskConfig.properties.greeting.default, "Hello");
    assert.ok(!(taskConfig.required ?? []).includes("greeting"));
    assert.equal(taskConfig.properties.apiToken.writeOnly, true);
    assert.equal(analysisConfig.additionalProperties, false);
    assert.deepEqual(Object.keys(analysisConfig.properties).sort(), ["bytes", "mode", "name", "sleepMs"]);
    assert.equal(result.type, "object");
    assert.equal(result.properties.files.items["x-scantor"], "file");
    assert.deepEqual(result.properties.files.items.required.sort(), ["contentType", "id", "name", "sha256", "size"]);
    assert.deepEqual(description.schedule, { kind: "template", template: "single" });
    assert.deepEqual(description.warnings, []);
  });

  test("D2: minimal defaults every config to Empty", async () => {
    const description = await describeTask("minimal.ts");
    const empty = { type: "object", properties: {}, additionalProperties: false };
    for (const field of ["taskConfig", "scanConfig", "analysisConfig"]) {
      assert.deepEqual(withoutAnnotations(description.schemas[field]), empty, field);
    }
    assert.deepEqual(description.schedule, { kind: "template", template: "single" });
  });

  test("D3: a generator is a custom schedule", async () => {
    assert.deepEqual((await describeTask("schedule.ts")).schedule, { kind: "custom" });
    assert.deepEqual((await describeTask("template-wrapped.ts")).schedule, { kind: "custom" });
  });

  test("D4: an unwrapped proxy names its template", async () => {
    const description = await describeTask("template-unwrapped.ts");
    assert.deepEqual(description.schedule, { kind: "template", template: "range" });
    assert.deepEqual(Object.keys(description.schemas.analysisConfig.properties), ["value"]);
  });

  for (const name of TEMPLATE_NAMES) {
    test(`D5: template ${name} exports exactly schemas/templates/${name}.json`, async () => {
      const description = await describeTask(`template-${name}.ts`);
      assert.deepEqual(description.schedule, { kind: "template", template: name });
      const canonical = readJson<Schema>(`templates/${name}.json`).$defs;
      assertCanonical(description.schemas.scanConfig, canonical.scanConfig, `${name} scanConfig`);
      assertCanonical(description.schemas.analysisConfig, canonical.analysisConfig, `${name} analysisConfig`);
    });
  }

  test("list marks its upload field", async () => {
    const description = await describeTask("template-list.ts");
    assert.equal(description.schemas.scanConfig.properties.upload["x-scantor"], "upload");
  });

  test("a result that JSON Schema cannot represent fails describe with validation", async () => {
    const description = await describeTask("unrepresentable.ts");
    assert.equal(description.type, "error");
    assert.equal(description.error.type, "validation");
    assert.match(description.error.message, /result cannot be represented as JSON Schema/);
  });

  test("without a schedule, an analysis config that rejects {} is a warning", async () => {
    const description = await describeTask("single-required.ts");
    assert.deepEqual(description.schedule, { kind: "template", template: "single" });
    assert.equal(description.warnings.length, 1);
    assert.match(description.warnings[0], /analysis config \{\}, which analysisConfig rejects/);
  });

  test("JavaScript entries describe like TypeScript ones", async () => {
    const description = await describeTask("minimal.js");
    assert.deepEqual(description.schemas.result.required, ["ok"]);
  });
});
