package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func TestAPIScansStartRequest(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scans", 201, apiScanFixture("creating", 0, 0, nil))
	cfg := filepath.Join(t.TempDir(), "task.json")
	if err := os.WriteFile(cfg, []byte(`{"greeting": "Hi"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := f.execIn(`{"limit": 10}`, "scans", "start", "echo@3", "--name", "nightly",
		"--task-config", "@"+cfg, "--scan-config", "-", "--settings", `{"timeoutMs": 60000, "workers": 2}`, "--workers", "4", "--confirm")
	if code != 0 || !strings.Contains(out, "started scan "+apiScanID) || !strings.Contains(out, "scantor scans watch "+apiScanID) {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans").Body, `{"revision":"echo@3","name":"nightly","taskConfig":{"greeting":"Hi"},"scanConfig":{"limit":10},"settings":{"workers":4,"timeoutMs":60000},"confirm":true}`)

	code, out, _ = f.exec("scans", "start", "--revision", "echo", "-o", "json")
	if code != 0 || apiDecode[api.Scan](t, []byte(out)).ID != apiScanID {
		t.Fatalf("json: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans").Body, `{"revision":"echo"}`)

	// Nested settings stay partial: nothing left out is sent as a zero value or null.
	code, _, errOut = f.exec("scans", "start", "echo", "--settings",
		`{"nodeSelector": {"pool": "remote"}, "resources": {"cpus": 0.5}, "backoff": {"jitter": false}}`)
	if code != 0 {
		t.Fatalf("nested settings: exit %d, err %q", code, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans").Body, `{"revision":"echo","settings":{"nodeSelector":{"pool":"remote"},"resources":{"cpus":0.5},"backoff":{"jitter":false}}}`)
	code, _, errOut = f.exec("scans", "start", "echo", "--settings", `{"nodeSelector": {"labels": {}}}`)
	if code != 0 {
		t.Fatalf("empty labels: exit %d, err %q", code, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans").Body, `{"revision":"echo","settings":{"nodeSelector":{"labels":{}}}}`)

	before := f.count()
	for name, args := range map[string][]string{
		"no revision":       {"scans", "start"},
		"two revisions":     {"scans", "start", "a@1", "--revision", "b@1"},
		"invalid json":      {"scans", "start", "a@1", "--task-config", "{nope"},
		"not an object":     {"scans", "start", "a@1", "--scan-config", "[1]"},
		"unknown setting":   {"scans", "start", "a@1", "--settings", `{"privileged": true}`},
		"zero workers":      {"scans", "start", "a@1", "--workers", "0"},
		"missing file":      {"scans", "start", "a@1", "--task-config", "@/does/not/exist.json"},
		"stdin used twice":  {"scans", "start", "a@1", "--task-config", "-", "--scan-config", "-"},
		"negative timeout":  {"scans", "start", "a@1", "--wait", "--timeout", "-1s"},
		"bad flag":          {"scans", "start", "a@1", "--bogus"},
		"too many args":     {"scans", "start", "a@1", "b@1"},
		"scale without arg": {"scans", "scale", apiScanID},
	} {
		if code, _, errOut := f.execIn("{}", args...); code != ExitValidation {
			t.Errorf("%s: exit %d, stderr %q", name, code, errOut)
		}
	}
	if f.count() != before {
		t.Fatal("invalid invocations sent requests")
	}

	f.fail("POST", "/api/scans", 422, "confirmationRequired", "the scan has an estimated 2000000 analyses", map[string]any{"expectedTotal": 2000000, "threshold": 1000000})
	code, _, errOut = f.exec("scans", "start", "origins@1")
	if code != ExitValidation || !strings.Contains(errOut, "re-run with --confirm") {
		t.Fatalf("confirmation: exit %d, stderr %q", code, errOut)
	}
	f.fail("POST", "/api/scans", 503, "brokerAlarm", "RabbitMQ memory alarm", nil)
	if code, _, _ := f.exec("scans", "start", "origins@1"); code != ExitPlatform {
		t.Fatalf("broker alarm: exit %d", code)
	}
}

func TestAPIScansWaitOutcome(t *testing.T) {
	cases := []struct {
		name  string
		scan  map[string]any
		code  int
		match string
	}{
		{"clean", apiScanFixture("completed", 5, 0, nil), 0, ""},
		{"failed analyses", apiScanFixture("completed", 5, 2, nil), ExitAnalysisFailures, "2 failed and 0 lost"},
		{"failed scan", apiScanFixture("failed", 0, 0, map[string]any{"scheduling": map[string]any{"state": "failed", "confirmed": 0, "epoch": 1, "restarts": 0, "resolved": map[string]any{}, "error": map[string]any{"type": "validation", "message": "schedule() is not deterministic", "retryable": false, "phase": "schedule", "attempt": 1, "at": "2026-10-21T10:00:00.000Z"}}}), ExitAnalysisFailures, "not deterministic"},
		{"cancelled", apiScanFixture("cancelled", 1, 0, nil), ExitAnalysisFailures, "cancelled"},
		{"breaker", apiScanFixture("paused", 1, 9, map[string]any{"stateReason": map[string]any{"code": "failureRate"}}), ExitAnalysisFailures, "circuit breaker"},
		{"user pause", apiScanFixture("paused", 1, 0, map[string]any{"stateReason": map[string]any{"code": "user"}}), 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAPIFake(t)
			f.reply("POST", "/api/scans", 201, apiScanFixture("creating", 0, 0, nil))
			f.sequence("GET", "/api/scans/"+apiScanID, apiScanFixture("running", 0, 0, nil), tc.scan)
			code, out, errOut := f.exec("scans", "start", "echo@3", "--wait", "-o", "json")
			if code != tc.code || !strings.Contains(errOut, tc.match) {
				t.Fatalf("exit %d (want %d), stderr %q", code, tc.code, errOut)
			}
			if got := apiDecode[api.Scan](t, []byte(out)); got.State != tc.scan["state"] {
				t.Fatalf("printed scan state %s", got.State)
			}
			if calls := f.calls("GET", "/api/scans/"+apiScanID); len(calls) != 2 || calls[0].Query.Get("wait") != "120" {
				t.Fatalf("long-polls = %+v", calls)
			}
			// get --wait applies the same mapping; get without --wait never does.
			if code, _, _ := f.exec("scans", "get", apiScanID, "--wait"); code != tc.code {
				t.Fatalf("get --wait: exit %d", code)
			}
			if code, _, _ := f.exec("scans", "get", apiScanID); code != 0 {
				t.Fatalf("get: exit %d", code)
			}
		})
	}
}

func TestAPIScansGetHuman(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/scans/"+apiScanID, 200, apiScanFixture("running", 40, 2, map[string]any{
		"conditions": []any{map[string]any{"type": "workersPending", "severity": "warning", "reason": "noNodes", "message": "no node can run the worker", "since": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z"}},
	}))
	code, out, _ := f.exec("scans", "get", apiScanID)
	for _, want := range []string{"echo@3", "running", "42/42 (100.0%)", "succeeded 40 · failed 2", "workersPending (warning, noNodes)", "workers 1 · processes 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestAPIScansWatch(t *testing.T) {
	running := func(n int64) map[string]any { return apiScanFixture("running", n, 0, nil) }
	f := newAPIFake(t)
	f.sequence("GET", "/api/scans/"+apiScanID, running(1), running(1), running(3), apiScanFixture("completed", 4, 1, nil))

	code, out, errOut := f.exec("scans", "watch", apiScanID, "--interval", "500ms")
	if code != ExitAnalysisFailures || !strings.Contains(errOut, "1 failed") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	// Three distinct states (the repeated one is not printed) and the final summary.
	if len(lines) != 4 || !strings.HasPrefix(lines[0], "running") || !strings.Contains(lines[2], "completed") || !strings.Contains(lines[3], "scan "+apiScanID+" completed") {
		t.Fatalf("watch output:\n%s", out)
	}
	if q := f.last("GET", "/api/scans/"+apiScanID).Query; q.Get("wait") != "" {
		t.Fatalf("watch must not long-poll: %v", q)
	}

	f = newAPIFake(t)
	f.sequence("GET", "/api/scans/"+apiScanID, running(1), apiScanFixture("completed", 5, 0, nil))
	code, out, errOut = f.exec("scans", "watch", apiScanID, "--interval", "500ms", "-o", "json")
	lines = strings.Split(strings.TrimSpace(out), "\n")
	if code != 0 || len(lines) != 2 || errOut != "" {
		t.Fatalf("json: exit %d, out %q, err %q", code, out, errOut)
	}
	for _, line := range lines {
		apiDecode[api.Scan](t, []byte(line))
	}

	if code, _, _ := f.exec("scans", "watch", apiScanID, "--interval", "10ms"); code != ExitValidation {
		t.Fatalf("interval too small: exit %d", code)
	}

	// A user pause keeps the watch going; the circuit breaker ends it with exit 1.
	paused := func(reason string) map[string]any {
		return apiScanFixture("paused", 1, 9, map[string]any{"stateReason": map[string]any{"code": reason}})
	}
	f = newAPIFake(t)
	f.sequence("GET", "/api/scans/"+apiScanID, paused("user"), running(2), paused("failureRate"))
	code, out, errOut = f.exec("scans", "watch", apiScanID, "--interval", "500ms")
	if code != ExitAnalysisFailures || !strings.Contains(errOut, "circuit breaker") || len(f.calls("GET", "/api/scans/"+apiScanID)) != 3 {
		t.Fatalf("breaker: exit %d, out %q, err %q", code, out, errOut)
	}

	f = newAPIFake(t)
	f.reply("GET", "/api/scans/"+apiScanID, 200, running(1))
	if code, _, errOut := f.exec("scans", "watch", apiScanID, "--interval", "500ms", "--timeout", "600ms"); code != ExitPlatform || !strings.Contains(errOut, "timed out") {
		t.Fatalf("timeout: exit %d, %q", code, errOut)
	}
}

func TestAPIScansLifecycle(t *testing.T) {
	f := newAPIFake(t)
	for _, action := range []string{"pause", "resume", "cancel"} {
		f.reply("POST", "/api/scans/"+apiScanID+"/"+action, 200, apiScanFixture("paused", 0, 0, nil))
		code, out, errOut := f.exec("scans", action, apiScanID)
		if code != 0 || !strings.Contains(out, "scan "+apiScanID+" is paused") {
			t.Fatalf("%s: exit %d, out %q, err %q", action, code, out, errOut)
		}
		if body := f.last("POST", "/api/scans/"+apiScanID+"/"+action).Body; len(body) != 0 {
			t.Fatalf("%s sent a body: %s", action, body)
		}
	}
	f.fail("POST", "/api/scans/"+apiScanID+"/pause", 409, "invalidState", "scan is completed; pause requires running", map[string]any{"state": "completed", "allowed": []string{"running"}})
	code, _, errOut := f.exec("scans", "pause", apiScanID, "-o", "json")
	if code != ExitValidation || !strings.Contains(errOut, `"code":"invalidState"`) {
		t.Fatalf("invalid state: exit %d, stderr %q", code, errOut)
	}

	f.reply("POST", "/api/scans/"+apiScanID+"/scale", 200, apiScanFixture("running", 0, 0, nil))
	if code, _, _ := f.exec("scans", "scale", apiScanID, "--processes", "4"); code != 0 {
		t.Fatalf("scale: exit %d", code)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans/"+apiScanID+"/scale").Body, `{"processes":4}`)

	f.reply("POST", "/api/scans/"+apiScanID+"/restart", 201, apiScanFixture("creating", 0, 0, nil))
	if code, _, _ := f.exec("scans", "restart", apiScanID, "--name", "again", "--workers", "2"); code != 0 {
		t.Fatalf("restart: exit %d", code)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans/"+apiScanID+"/restart").Body, `{"name":"again","settings":{"workers":2}}`)

	jobRef := map[string]any{"id": "job-2", "kind": "scanRetryFailed", "state": "queued"}
	f.reply("POST", "/api/scans/"+apiScanID+"/retry-failed", 202, map[string]any{"scan": apiScanFixture("running", 0, 0, map[string]any{"round": 2}), "job": jobRef})
	code, out, _ := f.exec("scans", "retry-failed", apiScanID)
	if code != 0 || !strings.Contains(out, "round 2 (job job-2)") {
		t.Fatalf("retry-failed: exit %d, out %q", code, out)
	}
	f.fail("POST", "/api/scans/"+apiScanID+"/retry-failed", 409, "nothingToRetry", "no failed analyses", nil)
	if code, _, _ := f.exec("scans", "retry-failed", apiScanID); code != ExitValidation {
		t.Fatalf("nothing to retry: exit %d", code)
	}

	f.reply("DELETE", "/api/scans/"+apiScanID, 202, map[string]any{"scan": apiScanFixture("deleting", 0, 0, nil), "job": map[string]any{"id": "job-3", "kind": "scanDelete", "state": "queued"}})
	code, out, _ = f.exec("scans", "delete", apiScanID, "-o", "json")
	if code != 0 || apiDecode[api.ScanJob](t, []byte(out)).Job.ID != "job-3" {
		t.Fatalf("delete: exit %d, out %q", code, out)
	}
}

func TestAPIScansOperatorViews(t *testing.T) {
	f := newAPIFake(t)
	base := "/api/scans/" + apiScanID
	f.reply("GET", base+"/inflight", 200, map[string]any{"items": []any{map[string]any{"analysisId": apiScanID + "-7", "seq": 7, "round": 1, "attempt": 2, "startedAt": "2026-10-21T10:00:00.000Z", "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a", "progress": map[string]any{"pct": 50}}, map[string]any{"analysisId": apiScanID + "-8", "seq": 8, "round": 1, "attempt": 1, "startedAt": "2026-10-21T10:00:00.000Z", "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a", "progress": map[string]any{"fraction": 0.6667, "message": "4 of 6 s"}}}, "updatedAt": nil})
	f.reply("GET", base+"/conditions", 200, map[string]any{"items": []any{map[string]any{"type": "crashLoop", "severity": "error", "reason": "exit", "message": "worker exits 1", "since": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z"}}})
	f.reply("GET", base+"/events", 200, map[string]any{"items": []any{map[string]any{"id": "e1", "at": "2026-10-21T10:00:00.000Z", "type": "scan.created", "level": "info", "userId": nil, "message": "scan created"}}, "nextCursor": nil})
	f.reply("GET", base+"/workers", 200, map[string]any{"items": []any{map[string]any{"id": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "userId": "u", "scanId": apiScanID, "role": "runner", "nodeId": nil, "epoch": 0, "state": "pending", "stateReason": map[string]any{"code": "noNodes"}, "spec": map[string]any{"repository": "r", "digest": "d", "resources": map[string]any{"cpus": 1, "memoryMiB": 512}, "privileged": false, "dindMode": nil}, "processes": map[string]any{"desired": 2, "assigned": 0, "applied": 0, "running": 0}, "container": nil, "runtime": nil, "logs": nil, "node": nil, "scan": nil, "createdAt": "2026-10-21T10:00:00.000Z", "assignedAt": nil, "startedAt": nil, "stoppedAt": nil, "updatedAt": "2026-10-21T10:00:00.000Z"}}, "nextCursor": nil})
	f.reply("GET", base+"/workers/w1/logs", 200, map[string]any{"text": "line 1\nline 2", "collectedAt": "2026-10-21T10:00:00.000Z", "requestedAt": nil, "pending": true, "truncated": false})

	checks := []struct {
		args []string
		want string
	}{
		{[]string{"scans", "inflight", apiScanID}, `{"pct":50}`},
		{[]string{"scans", "inflight", apiScanID}, "67% 4 of 6 s"},
		{[]string{"scans", "conditions", apiScanID}, "crashLoop"},
		{[]string{"scans", "events", apiScanID, "--type", "scan.created"}, "scan created"},
		{[]string{"scans", "workers", apiScanID, "--state", "pending,assigned"}, "pending (noNodes)"},
		{[]string{"scans", "worker", "logs", apiScanID, "w1", "--max-wait", "5s", "--tail-bytes", "1024"}, "line 1\nline 2\n"},
	}
	for _, c := range checks {
		code, out, errOut := f.exec(c.args...)
		if code != 0 || !strings.Contains(out, c.want) {
			t.Errorf("%v: exit %d, out %q, err %q", c.args, code, out, errOut)
		}
	}
	if q := f.last("GET", base+"/events").Query; q.Get("type") != "scan.created" {
		t.Errorf("events query %v", q)
	}
	if q := f.last("GET", base+"/workers").Query; q.Get("state") != "pending,assigned" {
		t.Errorf("workers query %v", q)
	}
	if q := f.last("GET", base+"/workers/w1/logs").Query; q.Get("wait") != "5" || q.Get("tailBytes") != "1024" {
		t.Errorf("logs query %v", q)
	}
	_, _, errOut := f.exec("scans", "worker", "logs", apiScanID, "w1")
	if !strings.Contains(errOut, "has not sent a fresh tail") {
		t.Errorf("pending warning missing: %q", errOut)
	}
	if code, _, _ := f.exec("scans", "worker", "logs", apiScanID, "w1", "--max-wait", "1m"); code != ExitValidation {
		t.Errorf("max-wait above 30s: exit %d", code)
	}
}

// Temporary failures during a wait are retried; permanent ones end it.
func TestAPIWaitRetriesTemporaryErrors(t *testing.T) {
	f := newAPIFake(t)
	calls := 0
	f.on("GET", "/api/scans/"+apiScanID, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			apiFakeError(w, http.StatusServiceUnavailable, "unavailable", "mongo down", nil)
			return
		}
		apiFakeJSON(w, http.StatusOK, apiScanFixture("completed", 1, 0, nil))
	})
	if code, _, errOut := f.exec("scans", "get", apiScanID, "--wait"); code != 0 || calls != 2 {
		t.Fatalf("exit %d after %d calls: %s", code, calls, errOut)
	}
	f.fail("GET", "/api/scans/"+apiScanID, 404, "notFound", "scan not found", nil)
	if code, _, _ := f.exec("scans", "get", apiScanID, "--wait"); code != ExitValidation {
		t.Fatalf("not found: exit %d", code)
	}
}

func TestAPISplitRevisionRef(t *testing.T) {
	for ref, want := range map[string][2]string{"echo@3": {"echo", "3"}, "echo": {"echo", "latest"}, "echo@latest": {"echo", "latest"}} {
		task, rev, err := apiSplitRevisionRef(ref)
		if err != nil || task != want[0] || rev != want[1] {
			t.Errorf("%s → %s %s %v", ref, task, rev, err)
		}
	}
	for _, bad := range []string{"", "@3", "echo@", "a@b@c"} {
		if _, _, err := apiSplitRevisionRef(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The JSON of a scan in watch mode is one compact object per line.
func TestAPIScanProgressLine(t *testing.T) {
	var scan api.Scan
	raw, _ := json.Marshal(apiScanFixture("paused", 3, 1, map[string]any{"stateReason": map[string]any{"code": "failureRate"}}))
	if err := json.Unmarshal(raw, &scan); err != nil {
		t.Fatal(err)
	}
	line := apiScanProgressLine(&scan)
	if !strings.HasPrefix(line, "paused (failureRate) 4/4 (100.0%)") || !strings.Contains(line, "failed 1") {
		t.Fatalf("line = %q", line)
	}
}
