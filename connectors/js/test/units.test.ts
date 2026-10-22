import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { config, Empty, Fatal, FileRef, Retry, ScantorError, secret, z } from "@scantor/connector";
import { normalize } from "../src/check.ts";
import { toWireError } from "../src/errors.ts";
import { JsonConversionError, toJsonValue } from "../src/json.ts";
import { exportJsonSchema, isClosedObject, isConnectorSchema } from "../src/schema.ts";

describe("errors", () => {
  test("classification of thrown values", () => {
    assert.deepEqual(toWireError(new Retry("later", 1499.6)), { type: "retry", message: "later", delayMs: 1500 });
    assert.equal(toWireError(new Fatal("no")).type, "fatal");
    assert.equal(toWireError(new ScantorError("validation", "bad file")).type, "validation");
    assert.deepEqual(
      [toWireError(new ScantorError("platform", "upstream", true)).type, toWireError(new ScantorError("platform", "upstream")).message],
      ["taskError", "upstream"],
    );
    assert.equal(toWireError(new TypeError("x is not a function")).message, "TypeError: x is not a function");
    assert.equal(toWireError(new Error("plain")).message, "plain");
    assert.deepEqual(toWireError("a string"), { type: "taskError", message: "non-error value thrown: a string" });
    assert.ok(toWireError(new Error("x".repeat(10_000))).message.length <= 4096);
  });

  test("a propagated zod error is a validation error with issues", () => {
    const parsed = config({ n: z.number() }).safeParse({ n: "1" });
    assert.ok(!parsed.success);
    const error = toWireError(parsed.error);
    assert.equal(error.type, "validation");
    assert.deepEqual((error.details as { issues: { path: string }[] }).issues.map((issue) => issue.path), ["/n"]);
  });

  test("Retry rejects negative delays", () => {
    assert.throws(() => new Retry("x", -1), RangeError);
  });
});

describe("json", () => {
  test("plain JSON passes, toJSON is honoured, undefined properties are dropped", () => {
    assert.deepEqual(toJsonValue({ a: [1, "b", null, true], d: new Date(0), u: undefined }), {
      a: [1, "b", null, true],
      d: "1970-01-01T00:00:00.000Z",
    });
  });

  test("values JSON cannot carry are rejected with their path", () => {
    for (const [value, path] of [
      [{ a: Number.NaN }, "/a"],
      [{ "a/b": [1n] }, "/a~1b/0"],
      [new Uint8Array(2), ""],
      [{ s: new Set([1]) }, "/s"],
      [[() => 1], "/0"],
    ] as const) {
      assert.throws(() => toJsonValue(value), (error: unknown) => error instanceof JsonConversionError && error.path === path);
    }
  });
});

describe("schemas", () => {
  test("config() and Empty are closed; z.object is not", () => {
    assert.ok(isClosedObject(config({ a: z.string() })));
    assert.ok(isClosedObject(Empty));
    assert.ok(!isClosedObject(z.object({ a: z.string() })));
    assert.ok(isConnectorSchema(Empty));
    assert.ok(!isConnectorSchema({ _zod: {} }));
  });

  test("secret() is writeOnly and FileRef carries x-scantor file", () => {
    const schema = exportJsonSchema(config({ token: secret().default("") }), "input");
    assert.deepEqual((schema.properties as Record<string, unknown>).token, { default: "", type: "string", writeOnly: true });
    const result = exportJsonSchema(z.object({ shot: FileRef.nullable() }), "output");
    const shot = (result.properties as Record<string, Record<string, unknown>>).shot!;
    assert.deepEqual(shot.type, ["object", "null"]);
    assert.equal(shot["x-scantor"], "file");
    assert.equal(shot.additionalProperties, false);
  });

  test("nullable unions become type arrays unless null would change their meaning", () => {
    const schema = exportJsonSchema(
      config({
        limit: z.number().int().min(1).nullable().default(null).describe("cap"),
        mode: z.enum(["a", "b"]).nullable().default(null),
      }),
      "input",
    );
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.limit, {
      type: ["integer", "null"],
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      default: null,
      description: "cap",
    });
    assert.deepEqual(properties.mode, { default: null, anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] });
  });

  test("asserted formats drop zod's implementation regex; patterns of the task stay", () => {
    const schema = exportJsonSchema(
      config({ mail: z.email(), host: z.hostname(), id: z.guid(), code: z.string().regex(/^[A-Z]{3}$/), cuid: z.cuid() }),
      "input",
    );
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.mail, { type: "string", format: "email" });
    assert.deepEqual(properties.host, { type: "string", format: "hostname" });
    assert.deepEqual(properties.id, { type: "string", format: "uuid" });
    assert.deepEqual(properties.code, { type: "string", pattern: "^[A-Z]{3}$" });
    assert.equal(properties.cuid!.pattern, "^[cC][0-9a-z]{6,}$", "formats the platform does not assert keep their regex");
  });

  test("input mode omits defaulted fields from required, output mode keeps them", () => {
    const schema = config({ a: z.number().default(1), b: z.string() });
    assert.deepEqual(exportJsonSchema(schema, "input").required, ["b"]);
    assert.deepEqual(exportJsonSchema(schema, "output").required, ["a", "b"]);
  });

  test("integer literal unions export as integer enums", () => {
    const schema = exportJsonSchema(config({ v: z.literal([4, 6]) }), "input");
    assert.deepEqual((schema.properties as Record<string, unknown>).v, { type: "integer", enum: [4, 6] });
  });
});

describe("check output", () => {
  test("tsc diagnostics become one line each; other output passes through", () => {
    const output = [
      "main.ts(14,12): error TS2322: Type 'number' is not assignable to type 'string'.",
      "main.ts(20,3): error TS2345: Argument of type '{ a: number; }' is not assignable to parameter of type 'X'.",
      "  Object literal may only specify known properties.",
      "error TS5083: Cannot read file '/task/tsconfig.json'.",
      "Found 3 errors.",
      "",
    ].join("\n");
    assert.deepEqual(normalize(output, "tsconfig.json"), [
      "main.ts:14:12: TS2322: Type 'number' is not assignable to type 'string'.",
      "main.ts:20:3: TS2345: Argument of type '{ a: number; }' is not assignable to parameter of type 'X'. Object literal may only specify known properties.",
      "tsconfig.json:1: TS5083: Cannot read file '/task/tsconfig.json'.",
      "Found 3 errors.",
    ]);
  });
});
