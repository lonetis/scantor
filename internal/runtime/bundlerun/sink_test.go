package bundlerun

import (
	"encoding/json"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/local"
)

// newTestSink prepares a run in a fresh work directory and opens its sink; clock replaces Options.Now.
func newTestSink(t *testing.T, flags Flags, json bool, clock ...func() time.Time) (*sink, *Options, *syncBuffer, *syncBuffer) {
	t.Helper()
	o := prepareOptions(t, rangeSchedule, flags)
	stdout, stderr := &syncBuffer{}, &syncBuffer{}
	o.Stdout, o.Stderr, o.JSON = stdout, stderr, json
	if len(clock) > 0 {
		o.Now = clock[0]
	}
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	if err := createOutDir(p.outDir, p.owner); err != nil {
		t.Fatal(err)
	}
	s, err := newSink(&o, p, newConsole(&o, p))
	if err != nil {
		t.Fatal(err)
	}
	return s, &o, stdout, stderr
}

func now() api.Time { return api.NewTime(testNow) }

func result(seq int64, status, logTail string) local.ResultEvent {
	ev := local.ResultEvent{
		Type: local.EventResult, At: now(), Seq: seq, Status: status, Attempt: 1,
		Config: json.RawMessage(`{"item":"a","secret":"hunter2"}`), Files: []local.File{}, LogTail: logTail,
		Attempts: []local.Attempt{{Attempt: 1, LogTail: "earlier"}},
	}
	if status == "succeeded" {
		ev.Result = json.RawMessage(`{"text":"private","n":1}`)
	} else {
		ev.Error = &api.ScantorError{Type: api.ErrorTaskError, Message: "boom\nstack", At: now()}
	}
	return ev
}

func TestSinkWritesResultsAndRunInfo(t *testing.T) {
	for _, tc := range []struct {
		logTails       string
		okTail, noTail bool
	}{{"", false, false}, {LogTailsAll, true, false}, {LogTailsNone, false, true}} {
		s, o, stdout, _ := newTestSink(t, Flags{LogTails: tc.logTails, TaskConfig: `{"token":"t0ken"}`, ScanConfig: `{"end":2}`}, false)
		s.Emit(local.StartEvent{Type: local.EventStart, At: now(), Schedule: api.Schedule{Kind: "template", Template: "range"}, Processes: 1})
		s.Emit(local.ResolvedEvent{Type: local.EventResolved, At: now(), Key: "schedule", Template: "range", ScanConfig: json.RawMessage(`{"end":2,"password":"pw"}`), Provenance: json.RawMessage(`{}`)})
		s.Emit(local.ScheduledEvent{Type: local.EventScheduled, At: now(), Seq: 0, Config: json.RawMessage(`{"secret":"x"}`)})
		s.Emit(result(0, "succeeded", "ok tail"))
		s.Emit(result(1, "failed", "failed tail"))
		s.Emit(local.EndEvent{Type: local.EventEnd, At: now(), Reason: local.ReasonDone, Summary: local.Summary{Analyses: 2, Succeeded: 1, Failed: 1}, ExitCode: 1})
		if code := s.close(1); code != 1 {
			t.Fatalf("close: %d", code)
		}
		dir := s.dir
		lines := readLines(t, dir)
		if len(lines) != 2 {
			t.Fatalf("%d lines", len(lines))
		}
		ok, failed := lines[0], lines[1]
		if _, has := ok["type"]; has || ok["result"].(map[string]any)["text"] != "***" || ok["result"].(map[string]any)["n"] != float64(1) {
			t.Fatalf("succeeded line %v", ok)
		}
		if ok["config"].(map[string]any)["secret"] != "***" || failed["config"].(map[string]any)["secret"] != "***" || failed["result"] != nil {
			t.Fatalf("config masking %v %v", ok, failed)
		}
		if (ok["logTail"] == "ok tail") != tc.okTail || (failed["logTail"] == "") != tc.noTail {
			t.Fatalf("log tails %q: %q %q", tc.logTails, ok["logTail"], failed["logTail"])
		}
		if failed["attempts"].([]any)[0].(map[string]any)["logTail"] != "earlier" {
			t.Fatalf("attempt log tail dropped: %v", failed["attempts"])
		}
		info := readRunInfo(t, dir)
		if *info.Reason != local.ReasonDone || *info.ExitCode != 1 || info.Summary != (local.Summary{Analyses: 2, Succeeded: 1, Failed: 1}) || info.FinishedAt == nil {
			t.Fatalf("run.json %+v", info)
		}
		if compact(t, info.Resolved["schedule"].ScanConfig) != `{"end":2,"password":"***"}` || compact(t, info.TaskConfig) != `{"greeting":"Hello","token":"***"}` {
			t.Fatalf("run.json masking %s %s", info.Resolved["schedule"].ScanConfig, info.TaskConfig)
		}
		if info.Uploads == nil || info.Bundle.Ref != o.Info.Ref || info.ScantorVersion == "" || !info.StartedAt.Equal(testNow) {
			t.Fatalf("run.json %+v", info)
		}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				t.Fatalf("temporary file left: %s", e.Name())
			}
		}
		if out := stdout.String(); !strings.Contains(out, "#1 failed (taskError, attempt 1): boom\n") || strings.Contains(out, "stack") {
			t.Fatalf("stdout %s", out)
		}
	}
}

