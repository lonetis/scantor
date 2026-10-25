import { z } from "zod";
import type { JsonObject } from "./protocol.ts";

/** The zod instance task code must use: schemas of another zod copy are rejected by `defineTask`. */
export { z };

/** A closed object schema: config roots must reject unknown keys (docs/tasks.md §6.2). */
export type ConfigSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;

/** A config object schema that rejects unknown keys (`z.strictObject`). */
export function config<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape, z.core.$strict> {
  return z.strictObject(shape);
}

/** The closed config type without fields; the default task, scan and analysis config. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- zod's shape of an object without fields
export const Empty: z.ZodObject<{}, z.core.$strict> = z.strictObject({});
export type Empty = z.output<typeof Empty>;

/** A secret string (`writeOnly`): encrypted at rest and masked as "***" in every API response. */
export function secret(): z.ZodString {
  return z.string().meta({ writeOnly: true });
}

/** A file reference returned by `ctx.files.put`; results embed it and the UI renders a download link. */
export const FileRef = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    size: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentType: z.string().min(1).max(255),
  })
  .meta({ "x-scantor": "file" });
export type FileRef = z.output<typeof FileRef>;

const connectorConstructors = new Set<unknown>(
  Object.values(z).filter((value) => typeof value === "function" && Object.hasOwn(value, "init")),
);

/**
 * True when `value` was built by this connector's zod. zod's own `instanceof` matches schemas of any zod
 * copy by trait name, so the constructor that built the schema is compared instead.
 */
export function isConnectorSchema(value: unknown): value is z.ZodType {
  if (typeof value !== "object" || value === null) return false;
  const internals = (value as { _zod?: { constr?: unknown } })._zod;
  return internals !== undefined && connectorConstructors.has(internals.constr);
}

/** True for an object schema whose unknown keys fail validation (`z.strictObject`, `config()`). */
export function isClosedObject(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const catchall = schema.def.catchall;
  return catchall !== undefined && catchall instanceof z.ZodNever;
}

export type SchemaMode = "input" | "output";

type OverrideContext = { zodSchema: z.core.$ZodType; jsonSchema: z.core.JSONSchema.BaseSchema };

/** Integer literal unions (`z.literal([4, 6])`) are integers, as in the canonical template schemas. */
function integerLiterals(ctx: OverrideContext): void {
  const def = ctx.zodSchema._zod.def;
  if (def.type !== "literal") return;
  const values = (def as z.core.$ZodLiteralDef<z.core.util.Literal>).values;
  if (values.length > 0 && values.every((value) => typeof value === "number" && Number.isInteger(value))) {
    ctx.jsonSchema.type = "integer";
  }
}

/** The formats every platform validator asserts (docs/tasks.md §6.4). */
const ASSERTED_FORMATS: ReadonlySet<string> = new Set([
  "date", "date-time", "time", "duration", "email", "hostname", "ipv4", "ipv6", "uri", "uuid", "regex",
]);

/**
 * Drops the regex zod emits next to an asserted format (`z.email()`, `z.uuid()`, `z.iso.duration()`, …):
 * the format already carries the rule, and some of these regexes use lookaheads, which the RE2-based
 * validator of the Go runtime cannot compile. Patterns the task adds with `.regex()` are kept.
 */
function formatPatterns(ctx: OverrideContext): void {
  const json = ctx.jsonSchema;
  if (typeof json.format !== "string" || !ASSERTED_FORMATS.has(json.format)) return;
  const internals = ctx.zodSchema._zod;
  const checks = [internals.traits.has("$ZodCheck") ? ctx.zodSchema : undefined, ...(internals.def.checks ?? [])];
  const derived = new Set<string>();
  for (const check of checks) {
    const def = check?._zod.def as { check?: string; pattern?: unknown } | undefined;
    if (def?.check === "string_format" && def.pattern instanceof RegExp) derived.add(def.pattern.source);
  }
  if (typeof json.pattern === "string" && derived.has(json.pattern)) delete json.pattern;
  if (Array.isArray(json.allOf)) {
    const kept = json.allOf.filter((member) => typeof member !== "object" || !derived.has(String(member.pattern)));
    if (kept.length === json.allOf.length) return;
    delete json.allOf;
    if (kept.length === 1 && typeof kept[0] === "object" && Object.keys(kept[0]).join() === "pattern") json.pattern = kept[0].pattern;
    else if (kept.length > 0) json.allOf = kept;
  }
}

function overrides(ctx: OverrideContext): void {
  integerLiterals(ctx);
  formatPatterns(ctx);
}

/** Keywords that also constrain `null`, so a nullable union containing them cannot become a type array. */
const UNIVERSAL_KEYWORDS = ["enum", "const", "$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"];

function isNullSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).join() === "type" && (value as JsonObject).type === "null";
}

/**
 * Rewrites zod's nullable unions `anyOf: [X, {type: "null"}]` as `type: [X.type, "null"]` with X's
 * keywords, the form of the canonical template schemas. Equivalent because X's remaining keywords apply
 * only to values of its own type; unions with enum, const, references or combinators keep their anyOf.
 */
function collapseNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(collapseNullable);
  if (typeof node !== "object" || node === null) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) out[key] = collapseNullable(value) as JsonObject[string];
  const members = out.anyOf;
  if (!Array.isArray(members) || members.length !== 2 || !isNullSchema(members[1])) return out;
  const inner = members[0];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner) || typeof inner.type !== "string") return out;
  if (UNIVERSAL_KEYWORDS.some((keyword) => keyword in inner)) return out;
  const { anyOf: _anyOf, ...annotations } = out;
  return { ...inner, ...annotations, type: [inner.type, "null"] };
}

/** JSON Schema draft 2020-12 of a schema; configs use input mode, results output mode (docs/tasks.md §6.1). */
export function exportJsonSchema(schema: z.ZodType, mode: SchemaMode): JsonObject {
  const json = z.toJSONSchema(schema, {
    io: mode,
    target: "draft-2020-12",
    unrepresentable: "throw",
    override: overrides,
  });
  return collapseNullable(json) as JsonObject;
}
