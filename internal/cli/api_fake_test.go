package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func init() {
	// The fake answers long-polls at once; do not slow the wait tests down to one poll per second.
	apiPollMinInterval = 10 * time.Millisecond
}

// apiTestToken is a well-formed user API key for the fake orchestrator.
const apiTestToken = "sk_scantor_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl"

// apiFake is an httptest orchestrator: tests register handlers per "METHOD /path" (exact path) and
// inspect the recorded requests. Unregistered routes answer 404 with the error envelope.
type apiFake struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	handlers map[string]http.HandlerFunc
	requests []apiFakeRequest
}

type apiFakeRequest struct {
	Method string
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte
}

func newAPIFake(t *testing.T) *apiFake {
	t.Helper()
	f := &apiFake{t: t, handlers: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		key := r.Method + " " + r.URL.Path
		f.mu.Lock()
		f.requests = append(f.requests, apiFakeRequest{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Header: r.Header.Clone(), Body: body})
		h := f.handlers[key]
		f.mu.Unlock()
		if h == nil {
			apiFakeError(w, http.StatusNotFound, "notFound", "no fake route "+key, nil)
			return
		}
		h(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// on registers a handler.
func (f *apiFake) on(method, path string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handlers[method+" "+path] = h
}

// reply registers a JSON response.
func (f *apiFake) reply(method, path string, status int, body any) {
	f.on(method, path, func(w http.ResponseWriter, _ *http.Request) { apiFakeJSON(w, status, body) })
}

// sequence registers JSON responses served in order; the last one repeats.
func (f *apiFake) sequence(method, path string, bodies ...any) {
	var mu sync.Mutex
	i := 0
	f.on(method, path, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		body := bodies[min(i, len(bodies)-1)]
		i++
		mu.Unlock()
		apiFakeJSON(w, http.StatusOK, body)
	})
}

// fail registers an error envelope response.
func (f *apiFake) fail(method, path string, status int, code, message string, details any) {
	f.on(method, path, func(w http.ResponseWriter, _ *http.Request) { apiFakeError(w, status, code, message, details) })
}

// calls returns the recorded requests of one route.
func (f *apiFake) calls(method, path string) []apiFakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []apiFakeRequest
	for _, r := range f.requests {
		if r.Method == method && r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

// last returns the last request of a route and fails the test when there is none.
func (f *apiFake) last(method, path string) apiFakeRequest {
	f.t.Helper()
	calls := f.calls(method, path)
	if len(calls) == 0 {
		f.t.Fatalf("no request %s %s", method, path)
	}
	return calls[len(calls)-1]
}

// count returns the number of requests received.
func (f *apiFake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

// exec runs the CLI against the fake and returns exit code, stdout and stderr.
func (f *apiFake) exec(args ...string) (int, string, string) {
	return f.execIn("", args...)
}

// execIn runs the CLI with stdin.
func (f *apiFake) execIn(stdin string, args ...string) (int, string, string) {
	app, out, errOut := testApp(map[string]string{"SCANTOR_URL": f.srv.URL, "SCANTOR_TOKEN": apiTestToken})
	app.Stdin = strings.NewReader(stdin)
	code := run(app, args...)
	return code, out.String(), errOut.String()
}

func apiFakeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func apiFakeError(w http.ResponseWriter, status int, code, message string, details any) {
	env := map[string]any{"code": code, "message": message}
	if details != nil {
		env["details"] = details
	}
	apiFakeJSON(w, status, map[string]any{"error": env})
}

// apiDecode unmarshals JSON or fails the test.
func apiDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("decode %q: %v", data, err)
	}
	return v
}

// apiJSONEqual compares two JSON documents structurally.
func apiJSONEqual(t *testing.T, got []byte, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("decode %q: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("decode want %q: %v", want, err)
	}
	gb, _ := json.Marshal(g)
	wb, _ := json.Marshal(w)
	if !bytes.Equal(gb, wb) {
		t.Fatalf("JSON differs\n got  %s\n want %s", gb, wb)
	}
}

// Shared fixtures (minimal but complete enough for the human renderers).

func apiTaskFixture(name string) map[string]any {
	return map[string]any{
		"id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", "name": name,
		"language": "python", "source": map[string]any{"kind": "scaffold", "template": "single"},
		"workspace":           map[string]any{"packSha256": "a3f19c", "fileCount": 9, "bytes": 14336, "dirty": true, "lastSyncSha256": nil, "checkedAt": "2026-10-21T09:00:00.000Z"},
		"revisionCount":       3,
		"latestRevision":      map[string]any{"id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "number": 3, "state": "ready", "packSha256": "a3f19c", "createdAt": "2026-10-21T09:01:00.000Z"},
		"latestReadyRevision": nil, "privileged": false,
		"createdAt": "2026-10-21T08:30:00.000Z", "updatedAt": "2026-10-21T09:02:10.000Z",
	}
}

const apiScanID = "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f"

func apiScanFixture(state string, succeeded, failed int64, extra map[string]any) map[string]any {
	scan := map[string]any{
		"id": apiScanID, "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", "name": "test scan",
		"task":     map[string]any{"id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "name": "echo"},
		"revision": map[string]any{"id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "number": 3, "ref": "echo@3", "platform": map[string]any{"os": "linux", "arch": "amd64"}, "privileged": false, "schedule": map[string]any{"kind": "template", "template": "single"}},
		"state":    state, "stateReason": nil, "taskConfig": map[string]any{}, "scanConfig": map[string]any{},
		"secretPaths": map[string]any{"taskConfig": []string{}, "scanConfig": []string{}, "analysisConfig": []string{}, "result": []string{}},
		"uploadIds":   []string{},
		"settings":    map[string]any{"workers": 1, "processes": 1, "timeoutMs": 300000, "maxAttempts": 3, "backoff": map[string]any{"initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true}, "resources": map[string]any{"cpus": 1, "memoryMiB": 512}, "maxAnalysesPerProcess": 1000, "privileged": false},
		"round":       1,
		"scheduling":  map[string]any{"state": "done", "confirmed": succeeded + failed, "tailHash": nil, "epoch": 1, "restarts": 0, "resolved": map[string]any{}, "error": nil, "startedAt": nil, "checkpointAt": nil, "doneAt": nil},
		"stats":       map[string]any{"pending": 0, "retrying": 0, "succeeded": succeeded, "failed": failed, "lost": 0, "cancelled": 0, "expectedTotal": succeeded + failed, "ratePerMin": 0, "recountedAt": nil},
		"progress":    map[string]any{"scheduled": succeeded + failed, "terminal": succeeded + failed, "total": succeeded + failed, "percent": 100, "etaSeconds": nil},
		"workers":     map[string]any{"desired": 1, "active": 1, "pending": 0, "byState": map[string]any{"running": 1}},
		"conditions":  []any{}, "breaker": nil, "clonedFrom": nil,
		"createdAt": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:05:00.000Z",
		"startedAt": nil, "pausedAt": nil, "completedAt": nil, "deletedAt": nil,
	}
	for k, v := range extra {
		scan[k] = v
	}
	return scan
}
