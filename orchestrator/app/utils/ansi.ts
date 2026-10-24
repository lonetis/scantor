// Text from task code (logs, results, error and event messages) is rendered as plain text: escape sequences and
// control characters are removed (docs/security.md HDR-5).

// eslint-disable-next-line no-control-regex
const OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g
// eslint-disable-next-line no-control-regex
const CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\u001B[ -/]*[0-~]?/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Removes ANSI/VT escape sequences and control characters, keeping `\t`, `\n` and `\r`: for single values such as
 * result strings and error messages, whose text stays complete.
 */
export function stripEscapes(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESCAPES, '').replace(CONTROL, '')
}

/**
 * Removes ANSI/VT escape sequences and control characters (keeping `\n` and `\t`) as a terminal would show a log:
 * a bare carriage return (progress bars) keeps only the text written after it on that line.
 */
export function stripAnsi(text: string): string {
  return stripEscapes(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastReturn = line.lastIndexOf('\r')
      return lastReturn === -1 ? line : line.slice(lastReturn + 1)
    })
    .join('\n')
}

/** Splits text into display lines after stripping; a trailing newline does not produce an empty last line. */
export function toLogLines(text: string): string[] {
  const stripped = stripAnsi(text)
  if (stripped === '') return []
  const lines = stripped.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
