package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
)

const testRunID = "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d"

func testRunJSON(state string, summary [3]int, errs []any) map[string]any {
	if errs == nil {
		errs = []any{}
	}
	return map[string]any{
		"id": testRunID, "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "taskName": "echo", "state": state,
		"input": map[string]any{"limit": 5, "maxAttempts": 1, "timeoutMs": 300000}, "errors": errs,
		"summary": map[string]any{"analyses": summary[0], "succeeded": summary[1], "failed": summary[2]},
	}
}

// sse writes server-sent events.
func sse(w http.ResponseWriter, events ...[2]any) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, ev := range events {
		data, _ := json.Marshal(ev[1])
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev[0], data)
	}
}

// remoteFake serves the remote dev run flow: upload, test run, stream, final test run, one file.
func remoteFake(t *testing.T, final map[string]any) *apiFake {
	f := newAPIFake(t)
	content := "file content"
	sum := sha256.Sum256([]byte(content))
	analysis := map[string]any{
		"id": testRunID + "-0", "seq": 0, "status": "succeeded", "attempt": 1, "result": map[string]any{"text": "Hi"},
		"error": nil, "attempts": []any{}, "logTail": "",
		"files": []any{map[string]any{"id": "f1", "name": "report.txt", "size": len(content), "sha256": hex.EncodeToString(sum[:]), "contentType": "text/plain"}},
	}
	f.reply("POST", "/api/tasks/upload", http.StatusCreated, map[string]any{"task": testTaskJSON("echo"), "revision": nil, "created": false})
	f.reply("POST", "/api/tasks/echo/test-runs", http.StatusCreated, testRunJSON("queued", [3]int{}, nil))
	f.on("GET", "/api/test-runs/"+testRunID+"/stream", func(w http.ResponseWriter, _ *http.Request) {
		sse(w,
			[2]any{"state", map[string]any{"state": "building"}},
			[2]any{"log", map[string]any{"seq": nil, "stream": "build", "text": "#1 [1/2] FROM python", "at": "2026-10-21T09:10:01.020Z"}},
			[2]any{"log", map[string]any{"seq": 0, "stream": "stderr", "text": "[info] greeting Hi", "at": "2026-10-21T09:10:01.030Z"}},
			[2]any{"analysis", analysis},
			[2]any{"end", final},
		)
	})
	full := map[string]any{}
	for k, v := range final {
		full[k] = v
	}
	full["analyses"] = []any{analysis}
	f.reply("GET", "/api/test-runs/"+testRunID, http.StatusOK, full)
	f.on("GET", "/api/test-runs/"+testRunID+"/files/f1", func(w http.ResponseWriter, r *http.Request) {
		apiFakeJSON(w, http.StatusOK, map[string]any{"url": "http://" + r.Host + "/download/f1", "name": "report.txt", "size": len(content), "sha256": hex.EncodeToString(sum[:])})
	})
	f.on("GET", "/download/f1", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(content)) })
	return f
}

func TestDevRunRemote(t *testing.T) {
	f := remoteFake(t, testRunJSON("completed", [3]int{1, 1, 0}, nil))
	dir := writeTaskDir(t, nil)
	code, out, errOut := f.exec("dev", "run", dir, "--remote", "--task-config", `{"greeting":"Hi"}`, "--limit", "2", "--timeout", "30s", "--force")
	if code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	up := f.last("POST", "/api/tasks/upload")
	if up.Query.Get("publish") != "false" || up.Query.Get("force") != "true" {
		t.Fatalf("upload query %v", up.Query)
	}
	apiJSONEqual(t, f.last("POST", "/api/tasks/echo/test-runs").Body, `{"taskConfig":{"greeting":"Hi"},"limit":2,"maxAttempts":1,"timeoutMs":30000}`)
	for _, want := range []string{"[-] build: #1 [1/2] FROM python", "[#0] stderr: [info] greeting Hi", `[#0] succeeded (attempt 1, 0ms): {"text":"Hi"}`, "done (completed): 1 analyses, 1 succeeded, 0 failed"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout lacks %q:\n%s", want, out)
		}
	}
	files, err := filepath.Glob(filepath.Join(dir, ".scantor", "out", "*", "files", "0", "f1", "report.txt"))
	if err != nil || len(files) != 1 {
		t.Fatalf("downloaded files %v %v", files, err)
	}
	if data, _ := os.ReadFile(files[0]); string(data) != "file content" {
		t.Fatalf("content %q", data)
	}
	if !strings.Contains(errOut, "1 file(s) written to") {
		t.Fatalf("stderr %s", errOut)
	}
}

