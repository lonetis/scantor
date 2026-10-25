package check

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	// stdout and stderr are read by one goroutine each, so the two diagnostics may arrive in either order.
	errs := map[string]map[string]any{}
	for _, e := range events {
		if e["type"] == "error" {
			diagnostic := e["error"].(map[string]any)
			errs[diagnostic["file"].(string)] = diagnostic
		}
	}
	py, goFile := errs["main.py"], errs["lib.go"]
	if len(errs) != 2 || py == nil || py["line"] != float64(14) || py["column"] != float64(12) ||
		goFile == nil || goFile["line"] != float64(6) || goFile["column"] != nil {
		t.Fatalf("errors %v", errs)
	}
	var checking []any
	for _, e := range events {
		if text, _ := e["text"].(string); e["type"] == "log" && strings.HasPrefix(text, "checking ") {
			checking = append(checking, text)
		}
	}
	if len(checking) != 1 || checking[0] != "checking main.py token=" {
		t.Fatalf("the worker token leaked or the entry was not substituted: %v", checking)
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
