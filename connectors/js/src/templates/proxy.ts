import type { z } from "zod";
import { callOf, type Call, type Context, type TemplateSink } from "../context.ts";
import { ScantorError, toIssues } from "../errors.ts";
import { toJsonObject } from "../json.ts";
import type { JsonObject, WireError } from "../protocol.ts";
import type { ConfigSchema } from "../schema.ts";

/** Property that marks a template proxy; its value is the template name (docs/templates.md §3). */
export const TEMPLATE_MARKER: unique symbol = Symbol.for("scantor.template");

/** Recommended flow-control policy of docs/protocol.md §6.2. */
const INITIAL_CREDIT = 256;
const CREDIT_BATCH = 128;

/** A template as passed to `defineTask` unwrapped: its name and canonical config schemas. */
export interface TemplateRef<SC extends ConfigSchema = ConfigSchema, AC extends ConfigSchema = ConfigSchema> {
  readonly template: string;
  readonly ScanConfig: SC;
  readonly AnalysisConfig: AC;
}

/**
 * A template proxy. Passed as `schedule` unchanged it runs natively in the runtime (unwrapped); called
 * inside a custom schedule it streams the template's analysis configs from the runtime (wrapped). The
 * third parameter is accepted and ignored, so both uses share one signature.
 */
export interface TemplateSchedule<SC extends ConfigSchema, AC extends ConfigSchema> extends TemplateRef<SC, AC> {
  (ctx: Context, scanConfig?: z.input<SC>, taskConfig?: unknown): AsyncIterable<z.output<AC>>;
}

export function defineTemplate<SC extends ConfigSchema, AC extends ConfigSchema>(
  name: string,
  scanConfig: SC,
  analysisConfig: AC,
): TemplateSchedule<SC, AC> {
  const schedule = (ctx: Context, config?: z.input<SC>): AsyncIterable<z.output<AC>> => ({
    [Symbol.asyncIterator]: () => new TemplateStream<SC, AC>(name, scanConfig, analysisConfig, ctx, config ?? {}),
  });
  Object.defineProperties(schedule, {
    [TEMPLATE_MARKER]: { value: name },
    template: { value: name, enumerable: true },
    ScanConfig: { value: scanConfig, enumerable: true },
    AnalysisConfig: { value: analysisConfig, enumerable: true },
  });
  return schedule as TemplateSchedule<SC, AC>;
}

/** The template proxy `value` is, or undefined for any other value. */
export function templateOf(value: unknown): TemplateSchedule<ConfigSchema, ConfigSchema> | undefined {
  if (typeof value !== "function") return undefined;
  const marked = value as Partial<TemplateRef> & { [TEMPLATE_MARKER]?: unknown };
  if (typeof marked[TEMPLATE_MARKER] !== "string" || marked.ScanConfig === undefined || marked.AnalysisConfig === undefined) {
    return undefined;
  }
  return value as TemplateSchedule<ConfigSchema, ConfigSchema>;
}

type StreamState = "idle" | "open" | "finished";

/**
 * One wrapped template call: `template` request, credit-limited `templateItem`s, `templateDone`. Items are
 * parsed with the native AnalysisConfig model; credit is granted as user code consumes them.
 */
class TemplateStream<SC extends ConfigSchema, AC extends ConfigSchema> implements AsyncIterator<z.output<AC>>, TemplateSink {
  readonly #name: string;
  readonly #scanConfigSchema: SC;
  readonly #analysisConfigSchema: AC;
  readonly #ctx: Context;
  readonly #scanConfig: unknown;
  #state: StreamState = "idle";
  #call: Call | undefined;
  #id = "";
  #buffer: JsonObject[] = [];
  #error: WireError | undefined;
  #ended = false;
  #cancelled = false;
  #consumedSinceGrant = 0;
  #wake: (() => void) | undefined;

