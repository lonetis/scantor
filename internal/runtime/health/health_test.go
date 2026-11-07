package health

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheck(t *testing.T) {
	path := Path(t.TempDir())
	now := time.Now()
	if err := Check(path, now); err == nil || err.Error() != "no heartbeat yet" {
		t.Errorf("without a heartbeat: %v", err)
	}
	if err := Write(path, "worker", now.Add(-14*time.Second), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := Check(path, now); err != nil {
		t.Errorf("14 s old with a 5 s interval: %v", err)
	}
	err := Check(path, now.Add(time.Second))
	if err == nil || !strings.Contains(err.Error(), "the last worker heartbeat is 15s old (limit 15s)") {
		t.Errorf("after 3 × the interval: %v", err)
	}
	for _, content := range []string{"{", `{"at":0,"mode":"worker","intervalMs":5000}`, `{"at":1,"mode":"worker"}`} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := Check(path, now); err == nil || !strings.Contains(err.Error(), "malformed") {
			t.Errorf("%s: %v", content, err)
		}
	}
}

func TestWrite(t *testing.T) {
	dir := t.TempDir()
	path := Path(dir)
	at := time.UnixMilli(1_790_000_000_123)
	if err := Write(path, "local", at, LocalInterval); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil || rec != (Record{At: 1_790_000_000_123, Mode: "local", IntervalMs: 10000}) {
		t.Fatalf("record %s: %v", data, err)
	}
	// The file is replaced atomically: no temporary file is left behind.
	if err := Write(path, "local", at.Add(time.Second), LocalInterval); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != FileName {
		t.Errorf("directory entries = %v, %v", entries, err)
	}
	if err := Write(path, "local", at, 0); err == nil {
		t.Error("a zero interval was accepted")
	}
	if err := Write(filepath.Join(dir, "missing", FileName), "local", at, LocalInterval); err == nil {
		t.Error("a write into a missing directory succeeded")
	}
}

func TestBeaterLogsTheFirstFailureAtWarn(t *testing.T) {
	var logs bytes.Buffer
	b := &Beater{
		Path: filepath.Join(t.TempDir(), "missing", FileName), Mode: "worker",
		Logger: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}
	b.Beat(time.Second)
	b.Beat(time.Second)
	if n := strings.Count(logs.String(), "level=WARN"); n != 1 {
		t.Errorf("%d warnings, want 1:\n%s", n, logs.String())
	}
	if n := strings.Count(logs.String(), "level=DEBUG"); n != 1 {
		t.Errorf("%d debug lines, want 1:\n%s", n, logs.String())
	}
}

func TestBeaterRun(t *testing.T) {
	path := Path(t.TempDir())
	clock := time.UnixMilli(1_790_000_000_000)
	b := &Beater{Path: path, Mode: "local", Now: func() time.Time { return clock }}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.Run(ctx, time.Hour)
	}()
	// Run beats at once, before the first tick.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := Check(path, clock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat before the first tick")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
