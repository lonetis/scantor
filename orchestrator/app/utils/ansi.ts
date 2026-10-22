// Logs from user code are rendered as plain text: escape sequences and control characters are removed
// (docs/security.md HDR-5).

// eslint-disable-next-line no-control-regex
const OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g
// eslint-disable-next-line no-control-regex
const CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\u001B[ -/]*[0-~]?/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Removes ANSI/VT escape sequences and control characters (keeping `\n` and `\t`). A bare carriage return
 * (progress bars) keeps only the text written after it on that line.
 */
export function stripAnsi(text: string): string {
  const withoutEscapes = text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESCAPES, '')
  return withoutEscapes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastReturn = line.lastIndexOf('\r')
      return lastReturn === -1 ? line : line.slice(lastReturn + 1)
    })
    .join('\n')
    .replace(CONTROL, '')
}

/** Splits text into display lines after stripping; a trailing newline does not produce an empty last line. */
export function toLogLines(text: string): string[] {
  const stripped = stripAnsi(text)
  if (stripped === '') return []
  const lines = stripped.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
