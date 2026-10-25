package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/taskpipe"
)

// Format is the output format selected with -o.
type Format string

// Output formats.
const (
	FormatHuman Format = "human"
	FormatJSON  Format = "json"
)

// ParseFormat validates the value of -o.
func ParseFormat(s string) (Format, error) {
	switch Format(s) {
	case FormatHuman, FormatJSON:
		return Format(s), nil
	default:
		return "", fmt.Errorf("invalid output format %q: use human or json", s)
	}
}

// Output writes command results. In JSON mode stdout carries only JSON (one document, or one object per
// line for streams); progress and diagnostics always go to stderr.
type Output struct {
	Format Format
	Out    io.Writer
	Err    io.Writer
}

// JSON reports whether -o json is active.
func (o *Output) JSON() bool { return o.Format == FormatJSON }

// Print writes a result: v as indented JSON in JSON mode, otherwise whatever human writes, made
// terminal-safe (TerminalSafe), because detail views and tables carry task-controlled text.
func (o *Output) Print(v any, human func(w io.Writer) error) error {
	if o.JSON() {
		return o.PrintJSON(v)
	}
	safe := &terminalSafeWriter{w: o.Out}
	if err := human(safe); err != nil {
		return err
	}
	return safe.Flush()
}

// TerminalText prepares raw content (worker logs, task files) for stdout: unchanged into a pipe or file,
// so the bytes stay exact, and terminal-safe when stdout is a terminal.
func (o *Output) TerminalText(s string) string {
	if apiIsTerminal(o.Out) {
		return TerminalSafe(s)
	}
	return s
}

// PrintJSON writes v as indented JSON followed by a newline.
func (o *Output) PrintJSON(v any) error {
	enc := json.NewEncoder(o.Out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return PlatformError(fmt.Errorf("write output: %w", err))
	}
	return nil
}

// Table is a human-readable table; in JSON mode commands print their items instead.
type Table struct {
	Headers []string
	Rows    [][]string
}

// Add appends a row.
func (t *Table) Add(cells ...string) { t.Rows = append(t.Rows, cells) }

// Write renders the table with aligned columns.
func (t Table) Write(w io.Writer) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if len(t.Headers) > 0 {
		if _, err := fmt.Fprintln(tw, strings.Join(t.Headers, "\t")); err != nil {
			return err
		}
	}
	for _, row := range t.Rows {
		cells := make([]string, len(row))
		for i, c := range row {
			// Escaped before alignment, so a control character cannot shift the columns.
			cells[i] = TerminalSafe(strings.NewReplacer("\t", " ", "\n", " ").Replace(normaliseNewlines(c)))
		}
		if _, err := fmt.Fprintln(tw, strings.Join(cells, "\t")); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// NDJSON writes one compact JSON object per line (streams such as `dev run -o json` events). It is safe
// for concurrent use.
type NDJSON struct {
	mu  sync.Mutex
	enc *json.Encoder
}

// NDJSON returns a line writer on stdout.
func (o *Output) NDJSON() *NDJSON {
	enc := json.NewEncoder(o.Out)
	enc.SetEscapeHTML(false)
	return &NDJSON{enc: enc}
}

// Write encodes v as one line.
func (n *NDJSON) Write(v any) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.enc.Encode(v); err != nil {
		return PlatformError(fmt.Errorf("write output: %w", err))
	}
	return nil
}

// Infof writes a terminal-safe progress line to stderr (both formats; stdout stays machine-readable).
func (o *Output) Infof(format string, args ...any) {
	_, _ = io.WriteString(o.Err, TerminalSafe(fmt.Sprintf(format, args...))+"\n")
}

// Warnf writes a terminal-safe warning line to stderr.
func (o *Output) Warnf(format string, args ...any) {
	_, _ = io.WriteString(o.Err, "warning: "+TerminalSafe(fmt.Sprintf(format, args...))+"\n")
}

// TerminalSafe makes text safe to print to a terminal (docs/security.md HDR-5). Task code controls
// errors, logs, results and file names; printed raw, an ESC in them could write the clipboard (OSC 52),
// retitle the window, fake a hyperlink or move the cursor over earlier output. Newlines and tabs are
// kept, a carriage return (alone or before a newline) becomes a newline, and every other C0 control
// character, DEL, every C1 control character and every byte that is not valid UTF-8 is replaced by a
// visible escape (\x1b, \u009b, \xff). The escapes are printable, so applying it twice changes nothing.
func TerminalSafe(s string) string {
	if !needsTerminalEscape(s) {
		return s
	}
	s = normaliseNewlines(s)
	var b strings.Builder
	b.Grow(len(s) + 16)
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			fmt.Fprintf(&b, `\x%02x`, s[i])
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r >= 0x80 && r <= 0x9f:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	return b.String()
}

// needsTerminalEscape reports whether s holds anything TerminalSafe changes.
func needsTerminalEscape(s string) bool {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if (r == utf8.RuneError && size == 1) || (r < 0x20 && r != '\n' && r != '\t') || (r >= 0x7f && r <= 0x9f) {
			return true
		}
		i += size
	}
	return false
}