func TestDevRunRemoteJSON(t *testing.T) {
	f := remoteFake(t, testRunJSON("completed", [3]int{1, 0, 1}, nil))
	code, out, _ := f.execEnv(map[string]string{"SCANTOR_DEV_MODE": "remote"}, "dev", "run", writeTaskDir(t, nil), "-o", "json")
	if code != 1 {
		t.Fatalf("exit %d, want 1 (an analysis failed)", code)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 5 {
		t.Fatalf("%d lines:\n%s", len(lines), out)
	}
	for i, want := range []string{"state", "log", "log", "analysis", "end"} {
		var ev struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal([]byte(lines[i]), &ev); err != nil || ev.Type != want || len(ev.Data) == 0 {
			t.Fatalf("line %d %q: %v", i, lines[i], err)
		}
	}
}

func TestDevRunRemoteInsideTheEditor(t *testing.T) {
	f := remoteFake(t, testRunJSON("completed", [3]int{1, 1, 0}, nil))
	workspace := t.TempDir()
	task := filepath.Join(workspace, "echo")
	if err := os.MkdirAll(task, 0o755); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := f.execEnv(map[string]string{"SCANTOR_DEV_MODE": "remote", "SCANTOR_WORKSPACE": workspace}, "dev", "run", task)
	if code != 0 || len(f.calls("POST", "/api/tasks/upload")) != 0 || len(f.calls("POST", "/api/tasks/echo/test-runs")) != 1 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
}

func TestDevRunRemoteOutcomes(t *testing.T) {
	tests := []struct {
		name  string
		final map[string]any
		code  int
	}{
		{"static error", testRunJSON("failed", [3]int{}, []any{map[string]any{"phase": "static", "file": "Dockerfile", "line": 3, "message": "x"}}), 2},
		{"config error", testRunJSON("failed", [3]int{}, []any{map[string]any{"phase": "config", "message": "taskConfig /greeting: must be string"}}), 2},
		{"schedule error", testRunJSON("failed", [3]int{}, []any{map[string]any{"phase": "schedule", "message": "boom"}}), 1},
		{"platform error", testRunJSON("failed", [3]int{}, []any{map[string]any{"phase": "config", "message": "x"}, map[string]any{"phase": "platform", "message": "timeout"}}), 3},
		{"cancelled", testRunJSON("cancelled", [3]int{}, nil), 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := remoteFake(t, tt.final)
			if code, out, errOut := f.exec("dev", "run", writeTaskDir(t, nil), "--remote"); code != tt.code {
				t.Fatalf("exit %d, want %d\n%s\n%s", code, tt.code, out, errOut)
			}
		})
	}
}

func TestDevRunUsage(t *testing.T) {
	f := newAPIFake(t)
	for _, args := range [][]string{
		{"dev", "run", "--limit", "0"},
		{"dev", "run", "--max-attempts", "21"},
		{"dev", "run", "--timeout", "10ms"},
		{"dev", "run", "--task-config", "[1]"},
		{"dev", "run", "--task-config", "{bad"},
		{"dev", "run", "--task-config", "-", "--scan-config", "-"},
	} {
		if code, _, errOut := f.exec(args...); code != 2 {
			t.Errorf("%v: exit %d (%s)", args, code, errOut)
		}
	}
	code, _, errOut := f.execEnv(map[string]string{"SCANTOR_DEV_MODE": "remote"}, "dev", "debug")
	if code != 3 || !strings.Contains(errOut, "debugging needs local Docker") {
		t.Fatalf("dev debug in remote mode: exit %d %s", code, errOut)
	}
	if f.count() != 0 {
		t.Fatal("usage errors make no requests")
	}
}

