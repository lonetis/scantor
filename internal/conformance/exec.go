// Package conformance is the connector conformance harness (docs/protocol.md §12, docs/testing.md §5):
// one Go implementation of the runtime's side of the protocol that every connector must pass.
//
// The host side (Suite, `scantor conformance --language <l>`) builds every fixture task of
// testdata/<language>/ with `scantor task build` against the language's base image, and runs each case
// in its own container (network none, the hardening profile of describe containers, the injected
// scantor binary) as `scantor conformance exec --case <id>`. The exec side (Exec) spawns
// SCANTOR_CONNECTOR_CMD exactly as the runtime does, drives fds 3/4, validates every line the connector
// writes against message.schema.json (P1) and prints one JSON report line.
package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"time"

	"github.com/lonetis/scantor/internal/protocol"
)

// Report is the outcome of one case run: one JSON line on the exec side's stdout.
type Report struct {
	Case       string   `json:"case"`
	Fixture    string   `json:"fixture"`
	Language   string   `json:"language"`
	OK         bool     `json:"ok"`
	Checks     int      `json:"checks"`
	Failures   []string `json:"failures"`
	DurationMs int64    `json:"durationMs"`
}

// Exit codes of the exec side.
const (
	ExitPassed = 0
	ExitFailed = 1
	ExitUsage  = 2
)

// Exec runs one case against the fixture's connector and writes its report to out.
func Exec(ctx context.Context, cfg ExecConfig, caseID string, out io.Writer) int {
	c, ok := Lookup(caseID)
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown case %q\n", caseID)
		return ExitUsage
	}
	if cfg.ConnectorCmd == "" || cfg.Entry == "" {
		fmt.Fprintln(os.Stderr, "SCANTOR_CONNECTOR_CMD and --entry are required")
		return ExitUsage
	}
	validator, err := protocol.DefaultValidator()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitUsage
	}
	if err := os.MkdirAll(cfg.WorkRoot, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitUsage
	}
	h := &H{cfg: cfg, validator: validator}
	start := time.Now()
	runErr := runCase(ctx, h, c)
	h.close()
	if runErr != nil {
		h.failf("%v", runErr)
	}
	report := Report{Case: c.ID, Fixture: cfg.Fixture, Language: cfg.Language, Checks: h.checks, Failures: h.failures, DurationMs: time.Since(start).Milliseconds()}
	if report.Failures == nil {
		report.Failures = []string{}
	}
	report.OK = len(report.Failures) == 0
	b, err := json.Marshal(report)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitFailed
	}
	fmt.Fprintln(out, string(b))
	if !report.OK {
		return ExitFailed
	}
	return ExitPassed
}

// runCase runs c, turning a panic of the harness into a failure. The case runs in its own goroutine (so
// ctx can end the wait), which therefore recovers its own panics.
func runCase(ctx context.Context, h *H, c Case) error {
	done := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("the harness panicked: %v\n%s", r, debug.Stack())
			}
		}()
		done <- c.Run(h)
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
