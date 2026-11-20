package bundlerun

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/runtime/scheduler"
)

// progressInterval is the period of the progress lines of the human output (a variable for tests).
var progressInterval = 10 * time.Second

// Bounds of the human output.
const (
	// maxShownFailures failures are printed; the others are only in results.jsonl.
	maxShownFailures = 10
	// maxMessageBytes shortens a message on the console.
	maxMessageBytes = 300
)

// console renders the events of a bundle run (docs/runtime.md §15.7): with -o json the masked local-mode
// events as NDJSON on stdout, otherwise a start line, the resolutions, a progress line every 10 s, the first
// failures and a final summary on stdout, and connector output outside analyses and error events on stderr.
// Per-analysis log lines are dropped; results.jsonl keeps the end of each log.
type console struct {
	o      *Options
	json   *local.Emitter
	runDir string

	mu       sync.Mutex
	started  time.Time
	limit    int
	procs    int
	sched    int64
	ok       int64
	failed   int64
	shown    int
	expected *int64
	err      error
}

func newConsole(o *Options, p *prepared) *console {
	c := &console{o: o, runDir: p.outDir, limit: o.Flags.Limit, procs: p.settings.Processes, started: o.Now()}
	if o.JSON {
		c.json = local.NewEmitter(o.Stdout)
	}
	return c
}

// event handles one masked event.
func (c *console) event(ev any) {
	if c.json != nil {
		c.json.Emit(ev)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	switch e := ev.(type) {
	case local.StartEvent:
		c.started = e.At.Time
		limit := "no limit"
		if c.limit > 0 {
			limit = fmt.Sprintf("limit %d", c.limit)
		}
		c.line(c.o.Stdout, "%s (%s): %s, %s, %s; results in %s", c.o.Info.Ref, platformText(c.o.Info.Platform),
			scheduleText(e.Schedule), countText(c.procs, "process", "processes"), limit, c.o.displayPath(c.runDir))
	case local.ResolvedEvent:
		total := "unknown number of analyses"
		if e.ExpectedTotal != nil {
			total = countText(int(*e.ExpectedTotal), "analysis", "analyses") + " expected"
			if e.Key == scheduler.KeySchedule {
				n := *e.ExpectedTotal
				c.expected = &n
			}
		}
		c.line(c.o.Stdout, "resolved %s (%s): %s", e.Template, e.Key, total)
	case local.ScheduledEvent:
		c.sched++
	case local.LogEvent:
		if e.Seq == nil {
			c.line(c.o.Stderr, "[connector %s] %s", e.Stream, e.Text)
		}
	case local.ResultEvent:
		if e.Status == runtime.StatusSucceeded {
			c.ok++
			return
		}
		c.failed++
		if c.shown < maxShownFailures {
			c.shown++
			c.line(c.o.Stdout, "#%d failed (%s, attempt %d): %s", e.Seq, errorType(e.Error), e.Attempt, errorMessage(e.Error))
			if c.shown == maxShownFailures {
				c.line(c.o.Stdout, "further failures are only written to %s", ResultsFile)
			}
		}
	case local.ErrorEvent:
		c.line(c.o.Stderr, "error: %s: %s", e.Error.Type, oneLine(e.Error.Message))
	}
}

// progress prints a progress line (human output only).
func (c *console) progress() {
	if c.json != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	elapsed := c.o.Now().Sub(c.started)
	done := c.ok + c.failed
	running := max(min(c.sched-done, int64(c.procs)), 0)
	rate := 0.0
	if elapsed > 0 {
		rate = float64(done) / elapsed.Seconds()
	}
	line := fmt.Sprintf("[%s] %d done (%d ok, %d failed), %d running, %.1f/s", elapsed.Round(time.Second), done, c.ok, c.failed, running, rate)
	if c.expected != nil && *c.expected > 0 {
		total := *c.expected
		if c.limit > 0 {
			total = min(total, int64(c.limit))
		}
		line += fmt.Sprintf(", %.0f%% of %d", 100*float64(done)/float64(total), total)
	}
	c.line(c.o.Stdout, "%s", line)
}

// failure reports a write failure of the run directory on stderr (both output formats).
func (c *console) failure(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.line(c.o.Stderr, "error: %v; stopping the run", err)
}

// final prints the summary of the run (human output only; -o json ends with the end event).
func (c *console) final(info RunInfo, code int) {
	if c.json != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	reason := ""
	if info.Reason != nil {
		reason = *info.Reason
	}
	elapsed := c.o.Now().Sub(info.StartedAt.Time).Round(time.Second)
	s := info.Summary
	c.line(c.o.Stdout, "finished (%s) after %s: %s, %d succeeded, %d failed", reason, elapsed, countText(s.Analyses, "analysis", "analyses"), s.Succeeded, s.Failed)
	dir := c.o.displayPath(c.runDir)
	c.line(c.o.Stdout, "results: %s", filepath.Join(dir, ResultsFile))
	c.line(c.o.Stdout, "files:   %s", filepath.Join(dir, "files"))
	c.line(c.o.Stdout, "run:     %s", filepath.Join(dir, RunFile))
	c.line(c.o.Stdout, "exit code %d", code)
}

// Err returns the first write error of the console.
func (c *console) Err() error {
	if c.json != nil {
		return c.json.Err()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// line writes one terminal-safe line: messages and connector output come from task code and scanned data.
func (c *console) line(w io.Writer, format string, args ...any) {
	if _, err := io.WriteString(w, terminalSafe(fmt.Sprintf(format, args...))+"\n"); err != nil && c.err == nil {
		c.err = err
	}
}

func platformText(p api.Platform) string {
	s := p.OS + "/" + p.Arch
	if p.Variant != "" {
		s += "/" + p.Variant
	}
	return s
}

func scheduleText(s api.Schedule) string {
	if s.Kind == api.ScheduleKindTemplate {
		return "template " + s.Template
	}
	return s.Kind + " schedule"
}

func countText(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func errorType(e *api.ScantorError) string {
	if e == nil {
		return "unknown"
	}
	return string(e.Type)
}

func errorMessage(e *api.ScantorError) string {
	if e == nil {
		return ""
	}
	return oneLine(e.Message)
}

// oneLine returns the first line of s, shortened to maxMessageBytes.
func oneLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if len(s) > maxMessageBytes {
		cut := maxMessageBytes
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}

// terminalSafe escapes control characters (except tab) and invalid UTF-8, so task output cannot move the
// cursor or change the terminal.
func terminalSafe(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			fmt.Fprintf(&b, `\x%02x`, s[i])
		case r == '\t':
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
