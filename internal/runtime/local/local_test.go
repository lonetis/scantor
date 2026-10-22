package local

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

type event map[string]any

func (e event) str(k string) string { s, _ := e[k].(string); return s }

func baseSpec(t *testing.T) *Spec {
	return &Spec{
		V: 1, RunID: "local", Entry: "main.py", TaskConfig: json.RawMessage(`{}`), ScanConfig: json.RawMessage(`{}`),
		Limit: 5, Processes: 1, TimeoutMs: 10000, MaxAttempts: 1, MaxAnalysesPerProcess: 100,
		Limits: SpecLimits{MaxAnalysisConfigBytes: 1 << 16, MaxResultBytes: 1 << 20, MaxFileBytes: 1 << 20, MaxFilesPerAnalysis: 10, LogTailBytes: 32 << 10, LogTailEarlierBytes: 4 << 10},
		OutDir: t.TempDir(),
	}
}

// runLocal runs local mode with the fake connector in mode and the schedule kind schedule.
func runLocal(t *testing.T, spec *Spec, mode, schedule string) (int, []event) {
	t.Helper()
	argv, extra := fakeconn.Command(mode)
	environ := append(os.Environ(), extra...)
	if schedule != "" {
		environ = append(environ, fakeconn.EnvSchedule+"="+schedule)
	}
	cfg := runtime.Config{
		Language: "python", ConnectorCmd: strconv.Quote(argv[0]) + " " + argv[1], DebugPort: "5678",
		WorkRoot: filepath.Join(t.TempDir(), "scantor"), Environ: environ,
	}
	var out bytes.Buffer
	code := Run(context.Background(), Options{Spec: spec, Config: cfg, Stdout: &out, Stderr: os.Stderr, TaskDir: t.TempDir()})
	var events []event
	sc := bufio.NewScanner(&out)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var e event
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("invalid event line %q: %v", sc.Text(), err)
		}
		events = append(events, e)
	}
	if len(events) == 0 || events[len(events)-1].str("type") != EventEnd {
		t.Fatalf("the last event is not end: %v", events)
	}
	if got := events[len(events)-1]["exitCode"]; got != float64(code) {
		t.Fatalf("end exitCode %v, process exit code %d", got, code)
	}
	return code, events
}

func byType(events []event, typ string) []event {
	var out []event
	for _, e := range events {
		if e.str("type") == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestAnalysisConfigRun(t *testing.T) {
	spec := baseSpec(t)
	spec.AnalysisConfig = json.RawMessage(`{"mode":"log","name":"x"}`)
	code, events := runLocal(t, spec, "ok", "")
	if code != 0 {
		t.Fatalf("exit %d: %v", code, events)
	}
	start := byType(events, EventStart)
	if len(start) != 1 || start[0].str("language") != "python" || start[0]["protocolVersion"] != float64(1) || start[0]["schedule"].(map[string]any)["template"] != "single" {
		t.Fatalf("start %v", start)
	}
	if _, ok := start[0]["debugPort"]; ok {
		t.Fatal("debugPort outside debug mode")
	}
	results := byType(events, EventResult)
	if len(results) != 1 || results[0].str("status") != "succeeded" || results[0]["result"].(map[string]any)["text"] != "Hello, x!" {
		t.Fatalf("results %v", results)
	}
	if !strings.Contains(results[0].str("logTail"), "[info] hello n=1 s=x") {
		t.Fatalf("log tail %q", results[0].str("logTail"))
	}
	var attributed bool
	for _, l := range byType(events, EventLog) {
		if l["seq"] == float64(0) && l["attempt"] == float64(1) && l.str("stream") == "stderr" && strings.HasPrefix(l.str("text"), "[info] hello") {
			attributed = true
		}
	}
	if !attributed {
		t.Fatalf("no attributed ctx.log line: %v", byType(events, EventLog))
	}
	end := events[len(events)-1]
	if end.str("reason") != ReasonDone || end["summary"].(map[string]any)["succeeded"] != float64(1) {
		t.Fatalf("end %v", end)
	}
}

func TestCustomScheduleWithLimit(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"count":4}`)
	spec.Limit = 2
	spec.Processes = 2
	code, events := runLocal(t, spec, "ok", "custom")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if n := len(byType(events, EventScheduled)); n != 2 {
		t.Fatalf("%d scheduled", n)
	}
	if n := len(byType(events, EventResult)); n != 2 {
		t.Fatalf("%d results", n)
	}
	if events[len(events)-1].str("reason") != ReasonLimit {
		t.Fatalf("end %v", events[len(events)-1])
	}

	spec = baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"count":2}`)
	spec.Limit = 2
	if _, events := runLocal(t, spec, "ok", "custom"); events[len(events)-1].str("reason") != ReasonDone {
		t.Fatalf("a stream of exactly limit items: %v", events[len(events)-1])
	}
}

