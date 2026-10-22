package check

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/runtime"
)

func runCheck(t *testing.T, script string, timeout time.Duration) (int, []map[string]any) {
	t.Helper()
	dir := t.TempDir()
	cmd := ""
	if script != "" {
		path := filepath.Join(dir, "checker.sh")
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
			t.Fatal(err)
		}
		cmd = "./checker.sh {entry}"
	}
	cfg := runtime.Config{CheckCmd: cmd, Environ: []string{"PATH=/usr/bin:/bin", "SCANTOR_WORKER_TOKEN=secret"}}
	var out bytes.Buffer
	code := Run(context.Background(), Options{Entry: "main.py", Config: cfg, Stdout: &out, TaskDir: dir, Timeout: timeout})
	var events []map[string]any
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var e map[string]any
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatal(err)
		}
		if e["phase"] != "check" {
			t.Fatalf("phase %v", e)
		}
		events = append(events, e)
	}
	return code, events
}

func TestCheckDiagnostics(t *testing.T) {
	code, events := runCheck(t, `echo "checking $1 token=$SCANTOR_WORKER_TOKEN"
echo "/task/main.py:14:12: Argument of type int cannot be assigned"
echo "lib.go:6: undefined: x" >&2
echo "[warning] main.py line 3:5 unused"
exit 1
`, 0)
	if code != ExitFailed {
		t.Fatalf("exit %d", code)
	}
	var errs []map[string]any
	for _, e := range events {
		if e["type"] == "error" {
			errs = append(errs, e["error"].(map[string]any))
		}
		if e["type"] == "log" && e["text"] == "checking main.py token=" {
			continue
		}
	}
	if len(errs) != 2 || errs[0]["file"] != "main.py" || errs[0]["line"] != float64(14) || errs[0]["column"] != float64(12) ||
		errs[1]["file"] != "lib.go" || errs[1]["line"] != float64(6) || errs[1]["column"] != nil {
		t.Fatalf("errors %v", errs)
	}
	if events[0]["text"] != "checking main.py token=" {
		t.Fatalf("the worker token leaked or the entry was not substituted: %v", events[0])
	}
	last := events[len(events)-1]
	if last["type"] != "result" || last["ok"] != false || last["exitCode"] != float64(1) || last["skipped"] != false {
		t.Fatalf("result %v", last)
	}
}

func TestCheckOKSkippedAndTimeout(t *testing.T) {
	code, events := runCheck(t, "exit 0\n", 0)
	if last := events[len(events)-1]; code != ExitOK || last["ok"] != true || last["exitCode"] != float64(0) {
		t.Fatalf("ok: %d %v", code, last)
	}
	code, events = runCheck(t, "", 0)
	if last := events[len(events)-1]; code != ExitOK || last["skipped"] != true || last["ok"] != true {
		t.Fatalf("skipped: %d %v", code, last)
	}
	code, events = runCheck(t, "sleep 30\n", 300*time.Millisecond)
	last := events[len(events)-1]
	if code != ExitFailed || last["ok"] != false || last["exitCode"] != nil || events[len(events)-2]["error"].(map[string]any)["message"] != "check exceeded 300ms" {
		t.Fatalf("timeout: %d %v", code, events)
	}
}
