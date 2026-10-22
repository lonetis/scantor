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

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/redact"
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

// Print writes a result: v as indented JSON in JSON mode, otherwise whatever human writes.
func (o *Output) Print(v any, human func(w io.Writer) error) error {
	if o.JSON() {
		return o.PrintJSON(v)
	}
	return human(o.Out)
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
			cells[i] = strings.NewReplacer("\t", " ", "\n", " ").Replace(c)
		}
		if _, err := fmt.Fprintln(tw, strings.Join(cells, "\t")); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// PrintList writes items as JSON (the items array, or the page object when page is not nil) or table.
func (o *Output) PrintList(items any, table Table) error {
	return o.Print(items, table.Write)
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

// Infof writes a progress line to stderr (both formats; stdout stays machine-readable).
func (o *Output) Infof(format string, args ...any) {
	_, _ = fmt.Fprintf(o.Err, format+"\n", args...)
}

// Warnf writes a warning line to stderr.
func (o *Output) Warnf(format string, args ...any) {
	_, _ = fmt.Fprintf(o.Err, "warning: "+format+"\n", args...)
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
	_, _ = fmt.Fprintf(o.Err, "Error: %s\n", body.Message)
	if apiErr == nil {
		return
	}
	var details struct {
		Issues []api.Issue      `json:"issues"`
		Errors []api.BuildError `json:"errors"`
	}
	if len(apiErr.Details) > 0 && json.Unmarshal(apiErr.Details, &details) == nil {
		for _, is := range details.Issues {
			_, _ = fmt.Fprintf(o.Err, "  %s: %s\n", is.Path, is.Message)
		}
		for _, be := range details.Errors {
			_, _ = fmt.Fprintf(o.Err, "  %s\n", FormatBuildError(be))
		}
	}
	if apiErr.Status >= 500 && apiErr.RequestID != "" {
		_, _ = fmt.Fprintf(o.Err, "  request id: %s\n", apiErr.RequestID)
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

// FormatBuildError renders "<phase> <file>:<line>:<column>: <message>" with the parts that are set.
func FormatBuildError(e api.BuildError) string {
	loc := e.File
	if loc != "" && e.Line > 0 {
		loc = fmt.Sprintf("%s:%d", loc, e.Line)
		if e.Column > 0 {
			loc = fmt.Sprintf("%s:%d", loc, e.Column)
		}
	}
	if loc != "" {
		return fmt.Sprintf("[%s] %s: %s", e.Phase, loc, e.Message)
	}
	return fmt.Sprintf("[%s] %s", e.Phase, e.Message)
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

// HumanSize renders a byte count in the env value syntax when exact ("512MiB"), else HumanBytes.
func HumanSize(n int64) string {
	s := envconf.FormatByteSize(n)
	if strings.HasSuffix(s, "iB") || n < 1024 {
		return s
	}
	return HumanBytes(n)
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