func TestNativeTemplateEmitsResolved(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"end":3}`)
	code, events := runLocal(t, spec, "ok", "range")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	resolved := byType(events, EventResolved)
	if len(resolved) != 1 || resolved[0].str("key") != "schedule" || resolved[0].str("template") != "range" || resolved[0]["expectedTotal"] != float64(3) {
		t.Fatalf("resolved %v", resolved)
	}
	if n := len(byType(events, EventResult)); n != 3 {
		t.Fatalf("%d results", n)
	}
}

func TestRetriesAndFailures(t *testing.T) {
	spec := baseSpec(t)
	spec.AnalysisConfig = json.RawMessage(`{"mode":"throw"}`)
	spec.MaxAttempts = 2
	code, events := runLocal(t, spec, "ok", "")
	if code != ExitFailures {
		t.Fatalf("exit %d", code)
	}
	attempts := byType(events, EventAttempt)
	if len(attempts) != 1 || attempts[0]["attempt"] != float64(1) || attempts[0].str("nextAttemptAt") == "" {
		t.Fatalf("attempts %v", attempts)
	}
	res := byType(events, EventResult)[0]
	errObj := res["error"].(map[string]any)
	if res.str("status") != "failed" || res["attempt"] != float64(2) || errObj["type"] != "taskError" || len(res["attempts"].([]any)) != 1 {
		t.Fatalf("result %v", res)
	}
	if _, ok := errObj["at"].(string); !ok {
		t.Fatalf("error.at is not an ISO string: %v", errObj)
	}

	spec = baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"count":5,"fatalAt":2}`)
	code, events = runLocal(t, spec, "ok", "custom")
	if code != ExitFailures || events[len(events)-1].str("reason") != ReasonScheduleFailed || len(byType(events, EventResult)) != 2 {
		t.Fatalf("schedule failure: exit %d, %v", code, events[len(events)-1])
	}
	if e := byType(events, EventError)[0]["error"].(map[string]any); e["type"] != "fatal" || e["phase"] != "schedule" {
		t.Fatalf("error %v", e)
	}
}

func TestFilesAreWrittenToOutDir(t *testing.T) {
	spec := baseSpec(t)
	spec.AnalysisConfig = json.RawMessage(`{"mode":"file","files":[{"name":"shot é.png","content":"abc"}]}`)
	code, events := runLocal(t, spec, "ok", "")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	files := byType(events, EventResult)[0]["files"].([]any)
	f := files[0].(map[string]any)
	if !strings.HasPrefix(f["path"].(string), "files/0/") || !strings.HasSuffix(f["path"].(string), "/shot__.png") {
		t.Fatalf("file %v", f)
	}
	data, err := os.ReadFile(filepath.Join(spec.OutDir, f["path"].(string)))
	if err != nil || string(data) != "abc" {
		t.Fatalf("written file %q %v", data, err)
	}
}

func TestTotalTimeout(t *testing.T) {
	spec := baseSpec(t)
	spec.AnalysisConfig = json.RawMessage(`{"mode":"sleepUncooperative","sleepMs":30000}`)
	spec.TotalTimeoutMs = 500
	code, events := runLocal(t, spec, "ok", "")
	if code != ExitPlatform || events[len(events)-1].str("reason") != ReasonTimeout {
		t.Fatalf("exit %d %v", code, events[len(events)-1])
	}
	res := byType(events, EventResult)
	if len(res) != 1 || res[0]["error"].(map[string]any)["type"] != "cancelled" {
		t.Fatalf("result %v", res)
	}
}

func TestStartFailure(t *testing.T) {
	spec := baseSpec(t)
	code, events := runLocal(t, spec, "importerror", "")
	if code != ExitValidation || events[len(events)-1].str("reason") != ReasonStartFailed {
		t.Fatalf("exit %d %v", code, events)
	}
	e := byType(events, EventError)[0]["error"].(map[string]any)
	if e["type"] != "taskError" || !strings.Contains(e["message"].(string), "boom at import") {
		t.Fatalf("error %v", e)
	}
}

func TestParseSpec(t *testing.T) {
	ok := `{"v":1,"runId":"r","entry":"main.py","taskConfig":{},"scanConfig":{},"limit":5,"timeoutMs":1000,"maxAttempts":1,"backoff":{"initialMs":1,"factor":2,"maxMs":10,"jitter":false},"maxAnalysesPerProcess":1,"limits":{"logTailBytes":10,"logTailEarlierBytes":5}}`
	s, err := ParseSpec([]byte(ok))
	if err != nil || s.Processes != 1 || s.OutDir != DefaultOutDir || s.HasAnalysisConfig() {
		t.Fatalf("%+v %v", s, err)
	}
	for _, bad := range []string{`{}`, strings.Replace(ok, `"v":1`, `"v":2`, 1), strings.Replace(ok, `"scanConfig":{},`, ``, 1), strings.Replace(ok, `"limit":5`, `"limit":0`, 1)} {
		if _, err := ParseSpec([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	s, err = ParseSpec([]byte(strings.Replace(ok, `"scanConfig":{}`, `"scanConfig":null,"analysisConfig":{"a":1},"debug":true,"processes":4`, 1)))
	if err != nil || !s.HasAnalysisConfig() || s.Processes != 1 {
		t.Fatalf("analysis config spec %+v %v", s, err)
	}
}

func TestSafeName(t *testing.T) {
	cases := map[string]string{
		"shot.png": "shot.png", "a b/c": "a_b_c", "": "_", ".": "_", "..": "__", "é": "_", "é": "_",
		"😀.txt": "__.txt", strings.Repeat("x", 200): strings.Repeat("x", 128),
	}
	for in, want := range cases {
		if got := SafeName(in); got != want {
			t.Errorf("SafeName(%q) = %q, want %q", in, got, want)
		}
	}
}
