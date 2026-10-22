package taskpipe

import (
	"bufio"
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
)

// isoMillis is the event time format: ISO 8601 UTC with milliseconds.
var isoMillis = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func decodeEvents(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 1<<20), 32<<20)
	for sc.Scan() {
		var ev map[string]any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("line %q: %v", sc.Text(), err)
		}
		out = append(out, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestEmitterNDJSON(t *testing.T) {
	var buf bytes.Buffer
	e := NewEmitter(&buf, EventsNDJSON)
	e.now = func() time.Time { return time.Date(2026, 10, 21, 9, 1, 1, 10_500_000, time.FixedZone("CEST", 7200)) }
	e.Log(api.BuildPhasePack, StreamPipeline, LevelInfo, "packed 9 files\n")
	e.Log(api.BuildPhaseStatic, StreamPipeline, LevelWarning, "Dockerfile:7: CMD is ignored; the runtime is the entrypoint (W1)")
	e.Error(api.BuildError{Phase: api.BuildPhaseCheck, File: "main.py", Line: 14, Column: 12, Message: "bad <type> & more"})
	r := newResult()
	r.OK = false
	e.Result(api.BuildPhaseCheck, r)

	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	want := []string{
		`{"v":1,"seq":0,"at":"2026-10-21T07:01:01.010Z","phase":"pack","type":"log","stream":"pipeline","text":"packed 9 files"}`,
		`{"v":1,"seq":1,"at":"2026-10-21T07:01:01.010Z","phase":"static","type":"log","stream":"pipeline","level":"warning","text":"Dockerfile:7: CMD is ignored; the runtime is the entrypoint (W1)"}`,
		`{"v":1,"seq":2,"at":"2026-10-21T07:01:01.010Z","phase":"check","type":"error","error":{"phase":"check","file":"main.py","line":14,"column":12,"message":"bad <type> & more"}}`,
	}
	for i, w := range want {
		if lines[i] != w {
			t.Errorf("line %d:\n got  %s\n want %s", i, lines[i], w)
		}
	}
	var last map[string]any
	if err := json.Unmarshal([]byte(lines[3]), &last); err != nil {
		t.Fatal(err)
	}
	res := last["result"].(map[string]any)
	for _, key := range []string{"ok", "pack", "manifest", "settingsDefaults", "language", "privileged", "baseImage", "image", "description", "errors", "warnings", "durationsMs"} {
		if _, ok := res[key]; !ok {
			t.Errorf("result lacks %s", key)
		}
	}
	if res["errors"] == nil || res["warnings"] == nil || last["seq"].(float64) != 3 {
		t.Errorf("errors and warnings must be arrays, seq consecutive: %s", lines[3])
	}
}

func TestEmitterSplitsLongText(t *testing.T) {
	var buf bytes.Buffer
	e := NewEmitter(&buf, EventsNDJSON)
	text := strings.Repeat("é", MaxEventText) // 2 bytes per rune: 32 KiB
	e.Log(api.BuildPhaseBuild, StreamBuild, LevelInfo, text)
	events := decodeEvents(t, buf.Bytes())
	var joined strings.Builder
	for i, ev := range events {
		chunk := ev["text"].(string)
		if len(chunk) > MaxEventText || !utf8.ValidString(chunk) {
			t.Fatalf("chunk %d: %d bytes, valid %v", i, len(chunk), utf8.ValidString(chunk))
		}
		if int(ev["seq"].(float64)) != i || !isoMillis.MatchString(ev["at"].(string)) {
			t.Fatalf("event %d: %v", i, ev)
		}
		joined.WriteString(chunk)
	}
	if len(events) != 2 || joined.String() != text {
		t.Fatalf("%d chunks; joined text equal: %v", len(events), joined.String() == text)
	}
}

func TestEmitterTruncatesTheLog(t *testing.T) {
	var buf bytes.Buffer
	e := NewEmitter(&buf, EventsNDJSON)
	chunk := strings.Repeat("x", MaxEventText)
	for range MaxLogBytes/MaxEventText + 5 {
		e.Log(api.BuildPhaseBuild, StreamBuild, LevelInfo, chunk)
	}
	e.Error(api.BuildError{Phase: api.BuildPhaseBuild, Message: "kept"})
	e.Result(api.BuildPhaseBuild, newResult())
	events := decodeEvents(t, buf.Bytes())
	n := len(events)
	if n != MaxLogBytes/MaxEventText+3 {
		t.Fatalf("%d events, want the 10 MiB of log, one truncation event, the error and the result", n)
	}
	trunc := events[n-3]
	if trunc["level"] != "warning" || !strings.Contains(trunc["text"].(string), "truncated") {
		t.Fatalf("truncation event: %v", trunc)
	}
	if events[n-2]["type"] != "error" || events[n-1]["type"] != "result" {
		t.Fatal("errors and the result must survive truncation")
	}
}

func TestEmitterText(t *testing.T) {
	var buf bytes.Buffer
	e := NewEmitter(&buf, EventsText)
	e.Log(api.BuildPhaseBuild, StreamBuild, LevelInfo, "#6 [3/4] RUN pip install")
	e.Log(api.BuildPhaseStatic, StreamPipeline, LevelWarning, "no .dockerignore")
	e.Error(api.BuildError{Phase: api.BuildPhaseStatic, File: "Dockerfile", Line: 3, Message: "VOLUME is not allowed (D11)"})
	r := newResult()
	r.Errors = []api.BuildError{{Phase: api.BuildPhaseStatic, File: "Dockerfile", Line: 3, Message: "VOLUME is not allowed (D11)"}}
	e.Result(api.BuildPhaseStatic, r)
	want := "[build] #6 [3/4] RUN pip install\n" +
		"[static] warning: no .dockerignore\n" +
		"[static] error: Dockerfile:3: VOLUME is not allowed (D11)\n" +
		"[result] failed with 1 error(s)\n  [static] Dockerfile:3: VOLUME is not allowed (D11)\n"
	if buf.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", buf.String(), want)
	}
}

func TestTruncateMessage(t *testing.T) {
	long := strings.Repeat("ü", MaxErrorMessage)
	got := truncateMessage(long)
	if len(got) > MaxErrorMessage || !strings.HasSuffix(got, "...") || !utf8.ValidString(got) {
		t.Fatalf("truncated to %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if truncateMessage("short") != "short" {
		t.Fatal("short messages are kept")
	}
}

func TestParseEventFormat(t *testing.T) {
	for _, ok := range []string{"ndjson", "text"} {
		if _, err := ParseEventFormat(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	if _, err := ParseEventFormat("json"); err == nil {
		t.Error("json must be rejected")
	}
}

func TestResultExitCode(t *testing.T) {
	r := newResult()
	r.OK = true
	if r.ExitCode() != 0 {
		t.Fatal("ok → 0")
	}
	r.OK = false
	for phase, want := range map[api.BuildPhase]int{
		api.BuildPhasePack: 2, api.BuildPhaseStatic: 2, api.BuildPhaseBuild: 2, api.BuildPhaseDescribe: 2,
		api.BuildPhaseCheck: 2, api.BuildPhasePush: 3, api.BuildPhasePlatform: 3,
	} {
		r.Errors = []api.BuildError{{Phase: api.BuildPhaseStatic}, {Phase: phase}}
		if got := r.ExitCode(); got != want {
			t.Errorf("%s: exit %d, want %d", phase, got, want)
		}
	}
}
