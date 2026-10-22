import { z } from "zod";
import { pointerSegment, truncate } from "./json.ts";
import {
  MAX_ERROR_DETAILS_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_ERROR_STACK_CHARS,
  type ErrorType,
  type JsonObject,
  type WireError,
} from "./protocol.ts";

/** A permanent failure: the analysis (or the scheduling) fails now, without further attempts. */
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fatal";
  }
}

/**
 * A transient failure: the next attempt starts after `delayMs` (default: the scan's backoff), clamped by
 * the platform to [1 s, backoff max]. Counts toward `maxAttempts`.
 */
export class Retry extends Error {
  readonly delayMs: number | undefined;

  constructor(message: string, delayMs?: number) {
    super(message);
    this.name = "Retry";
    if (delayMs !== undefined && !(Number.isFinite(delayMs) && delayMs >= 0)) {
      throw new RangeError(`Retry delay must be a non-negative number of milliseconds, got ${delayMs}`);
    }
    this.delayMs = delayMs === undefined ? undefined : Math.round(delayMs);
  }
}

export interface Issue {
  path: string;
  message: string;
}

/** An error raised by the platform: `ctx.files.put` or a template stream. */
export class ScantorError extends Error {
  readonly type: string;
  readonly retryable: boolean;
  readonly issues: readonly Issue[];

  constructor(type: string, message: string, retryable = false, issues: readonly Issue[] = []) {
    super(message);
    this.name = "ScantorError";
    this.type = type;
    this.retryable = retryable;
    this.issues = issues;
  }
}

/** An invalid task definition, raised by `defineTask` at import time. */
export class TaskDefinitionError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "TaskDefinitionError";
  }
}

/** Issues of a zod error with RFC 6901 paths. */
export function toIssues(error: z.core.$ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => `/${pointerSegment(typeof segment === "symbol" ? String(segment) : segment)}`).join(""),
    message: issue.message,
  }));
}

const MAX_ISSUES = 20;
const MAX_ISSUE_MESSAGE_CHARS = 300;

export function issuesDetails(issues: readonly Issue[]): JsonObject {
  const kept: JsonObject[] = [];
  let bytes = 32;
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const entry = { path: truncate(issue.path, 256), message: truncate(issue.message, MAX_ISSUE_MESSAGE_CHARS) };
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > MAX_ERROR_DETAILS_BYTES) break;
    kept.push(entry);
  }
  return { issues: kept };
}

function messageOf(error: Error): string {
  return error.name === "Error" || error.message.startsWith(`${error.name}:`) ? error.message : `${error.name}: ${error.message}`;
}

export function validationError(message: string, issues: readonly Issue[] = []): WireError {
  const error: WireError = { type: "validation", message: truncate(message, MAX_ERROR_MESSAGE_CHARS) };
  if (issues.length > 0) error.details = issuesDetails(issues);
  return error;
}

/**
 * Classifies whatever user code threw into the wire error. Connectors may only report taskError, fatal,
 * retry, validation and cancelled (protocol §7.1); a re-raised platform error other than validation is a
 * taskError with the same message.
 */
export function toWireError(thrown: unknown): WireError {
  if (thrown instanceof Fatal) {
    return withStack({ type: "fatal", message: truncate(thrown.message, MAX_ERROR_MESSAGE_CHARS) }, thrown);
  }
  if (thrown instanceof Retry) {
    const error: WireError = { type: "retry", message: truncate(thrown.message, MAX_ERROR_MESSAGE_CHARS) };
    if (thrown.delayMs !== undefined) error.delayMs = thrown.delayMs;
    return error;
  }
  if (thrown instanceof z.core.$ZodError) {
    // A model validation error that user code let propagate, e.g. Template.ScanConfig.parse(...).
    const issues = toIssues(thrown);
    const summary = issues.map((issue) => `${issue.path || "/"}: ${issue.message}`).join("; ");
    return withStack(validationError(`validation failed: ${summary}`, issues), thrown);
  }
  if (thrown instanceof ScantorError) {
    const type: ErrorType = thrown.type === "validation" ? "validation" : "taskError";
    const error = withStack({ type, message: truncate(thrown.message, MAX_ERROR_MESSAGE_CHARS) }, thrown);
    if (thrown.issues.length > 0) error.details = issuesDetails(thrown.issues);
    return error;
  }
  if (thrown instanceof Error) {
    return withStack({ type: "taskError", message: truncate(messageOf(thrown), MAX_ERROR_MESSAGE_CHARS) }, thrown);
  }
  return { type: "taskError", message: truncate(`non-error value thrown: ${String(thrown)}`, MAX_ERROR_MESSAGE_CHARS) };
}

function withStack(error: WireError, thrown: Error): WireError {
  if (typeof thrown.stack === "string" && thrown.stack.length > 0) {
    error.stack = truncate(thrown.stack, MAX_ERROR_STACK_CHARS);
  }
  return error;
}
