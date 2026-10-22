package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHealthcheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scantor-node.status")
	now := time.Now()
	if err := Healthcheck(path, now); err == nil {
		t.Error("healthy without a status file")
	}
	if err := writeStatusFile(path, statusRecord{At: now.Add(-25 * time.Second).UnixMilli(), NodeID: testNodeID, StatusIntervalMs: 10000}); err != nil {
		t.Fatal(err)
	}
	if err := Healthcheck(path, now); err != nil {
		t.Errorf("25 s old with a 10 s interval: %v", err)
	}
	if err := Healthcheck(path, now.Add(6*time.Second)); err == nil {
		t.Error("healthy after 3 × statusIntervalMs")
	}
	// Without an interval in the file, the default 10 s applies.
	if err := writeStatusFile(path, statusRecord{At: now.Add(-31 * time.Second).UnixMilli(), NodeID: testNodeID}); err != nil {
		t.Fatal(err)
	}
	if err := Healthcheck(path, now); err == nil {
		t.Error("healthy after 3 × the default interval")
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Healthcheck(path, now); err == nil || !strings.Contains(err.Error(), "malformed") {
		t.Errorf("malformed file: %v", err)
	}
	// The file is replaced atomically: no temporary files are left behind.
	if err := writeStatusFile(path, statusRecord{At: now.UnixMilli(), NodeID: testNodeID}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Errorf("directory entries = %v, %v", entries, err)
	}
}

func TestClockEstimate(t *testing.T) {
	var c clockEstimate
	if c.ms() != 0 {
		t.Error("offset before the first sample")
	}
	c.observe(100*time.Millisecond, 10*time.Millisecond)
	if c.ms() != 100 {
		t.Errorf("first sample = %d", c.ms())
	}
	c.observe(200*time.Millisecond, 10*time.Millisecond) // EWMA α = 0.2: 0.2 × 200 + 0.8 × 100
	if c.ms() != 120 {
		t.Errorf("smoothed = %d, want 120", c.ms())
	}
	c.observe(-1000*time.Millisecond, clockMaxSampleRTT)
	if c.ms() != -104 {
		t.Errorf("smoothed = %d, want -104", c.ms())
	}
	// A held long-poll answered after 25 s: serverTime is taken at the answer, so rtt/2 adds 12.5 s.
	c.observe(12500*time.Millisecond, 25*time.Second)
	if c.ms() != -104 {
		t.Errorf("a sample with rtt > %s changed the offset to %d", clockMaxSampleRTT, c.ms())
	}
}

func TestClockEstimateFirstSampleSetsOffsetWhateverTheRTT(t *testing.T) {
	var c clockEstimate
	c.observe(300*time.Millisecond, 5*time.Second)
	if c.ms() != 300 {
		t.Errorf("first sample = %d, want 300", c.ms())
	}
}

func TestBackoffAndJitter(t *testing.T) {
	for n, want := range map[int]time.Duration{0: 5 * time.Second, 1: 5 * time.Second, 2: 10 * time.Second, 4: 40 * time.Second, 7: 5 * time.Minute, 200: 5 * time.Minute} {
		if got := expBackoff(5*time.Second, 5*time.Minute, n); got != want {
			t.Errorf("expBackoff(%d) = %s, want %s", n, got, want)
		}
	}
	for range 1000 {
		if d := jitter(time.Second, 0.2); d < 800*time.Millisecond || d > 1200*time.Millisecond {
			t.Fatalf("jitter = %s outside ±20 %%", d)
		}
	}
	b := backoff{min: time.Second, max: 30 * time.Second}
	var last time.Duration
	for range 10 {
		last = b.next()
	}
	if last < 24*time.Second || last > 36*time.Second {
		t.Errorf("backoff after 10 failures = %s, want about 30 s", last)
	}
	b.reset()
	if d := b.next(); d > 1200*time.Millisecond {
		t.Errorf("backoff after reset = %s", d)
	}
}
