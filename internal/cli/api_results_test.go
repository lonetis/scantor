package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func apiRevisionFixture(state string, errors []any) map[string]any {
	return map[string]any{
		"id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "userId": "u", "taskId": "t", "taskName": "echo", "number": 4, "ref": "echo@4",
		"state": state, "source": map[string]any{"kind": "workspace", "packSha256": "a3f1", "packBytes": 4211, "fileCount": 9},
		"image": nil, "description": nil, "privileged": false, "errors": errors,
		"createdAt": "2026-10-21T09:01:00.000Z", "updatedAt": "2026-10-21T09:01:00.000Z",
	}
}

func TestAPIRevisionsPublishAndGet(t *testing.T) {
	f := newAPIFake(t)
	revID := "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
	f.reply("POST", "/api/tasks/echo/revisions", 201, apiRevisionFixture("queued", []any{}))
	failed := apiRevisionFixture("failed", []any{map[string]any{"phase": "static", "file": "Dockerfile", "line": 3, "message": "COPY --from is not allowed"}})
	f.sequence("GET", "/api/tasks/echo/revisions/"+revID, apiRevisionFixture("building", []any{}), failed)

	code, out, errOut := f.exec("revisions", "publish", "echo", "-m", "first", "--wait")
	if code != ExitValidation || !strings.Contains(out, "[static] Dockerfile:3: COPY --from is not allowed") || !strings.Contains(errOut, "revision echo@4 failed") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/tasks/echo/revisions").Body, `{"message":"first"}`)
	if q := f.last("POST", "/api/tasks/echo/revisions").Query; q.Get("wait") != "" {
		t.Fatalf("publish must not hold the request: %v", q)
	}

	code, out, _ = f.exec("revisions", "publish", "echo", "-o", "json")
	if code != 0 || apiDecode[api.Revision](t, []byte(out)).State != "queued" {
		t.Fatalf("no wait: exit %d, out %q", code, out)
	}

	f.reply("GET", "/api/tasks/echo/revisions/latest", 200, apiRevisionFixture("ready", []any{}))
	if code, out, _ := f.exec("revisions", "get", "echo"); code != 0 || !strings.Contains(out, "echo@4") {
		t.Fatalf("get latest: exit %d, out %q", code, out)
	}
	f.reply("GET", "/api/tasks/echo/revisions/4", 200, failed)
	if code, _, _ := f.exec("revisions", "get", "echo@4"); code != 0 {
		t.Fatalf("get without wait never maps the state: exit %d", code)
	}
	if code, _, _ := f.exec("revisions", "get", "echo@4", "--wait"); code != ExitValidation {
		t.Fatalf("get --wait of a failed revision: exit %d", code)
	}
	// A bare uuid addresses a task's latest revision; a 404 explains how to pass a revision id.
	code, _, errOut = f.exec("revisions", "get", revID)
	if code != ExitValidation || !strings.Contains(errOut, "<task>@<revisionId>") || len(f.calls("GET", "/api/tasks/"+revID+"/revisions/latest")) != 1 {
		t.Fatalf("bare uuid: exit %d, err %q", code, errOut)
	}

	f.reply("GET", "/api/tasks/echo/revisions", 200, map[string]any{"items": []any{map[string]any{"id": revID, "number": 4, "ref": "echo@4", "state": "failed", "source": map[string]any{"kind": "upload", "packSha256": "a"}, "privileged": false, "errorsCount": 1, "createdAt": "2026-10-21T09:01:00.000Z", "finishedAt": nil}}, "nextCursor": nil})
	code, out, _ = f.exec("revisions", "list", "echo", "--state", "failed")
	if code != 0 || !strings.Contains(out, "echo@4") || f.last("GET", "/api/tasks/echo/revisions").Query.Get("state") != "failed" {
		t.Fatalf("list: exit %d, out %q", code, out)
	}
}

