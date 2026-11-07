// Package health is the runtime's half of the container healthcheck of workers and test runs
// (docs/runtime.md §5.3). The runtime rewrites a heartbeat file below its work root at every sign of
// progress: worker mode after every successful state poll, local mode on a fixed tick. `scantor runtime
// healthcheck`, which Docker runs inside the same container, fails once the file is older than Missed of
// the intervals the file announces, so the check needs no configuration of its own.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// FileName is the heartbeat file below the work root (<TMPDIR or /tmp>/scantor).
const FileName = "health.json"

// Missed is how many intervals may pass without a heartbeat before the healthcheck fails.
const Missed = 3

// LocalInterval is the heartbeat tick of local mode, which has no state poll.
const LocalInterval = 10 * time.Second

// Record is the content of the heartbeat file.
type Record struct {
	// At is the time of the last heartbeat in epoch milliseconds.
	At int64 `json:"at"`
	// Mode is the runtime mode that wrote the file (worker, local).
	Mode string `json:"mode"`
	// IntervalMs is the time until the next heartbeat the writer expects.
	IntervalMs int64 `json:"intervalMs"`
}

// Path returns the heartbeat file of a work root.
func Path(workRoot string) string { return filepath.Join(workRoot, FileName) }

// Write replaces the heartbeat file atomically (a temporary file in the same directory, then a rename),
// so the healthcheck never reads a partial record.
func Write(path, mode string, at time.Time, interval time.Duration) error {
	if interval <= 0 {
		return fmt.Errorf("write heartbeat: interval %s is not positive", interval)
	}
	data, err := json.Marshal(Record{At: at.UnixMilli(), Mode: mode, IntervalMs: interval.Milliseconds()})
	if err != nil {
		return fmt.Errorf("write heartbeat: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+FileName+"-*")
	if err != nil {
		return fmt.Errorf("write heartbeat: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write heartbeat: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write heartbeat: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write heartbeat: %w", err)
	}
	return nil
}

// Check reports whether the last heartbeat in the file at path is younger than Missed × its interval.
// It returns nil when healthy.
func Check(path string, now time.Time) error {
	data, err := os.ReadFile(path) //nolint:gosec // the heartbeat file below the runtime's own work root
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("no heartbeat yet")
		}
		return fmt.Errorf("read the heartbeat file: %w", err)
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil || rec.At <= 0 || rec.IntervalMs <= 0 {
		return errors.New("the heartbeat file is malformed")
	}
	limit := Missed * time.Duration(rec.IntervalMs) * time.Millisecond
	age := now.Sub(time.UnixMilli(rec.At))
	if age >= limit {
		return fmt.Errorf("the last %s heartbeat is %s old (limit %s)", rec.Mode, age.Round(time.Second), limit)
	}
	return nil
}

// Beater writes the heartbeats of one runtime. A failed write never stops the runtime (it only makes
// the container unhealthy): the first failure is logged at warn, later ones at debug.
type Beater struct {
	Path   string
	Mode   string
	Logger *slog.Logger
	// Now is the wall clock (time.Now when nil); the healthcheck compares with the same container clock.
	Now func() time.Time

	failed atomic.Bool
}

// Beat records a heartbeat that expects the next one within interval.
func (b *Beater) Beat(interval time.Duration) {
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	err := Write(b.Path, b.Mode, now(), interval)
	if err == nil {
		return
	}
	log := b.Logger
	if log == nil {
		log = slog.Default()
	}
	if b.failed.CompareAndSwap(false, true) {
		log.Warn("cannot write the heartbeat file; the container healthcheck will fail", "path", b.Path, "err", err)
	} else {
		log.Debug("cannot write the heartbeat file", "path", b.Path, "err", err)
	}
}

// Run beats at once and then every interval until ctx ends.
func (b *Beater) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		b.Beat(interval)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