  constructor(name: string, scanConfigSchema: SC, analysisConfigSchema: AC, ctx: Context, scanConfig: unknown) {
    this.#name = name;
    this.#scanConfigSchema = scanConfigSchema;
    this.#analysisConfigSchema = analysisConfigSchema;
    this.#ctx = ctx;
    this.#scanConfig = scanConfig;
  }

  async next(): Promise<IteratorResult<z.output<AC>>> {
    if (this.#state === "idle") this.#open();
    for (;;) {
      if (this.#state === "finished") return { done: true, value: undefined };
      const config = this.#buffer.shift();
      if (config !== undefined) {
        this.#consumed();
        return { done: false, value: this.#parseItem(config) };
      }
      if (this.#error !== undefined) {
        const error = this.#error;
        this.#finish();
        throw new ScantorError(error.type, error.message, error.retryable ?? false);
      }
      if (this.#ended) {
        this.#finish();
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** Called when user code stops iterating early (`break`, `return`, an exception). */
  async return(): Promise<IteratorResult<z.output<AC>>> {
    if (this.#state === "open" && !this.#ended && this.#error === undefined) {
      this.#cancelled = true;
      this.#buffer = [];
      this.#call?.link.send({ type: "templateCancel", id: this.#id });
      while (!this.#ended && this.#error === undefined) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
    }
    this.#finish();
    return { done: true, value: undefined };
  }

  item(config: JsonObject): void {
    if (this.#cancelled || this.#state !== "open") return;
    this.#buffer.push(config);
    this.#notify();
  }

  done(): void {
    this.#ended = true;
    this.#notify();
  }

  fail(error: WireError): void {
    this.#error = error;
    this.#notify();
  }

  close(): void {
    this.#ended = true;
    this.#buffer = [];
    this.#notify();
  }

  #open(): void {
    const call = callOf(this.#ctx);
    if (call === undefined) {
      throw new ScantorError("validation", `${this.#name}.schedule() needs the ctx of the schedule call it runs in`);
    }
    if (call.kind !== "schedule") {
      throw new ScantorError("validation", `templates are only available in schedule, not in ${call.kind}`);
    }
    if (!call.active) throw new ScantorError("cancelled", `${this.#name}.schedule() after the schedule call ended`);

    const parsed = this.#scanConfigSchema.safeParse(this.#canonicalFields());
    if (!parsed.success) {
      throw new ScantorError("validation", `template ${this.#name}: scan config is invalid`, false, toIssues(parsed.error));
    }
    this.#call = call;
    this.#id = call.link.nextId();
    this.#state = "open";
    call.link.openTemplate(
      call,
      {
        type: "template",
        id: this.#id,
        parent: call.id,
        template: this.#name,
        scanConfig: toJsonObject(parsed.data),
        credit: INITIAL_CREDIT,
      },
      this,
    );
  }

  /** Only the template's own fields: a task's scan config may extend the template's. */
  #canonicalFields(): Record<string, unknown> {
    const source = this.#scanConfig;
    const fields: Record<string, unknown> = {};
    if (typeof source !== "object" || source === null) return fields;
    for (const key of Object.keys(this.#scanConfigSchema.shape)) {
      const value = (source as Record<string, unknown>)[key];
      if (value !== undefined) fields[key] = value;
    }
    return fields;
  }

  #parseItem(config: JsonObject): z.output<AC> {
    const parsed = this.#analysisConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new ScantorError("validation", `template ${this.#name}: analysis config is invalid`, false, toIssues(parsed.error));
    }
    return parsed.data;
  }

  #consumed(): void {
    this.#consumedSinceGrant++;
    if (this.#consumedSinceGrant < CREDIT_BATCH || this.#ended || this.#call === undefined) return;
    this.#consumedSinceGrant -= CREDIT_BATCH;
    this.#call.link.send({ type: "templateCredit", id: this.#id, credit: CREDIT_BATCH });
  }

  #finish(): void {
    if (this.#state === "open" && this.#call !== undefined) this.#call.link.closeTemplate(this.#id);
    this.#state = "finished";
    this.#buffer = [];
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
