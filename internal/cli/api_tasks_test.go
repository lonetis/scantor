package cli

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func TestAPITasksList(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/tasks", 200, map[string]any{"items": []any{apiTaskFixture("echo")}, "nextCursor": "c2"})

	code, out, errOut := f.exec("tasks", "list", "--language", "python", "--search", "ech", "--limit", "10", "--cursor", "c1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	q := f.last("GET", "/api/tasks").Query
	if q.Get("language") != "python" || q.Get("q") != "ech" || q.Get("limit") != "10" || q.Get("cursor") != "c1" {
		t.Fatalf("query = %v", q)
	}
	if !strings.Contains(out, "NAME") || !strings.Contains(out, "echo@3") || !strings.Contains(out, "unpublished changes") {
		t.Fatalf("table = %q", out)
	}
	if !strings.Contains(errOut, "--cursor c2") {
		t.Fatalf("no next-page hint on stderr: %q", errOut)
	}

	code, out, errOut = f.exec("tasks", "list", "-o", "json")
	page := apiDecode[api.Page[api.Task]](t, []byte(out))
	if code != 0 || len(page.Items) != 1 || page.Items[0].Name != "echo" || page.NextCursor == nil || *page.NextCursor != "c2" {
		t.Fatalf("json: exit %d, out %q", code, out)
	}
	if errOut != "" {
		t.Fatalf("JSON mode wrote to stderr: %q", errOut)
	}

	if code, _, _ := f.exec("tasks", "list", "--limit", "500"); code != ExitValidation {
		t.Fatalf("limit above max: exit %d", code)
	}
}

func TestAPITasksCreateAndGet(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks", 201, apiTaskFixture("echo"))
	f.reply("GET", "/api/tasks/echo", 200, apiTaskFixture("echo"))

	if code, _, errOut := f.exec("tasks", "create", "echo"); code != ExitValidation || !strings.Contains(errOut, "--language") {
		t.Fatalf("missing language: exit %d, %q", code, errOut)
	}
	if f.count() != 0 {
		t.Fatal("a request was sent for an invalid invocation")
	}
	code, out, errOut := f.exec("tasks", "create", "echo", "--language", "python", "--template", "list", "--description", "Echo")
	if code != 0 || !strings.Contains(out, "created task echo") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/tasks").Body, `{"name":"echo","language":"python","template":"list","description":"Echo"}`)

	code, out, _ = f.exec("tasks", "get", "echo")
	if code != 0 || !strings.Contains(out, "scaffold (template single)") || !strings.Contains(out, "echo@3 (ready") {
		t.Fatalf("get: exit %d, out %q", code, out)
	}
	if f.last("GET", "/api/tasks/echo").Header.Get("Authorization") != "Bearer "+apiTestToken {
		t.Fatal("missing bearer token")
	}

	f.fail("GET", "/api/tasks/nope", 404, "notFound", "task not found", nil)
	code, _, errOut = f.exec("tasks", "get", "nope", "-o", "json")
	if code != ExitValidation || !strings.Contains(errOut, `"code":"notFound"`) {
		t.Fatalf("not found: exit %d, stderr %q", code, errOut)
	}
}

func TestAPITasksDeleteWait(t *testing.T) {
	f := newAPIFake(t)
	f.reply("DELETE", "/api/tasks/echo", 202, map[string]any{"job": map[string]any{"id": "job-1", "kind": "taskDelete", "state": "queued"}})
	job := func(state string, jobErr any) map[string]any {
		return map[string]any{"id": "job-1", "kind": "taskDelete", "subject": map[string]any{"kind": "task", "id": "t"}, "state": state,
			"progress": map[string]any{"done": 1, "total": 1}, "attempts": 1, "error": jobErr, "createdAt": "2026-10-21T10:00:00.000Z", "startedAt": nil, "finishedAt": nil}
	}
	f.sequence("GET", "/api/jobs/job-1", job("running", nil), job("succeeded", nil))

	code, out, errOut := f.exec("tasks", "delete", "echo")
	if code != 0 || !strings.Contains(out, "deleting task echo (job job-1, queued)") || len(f.calls("GET", "/api/jobs/job-1")) != 0 {
		t.Fatalf("no wait: exit %d, out %q, err %q", code, out, errOut)
	}

	code, out, errOut = f.exec("tasks", "delete", "echo", "--wait")
	if code != 0 || !strings.Contains(out, "succeeded") {
		t.Fatalf("wait: exit %d, out %q, err %q", code, out, errOut)
	}
	if got := f.last("GET", "/api/jobs/job-1").Query.Get("wait"); got != "120" {
		t.Fatalf("long-poll wait = %q", got)
	}

	f.reply("GET", "/api/jobs/job-1", 200, job("failed", map[string]any{"code": "internal", "message": "registry unreachable"}))
	code, out, errOut = f.exec("tasks", "delete", "echo", "--wait", "-o", "json")
	if code != ExitPlatform || !strings.Contains(errOut, "registry unreachable") || apiDecode[api.Job](t, []byte(out)).State != "failed" {
		t.Fatalf("failed job: exit %d, out %q, err %q", code, out, errOut)
	}
}

func TestAPITasksFiles(t *testing.T) {
	f := newAPIFake(t)
	ws := map[string]any{"packSha256": "b7c201aa00112233", "dirty": true}
	f.reply("PUT", "/api/tasks/echo/files", 200, map[string]any{"written": []string{"main.py", "data.bin", "notes.txt"}, "workspace": ws})
	f.reply("DELETE", "/api/tasks/echo/files", 200, map[string]any{"deleted": []string{"old", "old/a.py"}, "workspace": ws})
	f.reply("GET", "/api/tasks/echo/files/content", 200, map[string]any{"path": "img.png", "size": 3, "sha256": "x", "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte{0x89, 0, 1}), "truncated": false})
	f.reply("GET", "/api/tasks/echo/files", 200, map[string]any{"entries": []any{map[string]any{"path": "main.py", "type": "file", "size": 120, "mode": 0o644}}, "truncated": true})

	dir := t.TempDir()
	mainPy := filepath.Join(dir, "main.py")
	binary := filepath.Join(dir, "data.bin")
	if err := os.WriteFile(mainPy, []byte("print('hi')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte{0xff, 0x00, 0x01}, 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := f.execIn("from stdin", "tasks", "files", "put", "echo", "main.py="+mainPy, "data.bin="+binary, "notes.txt=-")
	if code != 0 || !strings.Contains(out, "wrote main.py") || !strings.Contains(out, "unpublished changes") {
		t.Fatalf("put: exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("PUT", "/api/tasks/echo/files").Body,
		`{"files":{"main.py":"print('hi')\n","data.bin":{"base64":"/wAB"},"notes.txt":"from stdin"}}`)

	if code, _, errOut := f.exec("tasks", "files", "put", "echo", "a=-", "b=-"); code != ExitValidation || !strings.Contains(errOut, "stdin is already used") {
		t.Fatalf("double stdin: exit %d, %q", code, errOut)
	}
	if code, _, _ := f.exec("tasks", "files", "put", "echo", "missing-file.py"); code != ExitValidation {
		t.Fatalf("missing local file: exit %d", code)
	}

	code, out, _ = f.exec("tasks", "files", "rm", "echo", "old", "-r")
	q := f.last("DELETE", "/api/tasks/echo/files").Query
	if code != 0 || q.Get("path") != "old" || q.Get("recursive") != "true" || !strings.Contains(out, "deleted old/a.py") {
		t.Fatalf("rm: exit %d, query %v, out %q", code, q, out)
	}

	code, out, _ = f.exec("tasks", "files", "cat", "echo", "img.png", "--revision", "3")
	q = f.last("GET", "/api/tasks/echo/files/content").Query
	if code != 0 || out != string([]byte{0x89, 0, 1}) || q.Get("path") != "img.png" || q.Get("revision") != "3" {
		t.Fatalf("cat: exit %d, out %q, query %v", code, out, q)
	}

	code, out, errOut = f.exec("tasks", "files", "ls", "echo", "src", "--recursive=false")
	q = f.last("GET", "/api/tasks/echo/files").Query
	if code != 0 || q.Get("path") != "src" || q.Get("recursive") != "false" || !strings.Contains(out, "0644") || !strings.Contains(errOut, "truncated") {
		t.Fatalf("ls: exit %d, query %v, out %q, err %q", code, q, out, errOut)
	}
}

func TestAPITasksGit(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/import-git", 200, map[string]any{"imported": []any{}, "candidates": []any{
		map[string]any{"path": "tasks/echo", "name": "echo", "language": "python", "exists": false},
		map[string]any{"path": "tasks/power", "name": "power", "language": "javascript", "exists": true},
	}})
	code, out, errOut := f.exec("tasks", "import-git", "https://github.com/example/scans", "--ref", "main", "--select", "tasks/echo,tasks/power", "--credential", "cred-1")
	if code != 0 || !strings.Contains(out, "tasks/power") || !strings.Contains(errOut, "--select") {
		t.Fatalf("candidates: exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/tasks/import-git").Body,
		`{"url":"https://github.com/example/scans","ref":"main","credentialId":"cred-1","select":["tasks/echo","tasks/power"]}`)

	f.fail("POST", "/api/tasks/echo/git/pull", 409, "gitDiverged", "the workspace has local changes", nil)
	code, _, errOut = f.exec("tasks", "pull", "echo")
	if code != ExitValidation || !strings.Contains(errOut, "local changes; re-run with --force") {
		t.Fatalf("diverged: exit %d, err %q", code, errOut)
	}
	f.reply("POST", "/api/tasks/echo/git/pull", 200, map[string]any{"task": apiTaskFixture("echo"), "previousCommit": "aaaaaaaaaaaaaaaa", "commit": "bbbbbbbbbbbbbbbb", "changed": true})
	code, out, _ = f.exec("tasks", "pull", "echo", "--force")
	if code != 0 || !strings.Contains(out, "aaaaaaaaaaaa → bbbbbbbbbbbb") {
		t.Fatalf("pull: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("POST", "/api/tasks/echo/git/pull").Body, `{"force":true}`)
}

func TestAPIMissingToken(t *testing.T) {
	app, _, errOut := testApp(map[string]string{"SCANTOR_URL": "http://127.0.0.1:1"})
	if code := run(app, "tasks", "list"); code != ExitValidation || !strings.Contains(errOut.String(), "SCANTOR_TOKEN") {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
	// An unreachable orchestrator is a platform failure.
	app, _, _ = testApp(map[string]string{"SCANTOR_URL": "http://127.0.0.1:1", "SCANTOR_TOKEN": apiTestToken})
	if code := run(app, "tasks", "list"); code != ExitPlatform {
		t.Fatalf("unreachable: exit %d", code)
	}
}
