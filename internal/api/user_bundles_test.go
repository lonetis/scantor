package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func bundleExample(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("testdata/examples.json")
	if err != nil {
		t.Fatal(err)
	}
	var examples map[string]json.RawMessage
	if err := json.Unmarshal(data, &examples); err != nil {
		t.Fatal(err)
	}
	return string(examples["Bundle"])
}

func TestBundleRequests(t *testing.T) {
	type seen struct {
		method, path, query, body string
	}
	example := bundleExample(t)
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = append(got, seen{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, string(body)})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Query().Get("rebuild") == "true":
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"b2","revision":{"id":"r1","number":3,"ref":"echo@3"},"state":"queued","image":"localhost/scantor/echo:3","platform":{"os":"linux","arch":"amd64"},"bytes":null,"sha256":null,"scantorVersion":null,"error":null,"createdAt":"2026-11-20T09:00:00.000Z","startedAt":null,"finishedAt":null,"expiresAt":"2026-11-27T09:00:00.000Z","download":null,"commands":{"load":"l","run":"r","describe":"d"}}`)
		default:
			_, _ = io.WriteString(w, example)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	ctx := context.Background()

	b, err := c.CreateRevisionBundle(ctx, "echo", "3", false, 0)
	if err != nil || !b.Settled() || b.Download == nil || b.Download.FileName != "echo-3-linux-amd64.bundle.tar.gz" ||
		b.Bytes == nil || *b.Bytes != 61234567 || b.Revision.Ref != "echo@3" || b.Commands.Load == "" {
		t.Fatalf("create: %+v %v", b, err)
	}
	queued, err := c.CreateRevisionBundle(ctx, "echo", "latest", true, 60)
	if err != nil || queued.Settled() || queued.Download != nil || queued.Bytes != nil || queued.StartedAt != nil || queued.State != BundleQueued {
		t.Fatalf("rebuild: %+v %v", queued, err)
	}
	if _, err := c.GetRevisionBundle(ctx, "echo", "3", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetRevisionBundle(ctx, "my task", "c2a9e4b1/x", 30); err != nil {
		t.Fatal(err)
	}

	want := []seen{
		{"POST", "/api/tasks/echo/revisions/3/bundle", "", ""},
		{"POST", "/api/tasks/echo/revisions/latest/bundle", "rebuild=true&wait=60", ""},
		{"GET", "/api/tasks/echo/revisions/3/bundle", "", ""},
		{"GET", "/api/tasks/my%20task/revisions/c2a9e4b1%2Fx/bundle", "wait=30", ""},
	}
	if len(got) != len(want) {
		t.Fatalf("requests = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestBundleErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"code":"notFound","message":"bundle not found"}}`)
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":{"code":"bundleUnsupported","message":"privileged revisions cannot be bundled","details":{"reason":"privileged"}}}`)
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	ctx := context.Background()

	if _, err := c.GetRevisionBundle(ctx, "echo", "3", 0); !IsCode(err, CodeNotFound) || !IsStatus(err, http.StatusNotFound) {
		t.Fatalf("get: %v", err)
	}
	_, err := c.CreateRevisionBundle(ctx, "echo", "3", false, 0)
	e, ok := AsError(err)
	if !ok || e.Code != CodeBundleUnsupported || e.ExitClass() != ExitValidation {
		t.Fatalf("create: %v", err)
	}
	var details struct {
		Reason string `json:"reason"`
	}
	if err := e.DecodeDetails(&details); err != nil || details.Reason != "privileged" {
		t.Fatalf("details %+v %v", details, err)
	}
}

func TestBundleSettled(t *testing.T) {
	for state, settled := range map[string]bool{BundleQueued: false, BundleRunning: false, BundleReady: true, BundleFailed: true} {
		if (Bundle{State: state}).Settled() != settled {
			t.Errorf("%s: settled %v", state, !settled)
		}
	}
}

func TestBundleNeedsUserKey(t *testing.T) {
	c, err := New(Options{BaseURL: "http://127.0.0.1:1", Credential: Credential{Kind: PrincipalUser}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetRevisionBundle(context.Background(), "echo", "3", 0); err == nil {
		t.Fatal("a call without a token was sent")
	}
}
