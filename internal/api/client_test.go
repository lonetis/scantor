package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/version"
)

const (
	testAPIKey      = "sk_scantor_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl"
	testNodeToken   = "snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9"
	testWorkerToken = "swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o"
)

func newTestClient(t *testing.T, srv *httptest.Server, cred Credential) *Client {
	t.Helper()
	c, err := New(Options{BaseURL: srv.URL, Credential: cred, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCredentialValidation(t *testing.T) {
	for _, tc := range []struct {
		cred Credential
		ok   bool
	}{
		{Credential{PrincipalUser, testAPIKey}, true},
		{Credential{PrincipalUser, ""}, true},
		{Credential{PrincipalUser, "ghp_abc"}, false},
		{Credential{PrincipalNode, testNodeToken}, true},
		{Credential{PrincipalNode, "snt_short"}, false},
		{Credential{PrincipalWorker, testWorkerToken}, true},
		{Credential{PrincipalWorker, testNodeToken}, false},
	} {
		_, err := New(Options{BaseURL: "https://scantor.example.com", Credential: tc.cred, HTTPClient: http.DefaultClient})
		if (err == nil) != tc.ok {
			t.Errorf("New(%v, %q) error = %v, want ok=%v", tc.cred.Kind, tc.cred.Token, err, tc.ok)
		}
	}
	for _, base := range []string{"ftp://x", "scantor.example.com", "https://user:pw@x", "https://x?q=1"} {
		if _, err := New(Options{BaseURL: base, HTTPClient: http.DefaultClient}); err == nil {
			t.Errorf("New accepted base URL %q", base)
		}
	}
}

func TestHeadersPerPrincipal(t *testing.T) {
	var seen http.Header
	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		seenPath = r.URL.RawPath
		if seenPath == "" {
			seenPath = r.URL.Path
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/node/hello":
			_, _ = io.WriteString(w, `{"serverTime": 1, "node": {"id": "n", "name": "x", "builtIn": false, "endpointProfile": "public", "pool": "shared", "labels": {}}, "config": {}}`)
		default:
			_, _ = io.WriteString(w, `{}`)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	user := newTestClient(t, srv, Credential{PrincipalUser, testAPIKey})
	if _, err := user.GetTask(ctx, "echo@3/x"); err != nil {
		t.Fatal(err)
	}
	if seen.Get("Authorization") != "Bearer "+testAPIKey || !strings.HasPrefix(seen.Get("User-Agent"), "scantor-cli/") || seen.Get(HeaderVersion) != version.Version {
		t.Fatalf("user headers: %v", seen)
	}
	if seenPath != "/api/tasks/echo@3%2Fx" {
		t.Fatalf("path not escaped: %q", seenPath)
	}

	node := newTestClient(t, srv, Credential{PrincipalNode, testNodeToken})
	if _, _, err := node.NodeHello(ctx, NodeHelloRequest{InstanceID: "engine:nonce"}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(seen.Get("User-Agent"), "scantor-node/") || seen.Get(HeaderInstanceID) != "" {
		t.Fatalf("hello headers: %v", seen)
	}
	if _, _, err := node.PostNodeStatus(ctx, NodeStatusRequest{}); err != nil {
		t.Fatal(err)
	}
	if seen.Get(HeaderInstanceID) != "engine:nonce" || seen.Get("Authorization") != "Bearer "+testNodeToken {
		t.Fatalf("status headers: %v", seen)
	}
	if _, err := node.GetTask(ctx, "x"); err == nil {
		t.Fatal("node client called a user route without a user token")
	}

	worker := newTestClient(t, srv, Credential{PrincipalWorker, testWorkerToken})
	if _, _, err := worker.RuntimeState(ctx, RuntimeStateRequest{}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(seen.Get("User-Agent"), "scantor-runtime/") || seen.Get("Authorization") != "Bearer "+testWorkerToken {
		t.Fatalf("worker headers: %v", seen)
	}
	if _, _, err := worker.GetNodeAssignments(ctx, 0, 0); err == nil {
		t.Fatal("worker client called a node route")
	}

	anonymous := newTestClient(t, srv, Credential{PrincipalUser, ""})
	if _, err := anonymous.GetTask(ctx, "x"); !errors.Is(err, ErrNoToken) {
		t.Fatalf("missing token: %v", err)
	}
	if _, err := anonymous.GetHealth(ctx); err != nil {
		t.Fatalf("public route: %v", err)
	}
}

func TestErrorEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(HeaderRequestID, "req-1")
		switch r.URL.Path {
		case "/api/scans/s1/pause":
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error": {"code": "invalidState", "message": "scan is completed; pause requires running", "details": {"state": "completed", "allowed": ["running"]}}}`)
		case "/api/scans/s2":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, `<html>bad gateway</html>`)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error": {"code": "notFound", "message": "no such scan"}}`)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{PrincipalUser, testAPIKey})

	_, err := c.PauseScan(context.Background(), "s1")
	e, ok := AsError(err)
	if !ok || e.Code != CodeInvalidState || e.Status != 409 || e.RequestID != "req-1" || e.ExitClass() != ExitValidation {
		t.Fatalf("error = %#v", err)
	}
	var d InvalidStateDetails
	if err := e.DecodeDetails(&d); err != nil || d.State != "completed" || d.Allowed[0] != "running" {
		t.Fatalf("details: %+v %v", d, err)
	}
	if !IsCode(err, CodeInvalidState) || IsCode(err, CodeNotFound) {
		t.Fatal("IsCode")
	}

	_, err = c.GetScan(context.Background(), "s2", 0)
	e, ok = AsError(err)
	if !ok || e.Code != CodeUnavailable || e.ExitClass() != ExitPlatform || !Temporary(err) {
		t.Fatalf("proxy error = %#v", err)
	}
}

func TestRetries(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runtime/bootstrap":
			if calls.Add(1) < 3 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = io.WriteString(w, `{"serverTime": 5, "action": "run"}`)
		case "/api/runtime/scheduler/checkpoint":
			calls.Add(1)
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error": {"code": "staleEpoch", "message": "superseded", "details": {"currentEpoch": 2}}}`)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{PrincipalWorker, testWorkerToken})
	fast := &RetryPolicy{Initial: time.Millisecond, Max: 2 * time.Millisecond, Factor: 2}

	b, _, err := c.RuntimeBootstrap(context.Background(), fast)
	if err != nil || b.Action != ActionRun || calls.Load() != 3 {
		t.Fatalf("bootstrap: %v %v calls=%d", b, err, calls.Load())
	}

	calls.Store(0)
	_, err = c.SchedulerCheckpoint(context.Background(), SchedulerCheckpointRequest{Epoch: 1}, RetryUnlessStaleEpoch(fast))
	stale, epoch := IsStaleEpoch(err)
	if !stale || epoch != 2 || calls.Load() != 1 {
		t.Fatalf("stale epoch: %v %d calls=%d", err, epoch, calls.Load())
	}

	calls.Store(0)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	limited := &RetryPolicy{Initial: time.Millisecond, Factor: 1, MaxAttempts: 2}
	c2 := newTestClient(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})), Credential{PrincipalWorker, testWorkerToken})
	if _, _, err := c2.RuntimeBootstrap(ctx, limited); err == nil || calls.Load() != 2 {
		t.Fatalf("MaxAttempts: %v calls=%d", err, calls.Load())
	}
}

func TestRetryPolicyDelay(t *testing.T) {
	p := RetryPolicy{Initial: time.Second, Max: 60 * time.Second, Factor: 2, Jitter: JitterNone}
	for attempt, want := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 6: 32 * time.Second, 7: 60 * time.Second, 20: 60 * time.Second} {
		if got := p.Delay(attempt); got != want {
			t.Errorf("Delay(%d) = %v, want %v", attempt, got, want)
		}
	}
	p.Jitter = JitterFull
	for i := 0; i < 100; i++ {
		if d := p.Delay(3); d < 0 || d > 4*time.Second {
			t.Fatalf("full jitter out of range: %v", d)
		}
	}
}

func TestLongPoll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("wait") != "25" || r.URL.Query().Get("rev") != "41" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set(HeaderWait, WaitTimeout)
		_ = json.NewEncoder(w).Encode(NodeAssignments{ServerTime: 7, Rev: 42})
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{PrincipalNode, testNodeToken})
	a, resp, err := c.GetNodeAssignments(context.Background(), 41, 25)
	if err != nil || a.Rev != 42 || resp.Wait != WaitTimeout {
		t.Fatalf("assignments: %+v %+v %v", a, resp, err)
	}
	if waitTimeout(25) <= 25*time.Second {
		t.Fatal("long-poll timeout must exceed the wait")
	}
}

func TestEventStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": keepalive\n\nevent: state\ndata: {\"state\":\"running\"}\n\nevent: log\ndata: {\"seq\":0,\ndata: \"x\"}\nid: 7\n\nevent: end\ndata: {}\n\n")
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{PrincipalUser, testAPIKey})
	s, err := c.StreamTestRun(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var names []string
	for {
		ev, err := s.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, ev.Name)
		if ev.Name == TestRunEventLog && (string(ev.Data) != "{\"seq\":0,\n\"x\"}" || ev.ID != "7") {
			t.Fatalf("multi-line data: %q id=%q", ev.Data, ev.ID)
		}
	}
	if strings.Join(names, ",") != "state,log,end" {
		t.Fatalf("events = %v", names)
	}
}

func TestOpenHeaderTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{PrincipalUser, testAPIKey})
	start := time.Now()
	_, _, err := c.Open(context.Background(), Request{Method: http.MethodGet, Path: "/api/x", Timeout: 50 * time.Millisecond})
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("Open did not time out: %v", err)
	}
}
