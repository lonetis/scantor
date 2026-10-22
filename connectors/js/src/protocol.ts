// Wire types of the connector protocol (docs/protocol.md, schemas/protocol/*.schema.json).

export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

/** Fixed v1 line limit; also the fallback before `welcome` arrives. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Bounds of the protocol schemas; longer values would fail them. */
export const MAX_ERROR_MESSAGE_CHARS = 4096;
export const MAX_ERROR_STACK_CHARS = 16384;
export const MAX_ERROR_DETAILS_BYTES = 4096;
export const MAX_LOG_MESSAGE_CHARS = 16384;
export const MAX_LOG_FIELDS_BYTES = 16384;
export const MAX_PROGRESS_MESSAGE_CHARS = 256;
export const MAX_WARNINGS = 100;
export const MAX_WARNING_CHARS = 1000;

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type ErrorType = "taskError" | "fatal" | "retry" | "timeout" | "crash" | "validation" | "platform" | "cancelled";

export interface WireError {
  type: ErrorType;
  message: string;
  retryable?: boolean;
  delayMs?: number;
  stack?: string;
  details?: JsonObject;
}

export interface WireContext {
  scanId: string;
  analysisId: string | null;
  seq: number | null;
  round: number | null;
  attempt: number;
  executionId: string | null;
  deadlineMs: number | null;
  tmpDir: string;
  filesDir: string | null;
}

export interface Limits {
  maxLineBytes: number;
  maxResultBytes: number;
  maxAnalysisConfigBytes: number;
  maxFileBytes: number;
  maxFilesPerAnalysis: number;
}

export interface WireFileRef {
  id: string;
  name: string;
  size: number;
  sha256: string;
  contentType: string;
}

export type ScheduleKind = { kind: "custom" } | { kind: "template"; template: string };

export interface DescribedSchemas {
  taskConfig: JsonObject;
  scanConfig: JsonObject;
  analysisConfig: JsonObject;
  result: JsonObject;
}

// Runtime → connector.

export interface WelcomeMessage {
  type: "welcome";
  id: "hello";
  protocolVersion: number;
  mode: "worker" | "local" | "describe";
  runtime: { version: string };
  limits: Limits;
  cancelGraceMs: number;
}

export interface DescribeMessage {
  type: "describe";
  id: string;
}

export interface ScheduleMessage {
  type: "schedule";
  id: string;
  ctx: WireContext;
  scanConfig: JsonObject;
  taskConfig: JsonObject;
}

export interface RunMessage {
  type: "run";
  id: string;
  ctx: WireContext;
  analysisConfig: JsonObject;
  taskConfig: JsonObject;
}

export interface CancelMessage {
  type: "cancel";
  id: string;
  reason: "drain" | "stop";
}

export interface ShutdownMessage {
  type: "shutdown";
  id: string;
  graceMs: number;
}

export interface FileRefMessage {
  type: "fileRef";
  id: string;
  fileRef: WireFileRef;
}

export interface TemplateItemMessage {
  type: "templateItem";
  id: string;
  config: JsonObject;
}

export interface TemplateDoneMessage {
  type: "templateDone";
  id: string;
  count: number;
}

export interface ErrorMessage {
  type: "error";
  id: string;
  error: WireError;
}

// Connector → runtime.

export interface HelloMessage {
  type: "hello";
  id: "hello";
  protocol: { min: number; max: number };
  connector: { language: "typescript" | "javascript"; version: string; runtime?: string };
  pid: number;
}

export interface ReadyMessage {
  type: "ready";
  id: "hello";
}

export interface DescriptionMessage {
  type: "description";
  id: string;
  schemas: DescribedSchemas;
  schedule: ScheduleKind;
  warnings: string[];
}

export interface AnalysisMessage {
  type: "analysis";
  id: string;
  config: JsonObject;
}

export interface DoneMessage {
  type: "done";
  id: string;
  count: number;
}

export interface ResultMessage {
  type: "result";
  id: string;
  result: JsonObject;
}

export interface FileMessage {
  type: "file";
  id: string;
  parent: string;
  name: string;
  path: string;
  contentType: string | null;
}

export interface LogMessage {
  type: "log";
  parent: string | null;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  fields?: JsonObject;
}

export interface ProgressMessage {
  type: "progress";
  parent: string;
  fraction: number | null;
  message: string | null;
}

export interface TemplateMessage {
  type: "template";
  id: string;
  parent: string;
  template: string;
  scanConfig: JsonObject;
  credit: number;
}

export interface TemplateCreditMessage {
  type: "templateCredit";
  id: string;
  credit: number;
}

export interface TemplateCancelMessage {
  type: "templateCancel";
  id: string;
}

export type OutgoingMessage =
  | HelloMessage
  | ReadyMessage
  | DescriptionMessage
  | AnalysisMessage
  | DoneMessage
  | ResultMessage
  | ErrorMessage
  | FileMessage
  | LogMessage
  | ProgressMessage
  | TemplateMessage
  | TemplateCreditMessage
  | TemplateCancelMessage;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}
