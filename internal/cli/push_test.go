package cli

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/taskpipe"
)

func testTaskJSON(name string) map[string]any {
	return map[string]any{"id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "name": name, "language": "python"}
}

func testRevisionJSON(state string) map[string]any {
	return map[string]any{
		"id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "taskName": "echo",
		"number": 3, "ref": "echo@3", "state": state, "errors": []any{},
		"source": map[string]any{"kind": "upload", "packSha256": "ab", "packBytes": 10, "fileCount": 4},
	}
}

func TestPushReportsAnUnchangedReadyRevision(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/upload", http.StatusCreated, map[string]any{"task": testTaskJSON("echo"), "revision": testRevisionJSON("ready"), "created": false})
	code, out, errOut := f.exec("push", writeTaskDir(t, nil))
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "Updated the workspace of task echo") || !strings.Contains(out, "Revision echo@3 is ready\n") || strings.Contains(out, "follow") {
		t.Fatalf("stdout %q", out)
	}
}

// execEnv runs the CLI against the fake with extra environment.
func (f *apiFake) execEnv(env map[string]string, args ...string) (int, string, string) {
	all := map[string]string{"SCANTOR_URL": f.srv.URL, "SCANTOR_TOKEN": apiTestToken}
	for k, v := range env {
		all[k] = v
	}
	app, out, errOut := testApp(all)
	code := run(app, args...)
	return code, out.String(), errOut.String()
}

func TestPushUploadsThePack(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/upload", http.StatusCreated, map[string]any{"task": testTaskJSON("echo"), "revision": testRevisionJSON("queued"), "created": true})
	dir := writeTaskDir(t, map[string]string{".scantor/out/x": "ignored", ".git/HEAD": "ignored"})
	code, out, errOut := f.exec("push", dir, "-m", "first")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "Created task echo") || !strings.Contains(out, "Revision echo@3 is queued") || !strings.Contains(errOut, "packed 4 files") {
		t.Fatalf("stdout %q stderr %q", out, errOut)
	}
	req := f.last("POST", "/api/tasks/upload")
	if req.Header.Get("Content-Type") != "application/gzip" || req.Query.Get("message") != "first" || req.Query.Has("publish") || req.Query.Has("force") {
		t.Fatalf("request %+v", req)
	}
	// The body is exactly the deterministic pack of the folder.
	pack, err := taskpipe.ReadPack(context.Background(), bytes.NewReader(req.Body), taskpipe.PackLimits{})
	if err != nil {
		t.Fatal(err)
	}
	defer pack.Close()
	local, err := taskpipe.PackDir(context.Background(), dir, taskpipe.PackLimits{})
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if pack.Summary != local.Summary || int64(len(req.Body)) != local.Summary.PackBytes {
		t.Fatalf("uploaded %+v, local %+v", pack.Summary, local.Summary)
	}
}

func TestPushOptions(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/upload", http.StatusCreated, map[string]any{"task": testTaskJSON("echo"), "revision": nil, "created": false})
	code, out, errOut := f.exec("push", writeTaskDir(t, nil), "--no-publish", "--force", "-o", "json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	req := f.last("POST", "/api/tasks/upload")
	if req.Query.Get("publish") != "false" || req.Query.Get("force") != "true" {
		t.Fatalf("query %v", req.Query)
	}
	res := apiDecode[map[string]any](t, []byte(out))
	if res["revision"] != nil || res["task"].(map[string]any)["name"] != "echo" || res["pack"].(map[string]any)["fileCount"].(float64) != 4 {
		t.Fatalf("json %s", out)
	}
	if strings.Contains(errOut, "packed") {
		t.Fatal("JSON mode prints no progress")
	}
	if code, _, _ := f.exec("push", writeTaskDir(t, nil), "--no-publish", "--wait"); code != 2 {
		t.Fatal("--wait with --no-publish is a usage error")
	}
}

func TestPushWorkspaceDirty(t *testing.T) {
	f := newAPIFake(t)
	f.fail("POST", "/api/tasks/upload", http.StatusConflict, "workspaceDirty", "the workspace has unpublished changes", nil)
	code, _, errOut := f.exec("push", writeTaskDir(t, nil))
	if code != 2 || !strings.Contains(errOut, "--force") {
		t.Fatalf("exit %d: %s", code, errOut)
	}
}

func TestPushWait(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/upload", http.StatusCreated, map[string]any{"task": testTaskJSON("echo"), "revision": testRevisionJSON("queued"), "created": false})
	failed := testRevisionJSON("failed")
	failed["errors"] = []any{map[string]any{"phase": "static", "file": "Dockerfile", "line": 3, "message": "VOLUME is not allowed (D11)"}}
	f.sequence("GET", "/api/tasks/echo/revisions/c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", testRevisionJSON("building"), failed)
	code, out, errOut := f.exec("push", writeTaskDir(t, nil), "--wait")
	if code != 2 || !strings.Contains(out, "failed") || !strings.Contains(errOut, "revision echo@3 failed") {
		t.Fatalf("exit %d\nstdout %s\nstderr %s", code, out, errOut)
	}
}

func TestPushPackErrors(t *testing.T) {
	f := newAPIFake(t)
	dir := writeTaskDir(t, nil)
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "evil")); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := f.exec("push", dir)
	if code != 2 || !strings.Contains(errOut, "  evil: the symlink points to the absolute path") || f.count() != 0 {
		t.Fatalf("exit %d requests %d: %s", code, f.count(), errOut)
	}
}

func TestPushInsideTheEditor(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/tasks/echo/revisions", http.StatusCreated, testRevisionJSON("queued"))
	workspace := t.TempDir()
	task := filepath.Join(workspace, "echo", "src")
	if err := os.MkdirAll(task, 0o755); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"SCANTOR_WORKSPACE": workspace}
	code, out, errOut := f.execEnv(env, "push", task, "-m", "edit")
	if code != 0 || !strings.Contains(out, "Revision echo@3 is queued") {
		t.Fatalf("exit %d: %s %s", code, out, errOut)
	}
	if body := string(f.last("POST", "/api/tasks/echo/revisions").Body); !strings.Contains(body, `"message":"edit"`) {
		t.Fatalf("body %s", body)
	}
	if len(f.calls("POST", "/api/tasks/upload")) != 0 {
		t.Fatal("inside the editor push never uploads")
	}
	if code, _, _ := f.execEnv(env, "push", task, "--no-publish"); code != 2 {
		t.Fatal("--no-publish inside the editor is a usage error")
	}
	if code, _, _ := f.execEnv(env, "push", workspace); code != 2 {
		t.Fatal("the workspace root is not a task folder")
	}
}

func TestEditorTask(t *testing.T) {
	ws := t.TempDir()
	inside := filepath.Join(ws, "echo", "lib")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	tests := []struct {
		workspace, dir, task string
		in, err              bool
	}{
		{"", inside, "", false, false},
		{ws, inside, "echo", true, false},
		{ws, filepath.Join(ws, "echo"), "echo", true, false},
		{ws, outside, "", false, false},
		{ws, ws, "", false, true},
		{ws, filepath.Join(ws, "missing"), "", false, true},
	}
	for _, tt := range tests {
		task, in, err := editorTask(tt.workspace, tt.dir)
		if task != tt.task || in != tt.in || (err != nil) != tt.err {
			t.Errorf("editorTask(%s, %s) = %q, %v, %v", tt.workspace, tt.dir, task, in, err)
		}
	}
}
