import { redactText, redactValue } from './redact'

// Structured logging (docs/deployment.md §13.2): JSON lines (or text) on stdout with `time`, `level`, `msg`,
// `component` and correlation ids (`requestId`, `userId`, `scanId`, `workerId`, `nodeId`, `jobId`, `taskId`,
// `revisionId`). Every message and field is redacted (security.md MC-10). Child loggers carry fields.

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

const LEVEL_ORDER: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40 }

interface LoggerSettings {
  level: LogLevelName
  format: 'json' | 'text'
  write: (line: string) => void
}

const settings: LoggerSettings = {
  level: 'info',
  format: 'json',
  write: (line) => process.stdout.write(`${line}\n`),
}

/** Applies SCANTOR_LOG_LEVEL / SCANTOR_LOG_FORMAT once the configuration is parsed (boot step 1). */
export function configureLogger(options: Partial<LoggerSettings>): void {
  Object.assign(settings, options)
}

function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = { error: error.message, errorName: error.name }
    if (error.stack) fields.stack = error.stack
    const code = (error as { code?: unknown }).code
    if (code !== undefined) fields.errorCode = code
    return fields
  }
  return { error: String(error) }
}

function render(level: LogLevelName, msg: string, fields: LogFields, redactMessage = true): string {
  const entry: LogFields = { time: new Date().toISOString(), level, msg: redactMessage ? redactText(msg) : msg }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (key === 'err') Object.assign(entry, redactValue(serializeError(value)) as LogFields)
    else entry[key] = redactValue(value)
  }
  if (settings.format === 'json') return JSON.stringify(entry)
  const { time, level: lvl, msg: text, ...rest } = entry
  const extras = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return `${time} ${String(lvl).toUpperCase().padEnd(5)} ${text}${extras ? ` ${extras}` : ''}`
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /**
   * A warning whose message is not redacted (fields still are). Reserved for the setup link of docs/auth.md §7.2:
   * the operator copies the one-time setup token from the log, so that line must show it.
   */
  warnUnredacted(msg: string, fields?: LogFields): void
  /** A logger whose entries always carry `fields` (for example `{component: 'jobs'}`). */
  child(fields: LogFields): Logger
}

function createLogger(base: LogFields): Logger {
  const emit = (level: LogLevelName, msg: string, fields?: LogFields, redactMessage = true) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[settings.level]) return
    settings.write(render(level, msg, { ...base, ...fields }, redactMessage))
  }
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    warnUnredacted: (msg, fields) => emit('warn', msg, fields, false),
    child: (fields) => createLogger({ ...base, ...fields }),
  }
}

const root = createLogger({})

/** The root logger, or a child carrying `component` (and further fields). */
export function useLogger(component?: string, fields?: LogFields): Logger {
  return component || fields ? root.child({ ...(component ? { component } : {}), ...fields }) : root
}