// buildResult is a successful build result of the echo task with the description example.
func buildResult(t *testing.T) *taskpipe.Result {
	t.Helper()
	var desc api.Description
	if err := json.Unmarshal([]byte(`{"protocolVersion":1,"connector":{"language":"python","version":"1.4.0"},
		"schemas":{"taskConfig":{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"list":{"type":["string","null"],"x-scantor":"upload","default":null}},"additionalProperties":false},
		"scanConfig":{"type":"object","properties":{"count":{"type":"integer","minimum":1}},"required":["count"],"additionalProperties":false},
		"analysisConfig":{"type":"object","properties":{"n":{"type":"integer","default":0}},"additionalProperties":false},
		"result":{"type":"object"}},"schedule":{"kind":"custom"},
		"secretPaths":{"taskConfig":[],"scanConfig":[],"analysisConfig":[],"result":[]},
		"uploadPaths":{"taskConfig":["/list"],"scanConfig":[]},"fileRefPaths":[],"warnings":[]}`), &desc); err != nil {
		t.Fatal(err)
	}
	settings := api.DefaultScanSettings()
	return &taskpipe.Result{
		OK: true, Manifest: &manifest.Manifest{Scantor: 1, Name: "echo", Language: "python", Entry: "main.py"},
		SettingsDefaults: &settings, Description: &desc,
	}
}