func TestAPIRevisionOutcome(t *testing.T) {
	cases := []struct {
		state  string
		phases []api.BuildPhase
		want   int
	}{
		{api.RevisionReady, nil, 0},
		{api.RevisionFailed, []api.BuildPhase{api.BuildPhaseStatic, api.BuildPhaseCheck}, ExitValidation},
		{api.RevisionFailed, []api.BuildPhase{api.BuildPhaseBuild, api.BuildPhasePush}, ExitPlatform},
		{api.RevisionFailed, []api.BuildPhase{api.BuildPhasePlatform}, ExitPlatform},
		{api.RevisionFailed, nil, ExitPlatform},
	}
	for _, tc := range cases {
		rev := &api.Revision{Ref: "echo@1", State: tc.state}
		for _, p := range tc.phases {
			rev.Errors = append(rev.Errors, api.BuildError{Phase: p, Message: "x"})
		}
		if got := ExitCode(apiRevisionOutcome(rev)); got != tc.want {
			t.Errorf("%s %v: exit %d, want %d", tc.state, tc.phases, got, tc.want)
		}
	}
}

func TestAPIRevisionsLogs(t *testing.T) {
	f := newAPIFake(t)
	var afterLines []string
	f.on("GET", "/api/tasks/echo/revisions/4/logs", func(w http.ResponseWriter, r *http.Request) {
		after := r.URL.Query().Get("afterLine")
		afterLines = append(afterLines, after)
		switch after {
		case "":
			apiFakeJSON(w, 200, map[string]any{"lines": []any{
				map[string]any{"line": 1, "at": "2026-10-21T09:01:01.010Z", "phase": "pack", "type": "log", "stream": "pipeline", "text": "packed 9 files"},
				map[string]any{"line": 2, "at": "2026-10-21T09:01:01.020Z", "phase": "static", "type": "log", "stream": "pipeline", "level": "warning", "text": "CMD is ignored"},
			}, "nextLine": 2, "complete": false})
		case "2":
			apiFakeJSON(w, 200, map[string]any{"lines": []any{
				map[string]any{"line": 3, "at": "2026-10-21T09:01:41.000Z", "phase": "check", "type": "error", "error": map[string]any{"phase": "check", "file": "main.py", "line": 14, "message": "bad type"}},
				map[string]any{"line": 4, "at": "2026-10-21T09:01:41.010Z", "phase": "check", "type": "result", "result": map[string]any{"ok": false, "errors": []any{map[string]any{}}}},
			}, "nextLine": 4, "complete": true})
		default:
			apiFakeJSON(w, 200, map[string]any{"lines": []any{}, "nextLine": 4, "complete": true})
		}
	})
	code, out, errOut := f.exec("revisions", "logs", "echo@4")
	want := []string{"pack     packed 9 files", "static   warning: CMD is ignored", "error    [check] main.py:14: bad type", "result   failed (1 error(s))"}
	if code != 0 || strings.TrimSpace(out) != strings.Join(want, "\n") {
		t.Fatalf("exit %d, out:\n%s\nerr %q", code, out, errOut)
	}
	if strings.Join(afterLines, ",") != ",2,4" {
		t.Fatalf("afterLine sequence %v", afterLines)
	}

	code, out, _ = f.exec("revisions", "logs", "echo@4", "--after-line", "2", "-o", "json")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if code != 0 || len(lines) != 2 || apiDecode[api.BuildLogLine](t, []byte(lines[1])).Type != "result" {
		t.Fatalf("ndjson: exit %d, out %q", code, out)
	}
}

