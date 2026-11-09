package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScriptRequests(t *testing.T) {
	type seen struct {
		method, path, query, body, contentType string
	}
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = append(got, seen{r.Method, r.URL.Path, r.URL.RawQuery, string(body), r.Header.Get("Content-Type")})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/api/scripts/csp":
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"job":{"id":"j1","kind":"scriptDelete","state":"queued"}}`)
		case strings.HasSuffix(r.URL.Path, "/workspace/archive"):
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = io.WriteString(w, "tgz")
		case strings.HasSuffix(r.URL.Path, "/logs"):
			_, _ = io.WriteString(w, `{"lines":[{"line":3,"at":"2026-10-22T09:00:00.000Z","stream":"stdout","text":"hi"}],"firstLine":1,"nextLine":3,"complete":false}`)
		case strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = io.WriteString(w, `{"name":"a.csv","contentType":"text/csv","size":10,"sha256":"ab","offset":4,"length":6,"encoding":"utf8","content":"x","truncated":false,"nextOffset":null}`)
		case strings.Contains(r.URL.Path, "/outputs/"):
			_, _ = io.WriteString(w, `{"url":"http://s3/o","expiresAt":"2026-10-22T09:10:00.000Z","name":"a.csv","size":10,"sha256":"ab","contentType":"text/csv","inline":false}`)
		case strings.HasSuffix(r.URL.Path, "/source"):
			_, _ = io.WriteString(w, `{"url":"http://s3/s","expiresAt":"2026-10-22T09:10:00.000Z"}`)
		case r.URL.Path == "/api/scripts/upload":
			_, _ = io.WriteString(w, `{"script":{"id":"s1","name":"csp"},"created":true}`)
		case strings.HasSuffix(r.URL.Path, "/files") || strings.HasSuffix(r.URL.Path, "/files/content"):
			_, _ = io.WriteString(w, `{"written":["main.py"],"deleted":["old.py"],"workspace":{"packSha256":"ff"},"entries":[],"truncated":false}`)
		case r.URL.Path == "/api/scripts" && r.Method == http.MethodGet, strings.HasSuffix(r.URL.Path, "/runs") && r.Method == http.MethodGet:
			_, _ = io.WriteString(w, `{"items":[],"nextCursor":null}`)
		case strings.HasPrefix(r.URL.Path, "/api/script-runs/") || strings.HasSuffix(r.URL.Path, "/runs"):
			_, _ = io.WriteString(w, `{"id":"r1","state":"queued","scans":[],"logTail":[]}`)
		default:
			_, _ = io.WriteString(w, `{"id":"s1","name":"csp","recentRuns":[]}`)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	ctx := context.Background()
	limit, timeout := int64(100), int64(60000)
	cpus := 2.0

	if _, err := c.ListScripts(ctx, ListScriptsQuery{PageQuery: PageQuery{Limit: 5, Cursor: "c"}, Q: "csp", UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	script, err := c.CreateScript(ctx, CreateScript{Name: "csp", Description: "CSP report"})
	if err != nil || script.RecentRuns == nil || len(*script.RecentRuns) != 0 {
		t.Fatalf("create: %+v %v", script, err)
	}
	up, err := c.UploadScript(ctx, bytes.NewReader([]byte("pack")), UploadScriptOptions{Force: true})
	if err != nil || !up.Created || up.Script.Name != "csp" {
		t.Fatalf("upload: %+v %v", up, err)
	}
	if _, err := c.GetScript(ctx, "csp"); err != nil {
		t.Fatal(err)
	}
	job, err := c.DeleteScript(ctx, "csp")
	if err != nil || job.Kind != "scriptDelete" {
		t.Fatalf("delete: %+v %v", job, err)
	}
	archive, err := c.DownloadScriptWorkspace(ctx, "csp")
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := io.ReadAll(archive); string(data) != "tgz" {
		t.Fatalf("archive %q", data)
	}
	_ = archive.Close()
	if _, err := c.ListScriptFiles(ctx, "csp", "lib", false); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadScriptFile(ctx, "csp", "main.py"); err != nil {
		t.Fatal(err)
	}
	written, err := c.WriteScriptFiles(ctx, "csp", map[string]TaskFileData{"main.py": NewTaskFileData([]byte("x"))})
	if err != nil || written.Workspace.PackSHA256 != "ff" {
		t.Fatalf("write: %+v %v", written, err)
	}
	if _, err := c.DeleteScriptFile(ctx, "csp", "old.py", true); err != nil {
		t.Fatal(err)
	}
	run, err := c.StartScriptRun(ctx, "csp", StartScriptRun{
		Scans: []string{"s-1"}, Config: json.RawMessage(`{"minBytes":1}`), Secrets: map[string]string{"TOKEN": "v"},
		Settings: &ScriptRunSettingsInput{TimeoutMs: &timeout, Resources: &ScriptRunResourcesInput{CPUs: &cpus}, Limit: &limit},
	}, 30)
	if err != nil || run.LogTail == nil || run.Settled() {
		t.Fatalf("start: %+v %v", run, err)
	}
	if _, err := c.ListScriptRuns(ctx, "csp", PageQuery{Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetScriptRun(ctx, "r1", 60); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CancelScriptRun(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.RestartScriptRun(ctx, "r1", RestartScriptRun{Resume: true, Settings: &RestartScriptRunSettings{ClearLimit: true}}); err != nil {
		t.Fatal(err)
	}
	logs, err := c.GetScriptRunLogs(ctx, "r1", 2, 500)
	if err != nil || len(logs.Lines) != 1 || logs.NextLine != 3 {
		t.Fatalf("logs: %+v %v", logs, err)
	}
	if _, err := c.GetScriptRunLogs(ctx, "r1", 0, 0); err != nil {
		t.Fatal(err)
	}
	dl, err := c.GetScriptRunOutputDownload(ctx, "r1", "o1")
	if err != nil || dl.Size != 10 {
		t.Fatalf("output: %+v %v", dl, err)
	}
	content, err := c.ReadScriptRunOutput(ctx, "r1", "o1", 4, 6)
	if err != nil || content.Length != 6 || content.NextOffset != nil {
		t.Fatalf("content: %+v %v", content, err)
	}
	src, err := c.GetScriptRunSourceDownload(ctx, "r1")
	if err != nil || src.URL != "http://s3/s" {
		t.Fatalf("source: %+v %v", src, err)
	}

	want := []seen{
		{"GET", "/api/scripts", "cursor=c&limit=5&q=csp&userId=u1", "", ""},
		{"POST", "/api/scripts", "", `{"name":"csp","description":"CSP report"}`, "application/json"},
		{"POST", "/api/scripts/upload", "force=true", "pack", "application/gzip"},
		{"GET", "/api/scripts/csp", "", "", ""},
		{"DELETE", "/api/scripts/csp", "", "", ""},
		{"GET", "/api/scripts/csp/workspace/archive", "", "", ""},
		{"GET", "/api/scripts/csp/files", "path=lib&recursive=false", "", ""},
		{"GET", "/api/scripts/csp/files/content", "path=main.py", "", ""},
		{"PUT", "/api/scripts/csp/files", "", `{"files":{"main.py":"x"}}`, "application/json"},
		{"DELETE", "/api/scripts/csp/files", "path=old.py&recursive=true", "", ""},
		{"POST", "/api/scripts/csp/runs", "wait=30", `{"scans":["s-1"],"config":{"minBytes":1},"secrets":{"TOKEN":"v"},"settings":{"timeoutMs":60000,"resources":{"cpus":2},"limit":100}}`, "application/json"},
		{"GET", "/api/scripts/csp/runs", "limit=10", "", ""},
		{"GET", "/api/script-runs/r1", "wait=60", "", ""},
		{"POST", "/api/script-runs/r1/cancel", "", "", ""},
		{"POST", "/api/script-runs/r1/restart", "", `{"resume":true,"settings":{"limit":null}}`, "application/json"},
		{"GET", "/api/script-runs/r1/logs", "afterLine=2&limit=500", "", ""},
		{"GET", "/api/script-runs/r1/logs", "", "", ""},
		{"GET", "/api/script-runs/r1/outputs/o1", "redirect=false", "", ""},
		{"GET", "/api/script-runs/r1/outputs/o1/content", "length=6&offset=4", "", ""},
		{"GET", "/api/script-runs/r1/source", "redirect=false", "", ""},
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

func TestRestartScriptRunSettingsJSON(t *testing.T) {
	limit, timeout := int64(5), int64(2000)
	for _, tc := range []struct {
		in   RestartScriptRunSettings
		want string
	}{
		{RestartScriptRunSettings{}, `{}`},
		{RestartScriptRunSettings{Limit: &limit}, `{"limit":5}`},
		{RestartScriptRunSettings{ClearLimit: true, Limit: &limit}, `{"limit":null}`},
		{RestartScriptRunSettings{TimeoutMs: &timeout}, `{"timeoutMs":2000}`},
	} {
		b, err := json.Marshal(tc.in)
		if err != nil || string(b) != tc.want {
			t.Errorf("%+v: %s %v, want %s", tc.in, b, err, tc.want)
			continue
		}
		var back RestartScriptRunSettings
		if err := json.Unmarshal(b, &back); err != nil {
			t.Fatal(err)
		}
		if again, _ := json.Marshal(back); string(again) != tc.want {
			t.Errorf("round trip of %s = %s", tc.want, again)
		}
	}
	if err := json.Unmarshal([]byte(`{"limit":"x"}`), new(RestartScriptRunSettings)); err == nil {
		t.Error("a string limit was accepted")
	}
}

func TestListScansSearch(t *testing.T) {
	var query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[]}`)
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	if _, err := c.ListScans(context.Background(), ListScansQuery{Q: "tranco"}); err != nil || query != "q=tranco" {
		t.Fatalf("query %q, %v", query, err)
	}
}