func TestDevSpec(t *testing.T) {
	cfg, err := LoadConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	out := &Output{Format: FormatHuman, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}
	opts := devOptions{limit: 5, maxAttempts: 1}

	spec, err := devSpec(out, buildResult(t), opts, devConfigs{scan: json.RawMessage(`{"count":3}`)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(spec.TaskConfig) != `{"greeting":"Hello","list":null}` || string(spec.ScanConfig) != `{"count":3}` || spec.AnalysisConfig != nil {
		t.Fatalf("configs %s %s %s", spec.TaskConfig, spec.ScanConfig, spec.AnalysisConfig)
	}
	if spec.RunID != "local" || spec.Entry != "main.py" || spec.Processes != 1 || spec.TimeoutMs != 300000 || spec.Limit != 5 ||
		spec.Backoff.InitialMs != 5000 || spec.MaxAnalysesPerProcess != 1000 || spec.DataSources.Tranco != DefaultTrancoURL ||
		spec.OutDir != "/scantor/out" || spec.Limits.MaxFilesPerAnalysis != 100 || spec.Debug || spec.TotalTimeoutMs != nil {
		t.Fatalf("spec %+v", spec)
	}

	// With an analysis config, schedule is skipped and the scan config is not required.
	opts.timeout, opts.debug = 0, true
	spec, err = devSpec(out, buildResult(t), opts, devConfigs{analysis: json.RawMessage(`{}`)}, cfg)
	if err != nil || string(spec.AnalysisConfig) != `{"n":0}` || string(spec.ScanConfig) != `{}` || !spec.Debug {
		t.Fatalf("spec %+v err %v", spec, err)
	}

	// Config errors are listed and fail with a validation error.
	errOut := &bytes.Buffer{}
	out.Err = errOut
	_, err = devSpec(out, buildResult(t), opts, devConfigs{task: json.RawMessage(`{"greeting":5}`)}, cfg)
	if ExitCode(err) != 2 || !strings.Contains(errOut.String(), "[config] taskConfig /greeting") || !strings.Contains(err.Error(), "(and 1 more)") {
		t.Fatalf("err %v\n%s", err, errOut)
	}

	// Uploads are not supported locally.
	_, err = devSpec(out, buildResult(t), opts, devConfigs{task: json.RawMessage(`{"list":"u1"}`), scan: json.RawMessage(`{"count":1}`)}, cfg)
	if ExitCode(err) != 2 || !strings.Contains(err.Error(), "taskConfig /list references an upload") {
		t.Fatalf("err %v", err)
	}
}

func TestDevPrinterLocal(t *testing.T) {
	events := []string{
		`{"type":"start","at":"2026-10-21T09:10:01.020Z","runtimeVersion":"1.4.0","language":"python","protocolVersion":1,"connector":{"language":"python","version":"1.4.0"},"schedule":{"kind":"template","template":"single"},"limit":5,"processes":1}`,
		`{"type":"scheduled","at":"2026-10-21T09:10:01.030Z","seq":0,"config":{}}`,
		`{"type":"log","at":"2026-10-21T09:10:01.035Z","seq":0,"attempt":1,"stream":"stderr","text":"[info] greeting Hi"}`,
		`{"type":"attempt","at":"2026-10-21T09:10:01.040Z","seq":1,"attempt":1,"error":{"type":"taskError","message":"boom","retryable":true,"phase":"run","attempt":1,"at":"2026-10-21T09:10:01.040Z"},"nextAttemptAt":"2026-10-21T09:10:03.040Z"}`,
		`{"type":"result","at":"2026-10-21T09:10:01.071Z","seq":0,"status":"succeeded","attempt":1,"config":{},"result":{"text":"Hi"},"error":null,"files":[{"id":"f1","name":"a.txt","size":3,"sha256":"x","contentType":"text/plain","path":"files/0/f1/a.txt"}],"logTail":"","attempts":[],"timings":{"scheduledAt":null,"startedAt":null,"finishedAt":null,"durationMs":40}}`,
		`{"type":"error","at":"2026-10-21T09:10:01.080Z","error":{"type":"validation","message":"bad scan config","retryable":false,"phase":"schedule","attempt":1,"at":"2026-10-21T09:10:01.080Z"}}`,
		`{"type":"end","at":"2026-10-21T09:10:01.090Z","reason":"done","summary":{"analyses":1,"succeeded":1,"failed":0},"exitCode":0}`,
	}
	app, out, _ := testApp(nil)
	p := newDevPrinter(app, "/tmp/out")
	for _, e := range events {
		p.localLine([]byte(e))
	}
	want := "started: python connector 1.4.0, schedule template single, limit 5, 1 process(es)\n" +
		"[#0] scheduled {}\n" +
		"[#0] stderr: [info] greeting Hi\n" +
		"[#1] attempt 1 failed: taskError: boom; retrying\n" +
		"[#0] succeeded (attempt 1, 40ms): {\"text\":\"Hi\"}\n" +
		"    file a.txt (3 B) → " + filepath.Join("/tmp/out", "files", "0", "f1", "a.txt") + "\n" +
		"error: validation: bad scan config\n" +
		"done (done): 1 analyses, 1 succeeded, 0 failed\n"
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}

	// JSON mode passes the runtime's events through, one compact object per line.
	app, out, _ = testApp(nil)
	app.format = string(FormatJSON)
	p = newDevPrinter(app, "/tmp/out")
	p.localLine([]byte("{\"type\": \"end\",\n \"reason\":\"done\"}"))
	p.localLine([]byte("garbage"))
	if out.String() != "{\"type\":\"end\",\"reason\":\"done\"}\n" {
		t.Fatalf("json output %q", out)
	}
}

func TestDevLocalOutcome(t *testing.T) {
	app, _, _ := testApp(nil)
	ended := func() *devPrinter {
		p := newDevPrinter(app, "x")
		p.ended = &taskpipe.LocalEvent{Type: "end"}
		return p
	}
	if err := ended().localOutcome(taskpipe.LocalResult{}); err != nil {
		t.Fatal(err)
	}
	for code := int64(1); code <= 3; code++ {
		err := ended().localOutcome(taskpipe.LocalResult{ExitCode: code})
		if ExitCode(err) != int(code) || !isSilent(err) {
			t.Errorf("exit %d: %v", code, err)
		}
	}
	if err := ended().localOutcome(taskpipe.LocalResult{Interrupted: true, ExitCode: 3}); !errors.Is(err, errInterrupted) {
		t.Errorf("interrupt: %v", err)
	}
	p := newDevPrinter(app, "x")
	p.runtimeStderr([]byte("panic: runtime crashed"))
	err := p.localOutcome(taskpipe.LocalResult{ExitCode: 137})
	if ExitCode(err) != 3 || !strings.Contains(err.Error(), "panic: runtime crashed") {
		t.Errorf("crash without end: %v", err)
	}
}
