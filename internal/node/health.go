package node

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// StatusFile is written after every successful status report; `scantor node healthcheck` reads it
// (docs/nodes.md §7.1). It lives inside the daemon container.
const StatusFile = "/tmp/scantor-node.status"

// defaultStatusInterval is assumed by the healthcheck when the status file does not carry the interval.
const defaultStatusInterval = 10 * time.Second

// statusRecord is the content of StatusFile. statusIntervalMs is the orchestrator's interval, so the
// healthcheck needs no configuration of its own.
type statusRecord struct {
	At               int64  `json:"at"`
	NodeID           string `json:"nodeId"`
	StatusIntervalMs int64  `json:"statusIntervalMs,omitempty"`
}

// writeStatusFile replaces path atomically (write to a temporary file, then rename).
func writeStatusFile(path string, rec statusRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".scantor-node.status-*")
	if err != nil {
		return fmt.Errorf("write status file: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write status file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write status file: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write status file: %w", err)
	}
	return nil
}

// Healthcheck reports whether the last successful status report (StatusFile at path) is younger than
// 3 × the status interval. It returns nil when healthy.
func Healthcheck(path string, now time.Time) error {
	data, err := os.ReadFile(path) //nolint:gosec // the fixed status file path
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("no successful status report yet")
		}
		return fmt.Errorf("read status file: %w", err)
	}
	var rec statusRecord
	if err := json.Unmarshal(data, &rec); err != nil || rec.At <= 0 {
		return errors.New("the status file is malformed")
	}
	interval := defaultStatusInterval
	if rec.StatusIntervalMs > 0 {
		interval = time.Duration(rec.StatusIntervalMs) * time.Millisecond
	}
	age := now.Sub(time.UnixMilli(rec.At))
	if age >= 3*interval {
		return fmt.Errorf("the last successful status report is %s old (limit %s)", age.Round(time.Second), 3*interval)
	}
	return nil
}

// clockEstimate smooths the offset to the orchestrator's clock with an EWMA (α = 0.2):
// offset = serverTime + rtt/2 − localTimeAtResponse for every response (docs/nodes.md §7.1).
type clockEstimate struct {
	mu     sync.Mutex
	valid  bool
	offset float64 // milliseconds
}

const clockAlpha = 0.2

func (c *clockEstimate) observe(sample time.Duration) {
	ms := float64(sample) / float64(time.Millisecond)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.valid {
		c.offset, c.valid = ms, true
		return
	}
	c.offset = clockAlpha*ms + (1-clockAlpha)*c.offset
}

// ms returns the smoothed offset in whole milliseconds (0 before the first sample).
func (c *clockEstimate) ms() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return int64(math.Round(c.offset))
}