func TestAPIAnalyses(t *testing.T) {
	f := newAPIFake(t)
	base := "/api/scans/" + apiScanID
	f.on("POST", base+"/analyses/query", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items": [{"seq": 1, "result": {"status": 500}}, {"seq": 2}], "nextCursor": "2"}`))
	})
	code, out, errOut := f.exec("analyses", "query", apiScanID, "--filter", `{"result.status": {"$gte": 500}}`, "--projection", `{"result.status": 1}`, "--limit", "2", "--after-seq", "0")
	if code != 0 || out != "{\"seq\":1,\"result\":{\"status\":500}}\n{\"seq\":2}\n" || !strings.Contains(errOut, "--after-seq 2") {
		t.Fatalf("query: exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", base+"/analyses/query").Body, `{"filter":{"result.status":{"$gte":500}},"projection":{"result.status":1},"limit":2,"afterSeq":0}`)
	if code, _, _ := f.exec("analyses", "query", apiScanID); code != 0 {
		t.Fatal("query without filter")
	}
	apiJSONEqual(t, f.last("POST", base+"/analyses/query").Body, `{"filter":{}}`)

	f.reply("POST", base+"/analyses/aggregate", 200, map[string]any{"items": []any{map[string]any{"_id": "failed", "n": 3}}, "truncated": true})
	code, out, errOut = f.exec("analyses", "aggregate", apiScanID, "--pipeline", `[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]`)
	if code != 0 || out != "{\"_id\":\"failed\",\"n\":3}\n" || !strings.Contains(errOut, "truncated") {
		t.Fatalf("aggregate: exit %d, out %q, err %q", code, out, errOut)
	}
	for _, bad := range []string{`{"$match": {}}`, `[1]`, ``} {
		if code, _, _ := f.exec("analyses", "aggregate", apiScanID, "--pipeline", bad); code != ExitValidation {
			t.Errorf("pipeline %q: exit %d", bad, code)
		}
	}
	f.fail("POST", base+"/analyses/aggregate", 400, "queryRejected", "$lookup is not allowed", map[string]any{"path": "/0/$lookup"})
	if code, _, _ := f.exec("analyses", "aggregate", apiScanID, "--pipeline", `[{"$lookup": {}}]`); code != ExitValidation {
		t.Errorf("rejected pipeline: exit %d", code)
	}

	f.reply("GET", base+"/analyses", 200, map[string]any{"items": []any{map[string]any{"id": apiScanID + "-0", "scanId": apiScanID, "userId": "u", "seq": 0, "round": 1, "status": "failed", "attempt": 3, "error": map[string]any{"type": "timeout", "message": "run exceeded 300000 ms", "retryable": true, "phase": "run", "attempt": 3, "at": "2026-10-21T10:00:00.000Z"}, "attempts": []any{}, "files": []any{}, "createdAt": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z"}}, "nextCursor": "0"})
	code, out, _ = f.exec("analyses", "list", apiScanID, "--status", "failed,lost", "--after-seq", "-1", "--fields", "seq,error", "--limit", "1000")
	q := f.last("GET", base+"/analyses").Query
	if code != 0 || !strings.Contains(out, "timeout: run exceeded") || q.Get("status") != "failed,lost" || q.Get("afterSeq") != "-1" || q.Get("fields") != "seq,error" || q.Get("limit") != "1000" {
		t.Fatalf("list: exit %d, out %q, query %v", code, out, q)
	}

	f.reply("GET", "/api/analyses/"+apiScanID+"-0", 200, map[string]any{"id": apiScanID + "-0", "scanId": apiScanID, "userId": "u", "seq": 0, "round": 1, "status": "succeeded", "attempt": 1, "config": map[string]any{"domain": "example.com"}, "result": map[string]any{"status": 200}, "attempts": []any{}, "files": []any{map[string]any{"id": "f1", "name": "shot.png", "size": 2048, "sha256": "x", "contentType": "image/png"}}, "logTail": "done", "createdAt": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z"})
	code, out, _ = f.exec("analyses", "get", apiScanID+"-0")
	for _, want := range []string{"succeeded", `"domain": "example.com"`, "shot.png", "log tail:\ndone\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("get: missing %q in %q", want, out)
		}
	}
	if code != 0 {
		t.Fatalf("get: exit %d", code)
	}
}

func TestAPIExportInline(t *testing.T) {
	f := newAPIFake(t)
	path := "/api/scans/" + apiScanID + "/export"
	f.on("GET", path, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv")
		_, _ = w.Write([]byte("id,seq\na,0\n"))
	})
	code, out, _ := f.exec("export", apiScanID, "--format", "csv", "--status", "succeeded", "--filter", `{"seq": {"$lt": 5}}`, "--fields", "id,seq", "--after-seq", "3")
	req := f.last("GET", path)
	if code != 0 || out != "id,seq\na,0\n" || req.Query.Get("format") != "csv" || req.Query.Get("status") != "succeeded" ||
		req.Query.Get("filter") != `{"seq": {"$lt": 5}}` || req.Query.Get("fields") != "id,seq" || req.Query.Get("afterSeq") != "3" || req.Header.Get("Accept") != "text/csv" {
		t.Fatalf("exit %d, out %q, request %+v", code, out, req)
	}

	target := filepath.Join(t.TempDir(), "out.csv")
	code, out, _ = f.exec("export", apiScanID, "--format", "csv", "--file", target, "-o", "json")
	saved := apiDecode[apiSavedFile](t, []byte(out))
	data, _ := os.ReadFile(target)
	if code != 0 || string(data) != "id,seq\na,0\n" || saved.Bytes != int64(len(data)) {
		t.Fatalf("file: exit %d, out %q, content %q", code, out, data)
	}
	if code, _, errOut := f.exec("export", apiScanID, "--file", target); code != ExitValidation || !strings.Contains(errOut, "--force") {
		t.Fatalf("existing file: exit %d, %q", code, errOut)
	}

	f.fail("GET", path, 409, "exportTooLarge", "the scan has 80000 analyses", nil)
	if code, _, errOut := f.exec("export", apiScanID); code != ExitValidation || !strings.Contains(errOut, "use --background") {
		t.Fatalf("too large: exit %d, %q", code, errOut)
	}
	for _, args := range [][]string{{"export", apiScanID, "--format", "xml"}, {"export", apiScanID, "--wait"}} {
		if code, _, _ := f.exec(args...); code != ExitValidation {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}

func TestAPIExportBackgroundDownload(t *testing.T) {
	f := newAPIFake(t)
	content := []byte("{\"seq\":0}\n{\"seq\":1}\n")
	f.on("GET", "/s3/exports/e1.jsonl", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	exportDoc := func(state string) map[string]any {
		doc := map[string]any{"id": "e1", "userId": "u", "scanId": apiScanID, "format": "jsonl", "filter": nil, "fields": nil, "afterSeq": nil,
			"state": state, "bytes": len(content), "rows": 2, "error": nil, "jobId": "j", "createdAt": "2026-10-21T10:00:00.000Z",
			"finishedAt": nil, "updatedAt": "2026-10-21T10:00:00.000Z", "expiresAt": "2026-10-28T10:00:00.000Z"}
		if state == "ready" {
			doc["download"] = map[string]any{"url": f.srv.URL + "/s3/exports/e1.jsonl?X-Amz-Signature=abc", "expiresAt": "2026-10-21T10:10:00.000Z"}
		}
		return doc
	}
	f.reply("POST", "/api/scans/"+apiScanID+"/exports", 201, exportDoc("queued"))
	f.sequence("GET", "/api/exports/e1", exportDoc("running"), exportDoc("ready"))

	target := filepath.Join(t.TempDir(), "results.jsonl")
	code, out, errOut := f.exec("export", apiScanID, "--background", "--status", "failed", "--filter", `{"seq": 1}`, "--file", target)
	if code != 0 || !strings.Contains(out, "saved "+target) {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/scans/"+apiScanID+"/exports").Body, `{"format":"jsonl","filter":{"$and":[{"seq":1},{"status":{"$in":["failed"]}}]}}`)
	if data, _ := os.ReadFile(target); string(data) != string(content) {
		t.Fatalf("downloaded %q", data)
	}
	if dl := f.last("GET", "/s3/exports/e1.jsonl"); dl.Header.Get("Authorization") != "" || dl.Query.Get("X-Amz-Signature") != "abc" {
		t.Fatalf("presigned request %+v", dl)
	}

	// Without --wait or --file the export is only created and printed.
	code, out, _ = f.exec("export", apiScanID, "--background", "-o", "json")
	if code != 0 || apiDecode[api.Export](t, []byte(out)).State != "queued" {
		t.Fatalf("background: exit %d, out %q", code, out)
	}

	failed := exportDoc("failed")
	failed["error"] = map[string]any{"code": "queryTimeout", "message": "query exceeded 30s"}
	f.reply("GET", "/api/exports/e2", 200, failed)
	if code, _, errOut := f.exec("exports", "get", "e2", "--wait"); code != ExitPlatform || !strings.Contains(errOut, "query exceeded 30s") {
		t.Fatalf("failed export: exit %d, %q", code, errOut)
	}
	f.reply("GET", "/api/exports", 200, map[string]any{"items": []any{exportDoc("ready")}, "nextCursor": nil})
	if code, out, _ := f.exec("exports", "list", "--scan", apiScanID); code != 0 || !strings.Contains(out, "e1") || f.last("GET", "/api/exports").Query.Get("scanId") != apiScanID {
		t.Fatalf("list: exit %d, out %q", code, out)
	}
	f.on("DELETE", "/api/exports/e1", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	if code, out, _ := f.exec("exports", "delete", "e1", "-o", "json"); code != 0 || !strings.Contains(out, `"deleted": true`) {
		t.Fatalf("delete: exit %d, out %q", code, out)
	}
}

func TestAPIFilesGet(t *testing.T) {
	f := newAPIFake(t)
	content := []byte("PNG-bytes")
	sum := sha256.Sum256(content)
	analysis := apiScanID + "-3"
	f.on("GET", "/s3/files/f1", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(content) })
	download := func(name, digest string) map[string]any {
		return map[string]any{"url": f.srv.URL + "/s3/files/f1", "expiresAt": "2026-10-21T10:10:00.000Z", "name": name, "size": len(content), "sha256": digest, "contentType": "image/png", "inline": true}
	}
	f.reply("GET", "/api/analyses/"+analysis+"/files/f1", 200, download("../../shot.png", hex.EncodeToString(sum[:])))

	dir := t.TempDir()
	t.Chdir(dir)
	code, out, errOut := f.exec("files", "get", analysis, "f1")
	if code != 0 || !strings.Contains(out, "saved shot.png") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	if q := f.last("GET", "/api/analyses/"+analysis+"/files/f1").Query; q.Get("redirect") != "false" {
		t.Fatalf("query %v", q)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "shot.png")); err != nil || string(data) != string(content) {
		t.Fatalf("file: %q %v", data, err)
	}
	if code, _, _ := f.exec("files", "get", analysis, "f1"); code != ExitValidation {
		t.Fatalf("overwrite without --force: exit %d", code)
	}
	if code, _, _ := f.exec("files", "get", analysis, "f1", "--force"); code != 0 {
		t.Fatalf("overwrite with --force: exit %d", code)
	}
	if code, out, _ := f.exec("files", "get", analysis, "f1", "--file", "-"); code != 0 || out != string(content) {
		t.Fatalf("stdout: exit %d, out %q", code, out)
	}

	f.reply("GET", "/api/analyses/"+analysis+"/files/f1", 200, download("other.png", strings.Repeat("0", 64)))
	code, _, errOut = f.exec("files", "get", analysis, "f1")
	if code != ExitPlatform || !strings.Contains(errOut, "SHA-256") {
		t.Fatalf("corrupt: exit %d, %q", code, errOut)
	}
	if _, err := os.Stat(filepath.Join(dir, "other.png")); !os.IsNotExist(err) {
		t.Fatal("a corrupt download left a file behind")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".scantor-download-") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

func TestAPIPresignedRequestInContainer(t *testing.T) {
	app, _, _ := testApp(nil)
	app.Containerized = func() bool { return true }
	req, err := apiPresignedRequest(context.Background(), app, "http://localhost:9000/scantor/files/x?X-Amz-Signature=s")
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.Host != "host.docker.internal:9000" || req.Host != "localhost:9000" || req.URL.RawQuery != "X-Amz-Signature=s" {
		t.Fatalf("url %s host %s", req.URL, req.Host)
	}
	req, _ = apiPresignedRequest(context.Background(), app, "https://s3.example.com/x")
	if req.URL.Host != "s3.example.com" || req.Host != "s3.example.com" {
		t.Fatalf("public URL rewritten: %s %s", req.URL, req.Host)
	}
	app.Containerized = func() bool { return false }
	req, _ = apiPresignedRequest(context.Background(), app, "http://localhost:9000/x")
	if req.URL.Host != "localhost:9000" {
		t.Fatalf("native CLI rewrote the URL: %s", req.URL)
	}
	if _, err := apiPresignedRequest(context.Background(), app, "file:///etc/passwd"); err == nil {
		t.Fatal("non-http URL accepted")
	}
}

func TestAPISafeFileName(t *testing.T) {
	for in, want := range map[string]string{"shot.png": "shot.png", "../../x.txt": "x.txt", `a\b.txt`: "b.txt", "..": "fb", "": "fb", "/": "fb"} {
		if got := apiSafeFileName(in, "fb"); got != want {
			t.Errorf("apiSafeFileName(%q) = %q, want %q", in, got, want)
		}
	}
}
