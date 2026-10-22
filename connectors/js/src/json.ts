import type { JsonObject, JsonValue } from "./protocol.ts";

/** A value that cannot travel as JSON; `path` is an RFC 6901 pointer into the converted value. */
export class JsonConversionError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "JsonConversionError";
    this.path = path;
  }
}

export function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "object" && value !== null) return value.constructor?.name ?? "object";
  return typeof value;
}

/**
 * Converts a value into plain JSON or throws: non-finite numbers, bigints, binary data, maps, sets,
 * functions and class instances without `toJSON` are not silently mangled the way JSON.stringify would.
 * Object properties that are `undefined` are dropped, as in JSON.
 */
export function toJsonValue(value: unknown, path = ""): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JsonConversionError(path, `${value} is not representable in JSON`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => {
      if (item === undefined) throw new JsonConversionError(`${path}/${index}`, "undefined is not representable in JSON");
      return toJsonValue(item, `${path}/${index}`);
    });
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") return toJsonValue(toJSON.call(value), path);
      throw new JsonConversionError(path, `${describeValue(value)} is not representable in JSON`);
    }
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = toJsonValue(item, `${path}/${pointerSegment(key)}`);
    }
    return out;
  }
  throw new JsonConversionError(path, `${describeValue(value)} is not representable in JSON`);
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new JsonConversionError("", "the value must be a JSON object");
  }
  return json;
}

/** Best-effort JSON for diagnostics (log fields): never throws, replaces what JSON cannot carry. */
export function toLenientJson(value: unknown): JsonObject {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (typeof item === "function" || typeof item === "symbol") return undefined;
    if (item instanceof Error) return { name: item.name, message: item.message };
    if (item instanceof Map) return Object.fromEntries(item);
    if (item instanceof Set) return [...item];
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
  const parsed: unknown = text === undefined ? {} : JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: parsed as JsonValue };
  return parsed as JsonObject;
}

/**
 * Keeps the head of `text`. JavaScript stacks list the innermost frame first, so the head is also the
 * useful part of a stack trace. Lengths are UTF-16 units, never fewer than the code points schemas count.
 */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