// run.json is rewritten periodically while the run is running, with the summary so far and no end yet.
func TestSinkRewritesRunInfo(t *testing.T) {
	interval := runFileInterval
	runFileInterval = 20 * time.Millisecond
	t.Cleanup(func() { runFileInterval = interval })
	s, _, _, _ := newTestSink(t, Flags{}, false)
	if info := readRunInfo(t, s.dir); info.Reason != nil || info.ExitCode != nil || info.Summary.Analyses != 0 {
		t.Fatalf("initial run.json %+v", info)
	}
	s.Emit(result(0, "succeeded", ""))
	deadline := time.Now().Add(5 * time.Second)
	for readRunInfo(t, s.dir).Summary.Analyses != 1 {
		if time.Now().After(deadline) {
			t.Fatal("run.json was not rewritten")
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.close(0)
}

// A write error of results.jsonl closes Failed, and the run ends with exit 3.
func TestSinkWriteFailure(t *testing.T) {
	s, _, _, stderr := newTestSink(t, Flags{}, false)
	_ = s.results.Close() // the next write fails
	s.Emit(result(0, "succeeded", ""))
	select {
	case <-s.Failed():
	default:
		t.Fatal("Failed is open after a write error")
	}
	if s.Err() == nil {
		t.Fatal("no error")
	}
	if code := s.close(0); code != local.ExitPlatform {
		t.Fatalf("close: %d", code)
	}
	if !strings.Contains(stderr.String(), "error: write results.jsonl") {
		t.Fatalf("stderr %s", stderr)
	}
}

func TestSinkJSONConsole(t *testing.T) {
	s, _, stdout, _ := newTestSink(t, Flags{}, true)
	s.Emit(local.ScheduledEvent{Type: local.EventScheduled, At: now(), Seq: 0, Config: json.RawMessage(`{"secret":"x"}`)})
	s.Emit(local.LogEvent{Type: local.EventLog, At: now(), Stream: "stderr", Text: "connector line"})
	s.Emit(result(0, "succeeded", "tail"))
	s.Emit(local.EndEvent{Type: local.EventEnd, At: now(), Reason: local.ReasonDone, Summary: local.Summary{Analyses: 1, Succeeded: 1}})
	s.close(0)
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 4 || strings.Contains(stdout.String(), `"x"`) || strings.Contains(stdout.String(), "private") {
		t.Fatalf("stdout %s", stdout)
	}
	var res map[string]any
	if err := json.Unmarshal([]byte(lines[2]), &res); err != nil || res["type"] != "result" || res["logTail"] != "tail" {
		t.Fatalf("result event %s", lines[2])
	}
}

func TestConsoleProgress(t *testing.T) {
	interval := progressInterval
	progressInterval = 20 * time.Millisecond
	t.Cleanup(func() { progressInterval = interval })
	var elapsed atomic.Int64
	s, _, stdout, stderr := newTestSink(t, Flags{Limit: 4}, false, func() time.Time { return testNow.Add(time.Duration(elapsed.Load())) })
	s.Emit(local.ResolvedEvent{Type: local.EventResolved, At: now(), Key: "schedule", Template: "range", ScanConfig: json.RawMessage(`{}`), Provenance: json.RawMessage(`{}`), ExpectedTotal: ptr(int64(10))})
	s.Emit(local.ScheduledEvent{Type: local.EventScheduled, At: now(), Seq: 0, Config: json.RawMessage(`{}`)})
	s.Emit(local.ScheduledEvent{Type: local.EventScheduled, At: now(), Seq: 1, Config: json.RawMessage(`{}`)})
	s.Emit(result(0, "succeeded", ""))
	s.Emit(local.LogEvent{Type: local.EventLog, At: now(), Stream: "stdout", Text: "outside \x1b[31manalyses"})
	elapsed.Store(int64(2 * time.Second))
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(stdout.String(), "[2s] 1 done (1 ok, 0 failed), 1 running, 0.5/s, 25% of 4") {
		if time.Now().After(deadline) {
			t.Fatalf("no progress line:\n%s", stdout)
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.close(0)
	if !strings.Contains(stderr.String(), `[connector stdout] outside \x1b[31manalyses`) {
		t.Fatalf("stderr %q", stderr)
	}
}

func ptr[T any](v T) *T { return &v }

func TestMask(t *testing.T) {
	cases := []struct {
		raw   string
		paths []string
		want  string
	}{
		{`{"token":"t","n":1}`, []string{"/token"}, `{"n":1,"token":"***"}`},
		{`{"token":null}`, []string{"/token"}, `{"token":null}`},
		{`{"keys":[{"v":"a"},{"v":"b"}],"m":{"x":{"v":1},"y":{"w":2}}}`, []string{"/keys/*/v", "/m/*/v"}, `{"keys":[{"v":"***"},{"v":"***"}],"m":{"x":{"v":"***"},"y":{"w":2}}}`},
		{`"whole"`, []string{""}, `"***"`},
		{`{"a":1}`, nil, `{"a":1}`},
		{`{"a":1}`, []string{"/missing"}, `{"a":1}`},
		{`not json`, []string{"/a"}, `not json`},
	}
	for _, tc := range cases {
		if got := string(mask(json.RawMessage(tc.raw), tc.paths)); got != tc.want {
			t.Errorf("mask(%s, %v) = %s, want %s", tc.raw, tc.paths, got, tc.want)
		}
	}
	if issues := maskedSecrets("taskConfig", json.RawMessage(`{"list":["***","x"]}`), []string{"/list/*"}); len(issues) != 1 || issues[0].Path != "/taskConfig/list/0" {
		t.Fatalf("masked secrets %v", issues)
	}
}