// normaliseNewlines turns "\r\n" and a lone "\r" into "\n".
func normaliseNewlines(s string) string {
	if !strings.Contains(s, "\r") {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

// terminalSafeWriter applies TerminalSafe to a stream of writes. It holds back a trailing carriage return
// and an incomplete UTF-8 sequence until the next Write or Flush, so a "\r\n" or a C1 character split
// across two writes is still recognised.
type terminalSafeWriter struct {
	w       io.Writer
	pending []byte
}

func (t *terminalSafeWriter) Write(p []byte) (int, error) {
	buf := append(t.pending, p...)
	keep := heldBackSuffix(buf)
	t.pending = append([]byte(nil), buf[len(buf)-keep:]...)
	if _, err := io.WriteString(t.w, TerminalSafe(string(buf[:len(buf)-keep]))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Flush writes what Write held back.
func (t *terminalSafeWriter) Flush() error {
	if len(t.pending) == 0 {
		return nil
	}
	rest := TerminalSafe(string(t.pending))
	t.pending = nil
	_, err := io.WriteString(t.w, rest)
	return err
}

// heldBackSuffix returns how many trailing bytes of b may combine with the next write: a carriage return,
// or the start of a UTF-8 sequence that is not complete yet.
func heldBackSuffix(b []byte) int {
	n := len(b)
	if n > 0 && b[n-1] == '\r' {
		return 1
	}
	for i := 1; i <= utf8.UTFMax-1 && i <= n; i++ {
		c := b[n-i]
		if c < utf8.RuneSelf {
			return 0
		}
		if utf8.RuneStart(c) {
			if utf8.FullRune(b[n-i:]) {
				return 0
			}
			return i
		}
	}
	return 0
}

// errorJSON is the stderr document of a failed command in JSON mode.
type errorJSON struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	ExitCode  int             `json:"exitCode"`
	Status    int             `json:"status,omitempty"`
	Details   json.RawMessage `json:"details,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
}

// PrintError reports a failed command on stderr: "Error: …" (with API issues listed) in human mode,
// {"error": {…}} in JSON mode. Messages are redacted.
func (o *Output) PrintError(err error) {
	if err == nil || isSilent(err) {
		return
	}
	code := ExitCode(err)
	body := errorBody{Code: exitCodeName(code), Message: redact.String(err.Error()), ExitCode: code}
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		body.Code, body.Message, body.Status = apiErr.Code, redact.String(apiErr.Message), apiErr.Status
		body.Details, body.RequestID = apiErr.Details, apiErr.RequestID
	}
	if o.JSON() {
		enc := json.NewEncoder(o.Err)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(errorJSON{Error: body})
		return
	}
	// Messages, issues and build errors can quote task content: everything goes through TerminalSafe.
	safe := &terminalSafeWriter{w: o.Err}
	defer func() { _ = safe.Flush() }()
	_, _ = fmt.Fprintf(safe, "Error: %s\n", body.Message)
	if apiErr == nil {
		return
	}
	var details struct {
		Issues []api.Issue      `json:"issues"`
		Errors []api.BuildError `json:"errors"`
	}
	if len(apiErr.Details) > 0 && json.Unmarshal(apiErr.Details, &details) == nil {
		for _, is := range details.Issues {
			_, _ = fmt.Fprintf(safe, "  %s: %s\n", is.Path, is.Message)
		}
		for _, be := range details.Errors {
			_, _ = fmt.Fprintf(safe, "  %s\n", FormatBuildError(be))
		}
	}
	if apiErr.Status >= 500 && apiErr.RequestID != "" {
		_, _ = fmt.Fprintf(safe, "  request id: %s\n", apiErr.RequestID)
	}
}

func exitCodeName(code int) string {
	switch code {
	case ExitAnalysisFailures:
		return "analysisFailures"
	case ExitValidation:
		return "validation"
	default:
		return "platform"
	}
}

// FormatBuildError renders "[<phase>] <file>:<line>:<column>: <message>" with the parts that are set. It
// is the one rendering of build errors in the CLI, for errors the platform reports and local pack problems
// alike.
func FormatBuildError(e api.BuildError) string {
	return fmt.Sprintf("[%s] %s", e.Phase, taskpipe.FormatBuildError(e))
}

// HumanBytes renders a byte count with a binary unit ("1.5 GiB", "512 B").
func HumanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value, exp := float64(n), 0
	for value >= unit && exp < 4 {
		value /= unit
		exp++
	}
	return fmt.Sprintf("%.1f %s", value, []string{"B", "KiB", "MiB", "GiB", "TiB"}[exp])
}

// HumanTime renders a timestamp in local time ("2026-10-21 11:01:00"), or "-" for nil/zero.
func HumanTime(t *api.Time) string {
	if t == nil || t.IsZero() {
		return "-"
	}
	return t.Local().Format("2006-01-02 15:04:05")
}

// HumanAge renders the time since t ("3m", "2h", "5d"), or "-".
func HumanAge(t *api.Time, now time.Time) string {
	if t == nil || t.IsZero() {
		return "-"
	}
	d := now.Sub(t.Time)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// HumanDuration renders milliseconds compactly ("40ms", "1.2s", "3m4s").
func HumanDuration(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", ms)
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	default:
		return d.Round(time.Second).String()
	}
}
