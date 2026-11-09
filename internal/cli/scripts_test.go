package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/taskpipe"
)

func init() {
	// The fake answers at once; do not slow the follow tests down to one log poll every two seconds.
	scriptsLogPoll = 10 * time.Millisecond
}

const (
	scriptsTestID    = "9c4d2e1f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
	scriptsTestRunID = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8"
	scriptsTestOutID = "8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d"
)

// writeScriptsFolder creates a script folder; files are added or replace the defaults ("" removes one).
func writeScriptsFolder(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	base := map[string]string{
		"scantor-script.yaml": "scantor: 1\nname: csp-report\nlanguage: python\n",
		"Dockerfile":          "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n",
		"main.py":             "from scantor.script import Script\n",
	}
	for k, v := range files {
		base[k] = v
	}
	for name, content := range base {
		if content == "" {
			continue
		}
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func scriptsScriptFixture(name string) map[string]any {
	return map[string]any{
		"id": scriptsTestID, "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", "name": name, "language": "python",
		"description": "CSP report", "source": map[string]any{"kind": "scaffold"},
		"workspace": map[string]any{"packSha256": "d41c7e00aa", "fileCount": 8, "bytes": 9216, "checkedAt": "2026-10-22T08:10:00.000Z"},
		"describe":  map[string]any{"packSha256": "d41c7e00aa", "configSchema": map[string]any{"type": "object"}, "resultSchema": nil, "at": "2026-10-22T08:12:31.000Z"},
		"latestRun": map[string]any{"id": scriptsTestRunID, "state": "completed", "createdAt": "2026-10-22T09:00:00.000Z", "finishedAt": "2026-10-22T11:42:05.000Z"},
		"recentRuns": []any{map[string]any{"id": scriptsTestRunID, "state": "completed", "createdAt": "2026-10-22T09:00:00.000Z", "finishedAt": "2026-10-22T11:42:05.000Z",
			"progress": map[string]any{"done": 1000, "total": 4000, "message": "reading files", "updatedAt": "2026-10-22T11:42:04.000Z"}}},
		"createdAt": "2026-10-22T08:00:00.000Z", "updatedAt": "2026-10-22T11:42:05.000Z",
	}
}

func scriptsRunFixture(state string, extra map[string]any) map[string]any {
	run := map[string]any{
		"id": scriptsTestRunID, "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", "scriptId": scriptsTestID, "scriptName": "csp-report",
		"scans": []any{map[string]any{"id": apiScanID, "name": "tranco"}}, "state": state,
		"input":   map[string]any{"config": map[string]any{"minBytes": 0}, "settings": map[string]any{"timeoutMs": 3600000, "resources": map[string]any{"cpus": 2, "memoryMiB": 1024}, "limit": nil}},
		"secrets": []any{"API_TOKEN"}, "source": map[string]any{"packSha256": "d41c7e00aa", "packBytes": 11, "fileCount": 3},
		"restartedFrom": nil, "image": nil, "errors": []any{}, "error": nil, "exitCode": nil, "progress": nil, "checkpoint": nil,
		"result": nil, "outputs": []any{}, "log": map[string]any{"lines": 0, "firstLine": 1, "droppedLines": 0},
		"createdAt": "2026-10-22T09:00:00.000Z", "startedAt": nil, "finishedAt": nil, "updatedAt": "2026-10-22T09:00:00.000Z", "expiresAt": nil,
	}
	for k, v := range extra {
		run[k] = v
	}
	return run
}

func scriptsLogLine(n int, stream, text string) map[string]any {
	return map[string]any{"line": n, "at": "2026-10-22T09:00:00.000Z", "stream": stream, "text": text}
}

func scriptsLogsPage(complete bool, lines ...map[string]any) map[string]any {
	next := 0
	if len(lines) > 0 {
		next = lines[len(lines)-1]["line"].(int)
	}
	if lines == nil {
		lines = []map[string]any{}
	}
	return map[string]any{"lines": lines, "firstLine": 1, "nextLine": next, "complete": complete}
}

func TestScriptsListGetCreateDelete(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/scripts", 200, map[string]any{"items": []any{scriptsScriptFixture("csp-report")}, "nextCursor": "c2"})
	f.reply("GET", "/api/scripts/csp-report", 200, scriptsScriptFixture("csp-report"))
	f.reply("POST", "/api/scripts", 201, scriptsScriptFixture("csp-report"))
	f.reply("DELETE", "/api/scripts/csp-report", 202, map[string]any{"job": map[string]any{"id": "job-1", "kind": "scriptDelete", "state": "queued"}})

	code, out, errOut := f.exec("scripts", "list", "--search", "csp", "--limit", "10")
	q := f.last("GET", "/api/scripts").Query
	if code != 0 || q.Get("q") != "csp" || q.Get("limit") != "10" || !strings.Contains(out, "csp-report") || !strings.Contains(errOut, "--cursor c2") {
		t.Fatalf("list: exit %d, query %v, out %q, err %q", code, q, out, errOut)
	}
	code, out, _ = f.exec("scripts", "list", "-o", "json")
	if page := apiDecode[api.Page[api.Script]](t, []byte(out)); code != 0 || len(page.Items) != 1 || page.Items[0].ID != scriptsTestID {
		t.Fatalf("list json: exit %d, out %q", code, out)
	}

	code, out, _ = f.exec("scripts", "get", "csp-report")
	if code != 0 || !strings.Contains(out, "config declared, result none (reported by a run of the current folder") ||
		!strings.Contains(out, "recent runs:") || !strings.Contains(out, "1000/4000 (25.0%) reading files") {
		t.Fatalf("get: exit %d, out %q", code, out)
	}

	code, out, _ = f.exec("scripts", "create", "csp-report", "--description", "CSP report")
	if code != 0 || !strings.Contains(out, "created script csp-report (python, id "+scriptsTestID+")") {
		t.Fatalf("create: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("POST", "/api/scripts").Body, `{"name":"csp-report","description":"CSP report"}`)

	code, out, _ = f.exec("scripts", "delete", "csp-report")
	if code != 0 || !strings.Contains(out, "deleting script csp-report (job job-1, queued)") {
		t.Fatalf("delete: exit %d, out %q", code, out)
	}
}

func TestScriptsFiles(t *testing.T) {
	f := newAPIFake(t)
	ws := map[string]any{"packSha256": "e52d80aabbccddee"}
	f.reply("GET", "/api/scripts/csp/files", 200, map[string]any{"entries": []any{map[string]any{"path": "main.py", "type": "file", "size": 120, "mode": 0o644}}, "truncated": false})
	f.reply("GET", "/api/scripts/csp/files/content", 200, map[string]any{"path": "main.py", "size": 9, "sha256": "x", "encoding": "utf8", "content": "print(1)\n", "truncated": false})
	f.reply("PUT", "/api/scripts/csp/files", 200, map[string]any{"written": []string{"main.py"}, "workspace": ws})
	f.reply("DELETE", "/api/scripts/csp/files", 200, map[string]any{"deleted": []string{"old.py"}, "workspace": ws})

	code, out, _ := f.exec("scripts", "files", "list", "csp", "lib", "--recursive=false")
	q := f.last("GET", "/api/scripts/csp/files").Query
	if code != 0 || q.Get("path") != "lib" || q.Get("recursive") != "false" || !strings.Contains(out, "main.py") {
		t.Fatalf("list: exit %d, query %v, out %q", code, q, out)
	}
	if code, out, _ = f.exec("scripts", "files", "cat", "csp", "main.py"); code != 0 || out != "print(1)\n" {
		t.Fatalf("read: exit %d, out %q", code, out)
	}
	code, out, _ = f.execIn("x = 1\n", "scripts", "files", "write", "csp", "main.py=-")
	if code != 0 || !strings.Contains(out, "wrote main.py") || !strings.Contains(out, "script folder pack e52d80aabbcc") {
		t.Fatalf("write: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("PUT", "/api/scripts/csp/files").Body, `{"files":{"main.py":"x = 1\n"}}`)
	code, out, _ = f.exec("scripts", "files", "rm", "csp", "old.py")
	if q := f.last("DELETE", "/api/scripts/csp/files").Query; code != 0 || q.Get("path") != "old.py" || q.Get("recursive") != "false" || !strings.Contains(out, "deleted old.py") {
		t.Fatalf("delete: exit %d, query %v, out %q", code, q, out)
	}
}

func TestScriptsPush(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/upload", 201, map[string]any{"script": scriptsScriptFixture("csp-report"), "created": true})
	dir := writeScriptsFolder(t, nil)

	code, out, errOut := f.exec("scripts", "push", dir, "--force")
	if code != 0 || !strings.Contains(out, "Created script csp-report") || !strings.Contains(errOut, "packed 3 files") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	req := f.last("POST", "/api/scripts/upload")
	if req.Header.Get("Content-Type") != "application/gzip" || req.Query.Get("force") != "true" {
		t.Fatalf("request %+v", req)
	}
	pack, err := taskpipe.ReadPack(context.Background(), bytes.NewReader(req.Body), taskpipe.PackLimits{})
	if err != nil {
		t.Fatal(err)
	}
	defer pack.Close()
	if pack.Summary.FileCount != 3 {
		t.Fatalf("pack %+v", pack.Summary)
	}

	code, out, _ = f.exec("scripts", "push", dir, "-o", "json")
	res := apiDecode[map[string]any](t, []byte(out))
	if code != 0 || res["uploaded"] != true || res["script"].(map[string]any)["name"] != "csp-report" || res["pack"].(map[string]any)["fileCount"].(float64) != 3 {
		t.Fatalf("json: exit %d, out %s", code, out)
	}

	f.fail("POST", "/api/scripts/upload", http.StatusConflict, "workspaceDirty", "the folder has changes", nil)
	if code, _, errOut := f.exec("scripts", "push", dir); code != ExitValidation || !strings.Contains(errOut, "scripts push --force") {
		t.Fatalf("dirty: exit %d, %q", code, errOut)
	}
	before := len(f.calls("POST", "/api/scripts/upload"))
	if code, _, errOut := f.exec("scripts", "push", writeTaskDir(t, nil)); code != ExitValidation || !strings.Contains(errOut, "has no scantor-script.yaml") {
		t.Fatalf("task folder: exit %d, %q", code, errOut)
	}
	if code, _, errOut := f.exec("scripts", "push", writeScriptsFolder(t, map[string]string{"scantor.yaml": "scantor: 1\n"})); code != ExitValidation || !strings.Contains(errOut, "both scantor.yaml and scantor-script.yaml") {
		t.Fatalf("both manifests: exit %d, %q", code, errOut)
	}
	if len(f.calls("POST", "/api/scripts/upload")) != before {
		t.Fatal("an invalid folder was uploaded")
	}
}

// `scantor push` uploads a script folder like `scantor scripts push`; the task-only flags are usage errors.
func TestPushDelegatesScriptFolders(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/upload", 200, map[string]any{"script": scriptsScriptFixture("csp-report"), "created": false})
	dir := writeScriptsFolder(t, nil)
	code, out, errOut := f.exec("push", dir, "--force")
	if code != 0 || !strings.Contains(out, "Uploaded the folder of script csp-report") || f.last("POST", "/api/scripts/upload").Query.Get("force") != "true" {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	if len(f.calls("POST", "/api/tasks/upload")) != 0 {
		t.Fatal("a script folder was uploaded as a task")
	}
	for _, args := range [][]string{{"--no-publish"}, {"-m", "x"}, {"--wait"}} {
		if code, _, errOut := f.exec(append([]string{"push", dir}, args...)...); code != ExitValidation || !strings.Contains(errOut, "scripts have no revisions") {
			t.Fatalf("%v: exit %d, %q", args, code, errOut)
		}
	}
	if code, _, errOut := f.exec("push", writeScriptsFolder(t, map[string]string{"scantor.yaml": "scantor: 1\n"})); code != ExitValidation || !strings.Contains(errOut, "either a task or a script") {
		t.Fatalf("both manifests: exit %d, %q", code, errOut)
	}
}

func TestScriptsPushInsideTheEditor(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/scripts/csp-report", 200, scriptsScriptFixture("csp-report"))
	ws := t.TempDir()
	dir := filepath.Join(ws, ".scripts", "csp-report", "lib")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"SCANTOR_WORKSPACE": ws}
	for _, cmd := range [][]string{{"scripts", "push", dir}, {"push", dir}} {
		code, out, errOut := f.execEnv(env, cmd...)
		if code != 0 || !strings.Contains(out, "Nothing to upload") {
			t.Fatalf("%v: exit %d, out %q, err %q", cmd, code, out, errOut)
		}
	}
	if len(f.calls("POST", "/api/scripts/upload")) != 0 {
		t.Fatal("inside the editor push never uploads")
	}
	if code, _, errOut := f.execEnv(env, "scripts", "push", filepath.Join(ws, ".scripts")); code != ExitValidation || !strings.Contains(errOut, "folder of all scripts") {
		t.Fatalf("scripts root: exit %d, %q", code, errOut)
	}
	task := filepath.Join(ws, "echo")
	if err := os.MkdirAll(task, 0o755); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := f.execEnv(env, "scripts", "push", task); code != ExitValidation || !strings.Contains(errOut, "belongs to task echo") {
		t.Fatalf("task folder: exit %d, %q", code, errOut)
	}
}

func TestEditorFolder(t *testing.T) {
	ws := t.TempDir()
	for _, p := range []string{"echo/lib", ".scripts/csp/lib"} {
		if err := os.MkdirAll(filepath.Join(ws, filepath.FromSlash(p)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		dir        string
		kind, name string
		in, err    bool
	}{
		{filepath.Join(ws, "echo", "lib"), editorKindTask, "echo", true, false},
		{filepath.Join(ws, ".scripts", "csp"), editorKindScript, "csp", true, false},
		{filepath.Join(ws, ".scripts", "csp", "lib"), editorKindScript, "csp", true, false},
		{filepath.Join(ws, ".scripts"), "", "", false, true},
		{ws, "", "", false, true},
		{t.TempDir(), "", "", false, false},
	}
	for _, tt := range tests {
		folder, in, err := editorFolder(ws, tt.dir)
		if folder.kind != tt.kind || folder.name != tt.name || in != tt.in || (err != nil) != tt.err {
			t.Errorf("editorFolder(%s) = %+v, %v, %v", tt.dir, folder, in, err)
		}
	}
	// Commands that work on tasks refuse script folders.
	if _, _, err := editorTask(ws, filepath.Join(ws, ".scripts", "csp")); err == nil || ExitCode(err) != ExitValidation {
		t.Fatalf("editorTask on a script folder: %v", err)
	}
}

func TestScriptsRunByName(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/csp-report/runs", 201, scriptsRunFixture("queued", nil))
	secret := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(secret, []byte("s3cr3t\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	code, out, errOut := f.exec("scripts", "run", "csp-report", "--scan", apiScanID, "--scan", "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
		"--config", `{"minBytes":1024}`, "--secret", "API_TOKEN=@"+secret, "--secret", "OTHER=a=b", "--limit", "100",
		"--timeout", "12h", "--cpus", "1.5", "--memory", "4GiB", "--yes")
	if code != 0 || !strings.Contains(out, "started script run "+scriptsTestRunID+" (csp-report, queued)") || !strings.Contains(out, "scripts runs logs "+scriptsTestRunID+" --follow") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/scripts/csp-report/runs").Body, `{"scans":["`+apiScanID+`","6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c"],
		"config":{"minBytes":1024},"secrets":{"API_TOKEN":"s3cr3t\n","OTHER":"a=b"},
		"settings":{"timeoutMs":43200000,"resources":{"cpus":1.5,"memoryMiB":4096},"limit":100},"confirm":true}`)

	code, out, _ = f.exec("scripts", "run", "csp-report", "--scan", apiScanID, "-o", "json")
	if run := apiDecode[api.ScriptRun](t, []byte(out)); code != 0 || run.ID != scriptsTestRunID {
		t.Fatalf("json: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("POST", "/api/scripts/csp-report/runs").Body, `{"scans":["`+apiScanID+`"]}`)

	n := len(f.calls("POST", "/api/scripts/csp-report/runs"))
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"scripts", "run", "csp-report"}, "--scan is required"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--secret", "lower=x"}, "invalid --secret"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--secret", "s3cr3t-token"}, "invalid --secret: use NAME=VALUE"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--secret", "A=1", "--secret", "A=2"}, "given twice"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--memory", "4096"}, "whole number of MiB"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--memory", "lots"}, "--memory"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--cpus", "0"}, "--cpus"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--limit", "0"}, "--limit"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--timeout", "10ms"}, "--timeout"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--config", "[1]"}, "must be an object"},
		{[]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--cancel-on-interrupt"}, "needs --follow"},
		{[]string{"scripts", "run", "./missing", "--scan", apiScanID}, "not a directory"},
	} {
		if code, _, errOut := f.exec(tc.args...); code != ExitValidation || !strings.Contains(errOut, tc.want) {
			t.Errorf("%v: exit %d, stderr %q", tc.args, code, errOut)
		}
	}
	if len(f.calls("POST", "/api/scripts/csp-report/runs")) != n {
		t.Fatal("an invalid invocation started a run")
	}
	if _, _, errOut := f.exec("scripts", "run", "csp-report", "--scan", apiScanID, "--secret", "s3cr3t-token"); strings.Contains(errOut, "s3cr3t-token") {
		t.Fatalf("a malformed --secret echoed its value: %q", errOut)
	}

	f.fail("POST", "/api/scripts/csp-report/runs", http.StatusConflict, "confirmationRequired", "the run reads 1000000 analyses", nil)
	if code, _, errOut := f.exec("scripts", "run", "csp-report", "--scan", apiScanID); code != ExitValidation || !strings.Contains(errOut, "--yes") {
		t.Fatalf("confirmation: exit %d, %q", code, errOut)
	}
}

// A folder (or the current directory) is uploaded first; the run starts on the script the upload named.
func TestScriptsRunPushesTheFolder(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/upload", 201, map[string]any{"script": scriptsScriptFixture("csp-report"), "created": true})
	f.reply("POST", "/api/scripts/csp-report/runs", 201, scriptsRunFixture("queued", nil))
	dir := writeScriptsFolder(t, nil)
	code, _, errOut := f.exec("scripts", "run", dir, "--scan", apiScanID)
	if code != 0 || len(f.calls("POST", "/api/scripts/upload")) != 1 || !strings.Contains(errOut, "created script csp-report") {
		t.Fatalf("exit %d, err %q", code, errOut)
	}
	if f.last("POST", "/api/scripts/upload").Query.Has("force") {
		t.Fatal("run never forces an upload")
	}
	t.Chdir(dir)
	if code, _, errOut := f.exec("scripts", "run", "--scan", apiScanID); code != 0 || len(f.calls("POST", "/api/scripts/upload")) != 2 {
		t.Fatalf("current directory: exit %d, err %q", code, errOut)
	}
	t.Chdir(t.TempDir())
	if code, _, errOut := f.exec("scripts", "run", "--scan", apiScanID); code != ExitValidation || !strings.Contains(errOut, "has no scantor-script.yaml") {
		t.Fatalf("not a script folder: exit %d, err %q", code, errOut)
	}
}

func TestScriptsRunInsideTheEditor(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/csp/runs", 201, scriptsRunFixture("queued", nil))
	ws := t.TempDir()
	dir := filepath.Join(ws, ".scripts", "csp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	code, _, errOut := f.execEnv(map[string]string{"SCANTOR_WORKSPACE": ws}, "scripts", "run", "--scan", apiScanID)
	if code != 0 || len(f.calls("POST", "/api/scripts/csp/runs")) != 1 || len(f.calls("POST", "/api/scripts/upload")) != 0 {
		t.Fatalf("exit %d, err %q", code, errOut)
	}
}

func TestScriptsRunFollow(t *testing.T) {
	logs := "/api/script-runs/" + scriptsTestRunID + "/logs"
	runPath := "/api/script-runs/" + scriptsTestRunID
	for _, tc := range []struct {
		name  string
		final map[string]any
		code  int
		want  string
	}{
		{"completed", scriptsRunFixture("completed", map[string]any{"exitCode": 0, "result": map[string]any{"withCsp": 7}}), 0, `{"withCsp":7}`},
		{"failed", scriptsRunFixture("failed", map[string]any{"exitCode": 1, "error": map[string]any{"type": "scriptError", "message": "KeyError", "stack": "Traceback\nKeyError"}}), ExitAnalysisFailures, "KeyError"},
		{"build", scriptsRunFixture("failed", map[string]any{"errors": []any{map[string]any{"phase": "static", "file": "scantor-script.yaml", "message": "bad"}}}), ExitAnalysisFailures, "[static] scantor-script.yaml: bad"},
		{"platform", scriptsRunFixture("failed", map[string]any{"error": map[string]any{"type": "platform", "message": "the container disappeared"}}), ExitPlatform, "the container disappeared"},
		{"cancelled", scriptsRunFixture("cancelled", nil), ExitAnalysisFailures, "cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAPIFake(t)
			f.reply("POST", "/api/scripts/csp-report/runs", 201, scriptsRunFixture("queued", nil))
			f.sequence("GET", logs,
				scriptsLogsPage(false, scriptsLogLine(1, "build", "#1 building"), scriptsLogLine(2, "stdout", "evil \x1b]52;c;aGk=\x07 text")),
				scriptsLogsPage(false),
				scriptsLogsPage(false, scriptsLogLine(5, "stderr", "after a gap")),
				scriptsLogsPage(true),
			)
			f.reply("GET", runPath, 200, tc.final)
			code, out, errOut := f.exec("scripts", "run", "csp-report", "--scan", apiScanID, "--follow")
			if code != tc.code {
				t.Fatalf("exit %d, want %d\nout %s\nerr %s", code, tc.code, out, errOut)
			}
			if !strings.Contains(out, "build  #1 building\n") || !strings.Contains(out, `stdout evil \x1b]52;c;aGk=\x07 text`) || strings.Contains(out, "\x1b") {
				t.Fatalf("log output %q", out)
			}
			if !strings.Contains(errOut, "lines 3 to 4 of the log were dropped") || !strings.Contains(out+errOut, tc.want) {
				t.Fatalf("out %q err %q", out, errOut)
			}
			if got := f.calls("GET", logs); got[1].Query.Get("afterLine") != "2" || got[3].Query.Get("afterLine") != "5" {
				t.Fatalf("afterLine %v %v", got[1].Query, got[3].Query)
			}
		})
	}

	// JSON mode prints exactly one document: the final run.
	f := newAPIFake(t)
	f.reply("POST", "/api/scripts/csp-report/runs", 201, scriptsRunFixture("queued", nil))
	f.sequence("GET", logs, scriptsLogsPage(false, scriptsLogLine(1, "stdout", "hi")), scriptsLogsPage(true))
	f.reply("GET", runPath, 200, scriptsRunFixture("completed", nil))
	code, out, errOut := f.exec("scripts", "run", "csp-report", "--scan", apiScanID, "--follow", "-o", "json")
	if run := apiDecode[api.ScriptRun](t, []byte(out)); code != 0 || run.State != "completed" || errOut != "" {
		t.Fatalf("json: exit %d, out %q, err %q", code, out, errOut)
	}
}

// Ctrl-C while following detaches: the run is not cancelled and the command says how to reach it again.
func TestScriptsRunFollowDetachesOnInterrupt(t *testing.T) {
	logs := "/api/script-runs/" + scriptsTestRunID + "/logs"
	for _, tc := range []struct {
		name   string
		extra  []string
		cancel int
		want   string
	}{
		{"detach", nil, 0, "detached from script run " + scriptsTestRunID},
		{"cancel", []string{"--cancel-on-interrupt"}, 1, "cancelled script run " + scriptsTestRunID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAPIFake(t)
			f.reply("POST", "/api/scripts/csp-report/runs", 201, scriptsRunFixture("running", nil))
			f.reply("POST", "/api/script-runs/"+scriptsTestRunID+"/cancel", 200, scriptsRunFixture("cancelled", nil))
			f.on("GET", logs, func(w http.ResponseWriter, r *http.Request) {
				_ = syscall.Kill(os.Getpid(), syscall.SIGINT)
				select {
				case <-r.Context().Done():
				case <-time.After(5 * time.Second):
					apiFakeJSON(w, http.StatusOK, scriptsLogsPage(false))
				}
			})
			args := append([]string{"scripts", "run", "csp-report", "--scan", apiScanID, "--follow"}, tc.extra...)
			code, _, errOut := f.exec(args...)
			if code != ExitPlatform || !strings.Contains(errOut, tc.want) || !strings.Contains(errOut, "interrupted") {
				t.Fatalf("exit %d, stderr %q", code, errOut)
			}
			if got := len(f.calls("POST", "/api/script-runs/"+scriptsTestRunID+"/cancel")); got != tc.cancel {
				t.Fatalf("cancel requests %d, want %d", got, tc.cancel)
			}
			if tc.cancel == 0 && (!strings.Contains(errOut, "scantor scripts runs logs "+scriptsTestRunID+" --follow") || !strings.Contains(errOut, "scantor scripts runs cancel "+scriptsTestRunID)) {
				t.Fatalf("no hints: %q", errOut)
			}
		})
	}
}

func TestScriptsRuns(t *testing.T) {
	f := newAPIFake(t)
	runPath := "/api/script-runs/" + scriptsTestRunID
	failed := scriptsRunFixture("failed", map[string]any{
		"error":   map[string]any{"type": "scriptError", "message": "KeyError: 'headers'", "stack": "Traceback\n  line 3\nKeyError"},
		"outputs": []any{map[string]any{"id": scriptsTestOutID, "name": "csp.csv.partial", "size": 12, "sha256": "ab", "contentType": "text/csv", "createdAt": "2026-10-22T09:10:00.000Z"}},
		"logTail": []any{scriptsLogLine(9, "stderr", "KeyError")}, "startedAt": "2026-10-22T09:00:10.000Z", "finishedAt": "2026-10-22T09:10:10.000Z",
	})
	f.reply("GET", "/api/scripts/csp-report/runs", 200, map[string]any{"items": []any{scriptsRunFixture("running", map[string]any{
		"progress": map[string]any{"done": 5, "total": nil, "message": nil, "updatedAt": "2026-10-22T09:00:00.000Z"}})}, "nextCursor": nil})
	f.sequence("GET", runPath, scriptsRunFixture("running", nil), failed)
	f.reply("POST", runPath+"/cancel", 200, scriptsRunFixture("cancelled", nil))
	f.reply("POST", runPath+"/restart", 201, scriptsRunFixture("queued", nil))

	code, out, _ := f.exec("scripts", "runs", "list", "csp-report", "--limit", "5")
	if code != 0 || !strings.Contains(out, scriptsTestRunID) || !strings.Contains(out, "running") || f.last("GET", "/api/scripts/csp-report/runs").Query.Get("limit") != "5" {
		t.Fatalf("list: exit %d, out %q", code, out)
	}

	code, out, errOut := f.exec("scripts", "runs", "get", scriptsTestRunID, "--wait")
	if code != ExitAnalysisFailures || !strings.Contains(out, "failed (scriptError)") || !strings.Contains(out, "stack:\n  Traceback\n    line 3") ||
		!strings.Contains(out, "csp.csv.partial") || !strings.Contains(out, "log tail:") || !strings.Contains(out, "10m0s") {
		t.Fatalf("get --wait: exit %d, out %q, err %q", code, out, errOut)
	}
	if got := f.last("GET", runPath).Query.Get("wait"); got != "120" {
		t.Fatalf("long-poll wait = %q", got)
	}
	if code, out, _ = f.exec("scripts", "runs", "get", scriptsTestRunID, "-o", "json"); code != 0 || apiDecode[api.ScriptRun](t, []byte(out)).Error == nil {
		t.Fatalf("get json: exit %d, out %q", code, out)
	}

	if code, out, _ = f.exec("scripts", "runs", "cancel", scriptsTestRunID); code != 0 || !strings.Contains(out, "is cancelled") {
		t.Fatalf("cancel: exit %d, out %q", code, out)
	}

	code, out, _ = f.exec("scripts", "runs", "restart", scriptsTestRunID, "--resume", "--no-limit", "--memory", "8GiB", "--config", `{"minBytes":2}`)
	if code != 0 || !strings.Contains(out, "started script run") {
		t.Fatalf("restart: exit %d, out %q", code, out)
	}
	apiJSONEqual(t, f.last("POST", runPath+"/restart").Body, `{"resume":true,"config":{"minBytes":2},"settings":{"resources":{"memoryMiB":8192},"limit":null}}`)
	if code, _, _ = f.exec("scripts", "runs", "restart", scriptsTestRunID); code != 0 {
		t.Fatalf("plain restart: exit %d", code)
	}
	apiJSONEqual(t, f.last("POST", runPath+"/restart").Body, `{}`)
	if code, _, errOut := f.exec("scripts", "runs", "restart", scriptsTestRunID, "--limit", "5", "--no-limit"); code != ExitValidation || !strings.Contains(errOut, "exclude each other") {
		t.Fatalf("limit and no-limit: exit %d, %q", code, errOut)
	}
}

func TestScriptsRunsLogs(t *testing.T) {
	f := newAPIFake(t)
	logs := "/api/script-runs/" + scriptsTestRunID + "/logs"
	f.sequence("GET", logs, scriptsLogsPage(false, scriptsLogLine(3, "system", "scan is running")), scriptsLogsPage(false))
	code, out, _ := f.exec("scripts", "runs", "logs", scriptsTestRunID, "--after-line", "2")
	if code != 0 || out != "system scan is running\n" || f.calls("GET", logs)[0].Query.Get("afterLine") != "2" {
		t.Fatalf("logs: exit %d, out %q", code, out)
	}

	f.sequence("GET", logs, scriptsLogsPage(false, scriptsLogLine(1, "stdout", "a\x1bb")), scriptsLogsPage(false), scriptsLogsPage(true))
	code, out, _ = f.exec("scripts", "runs", "logs", scriptsTestRunID, "--follow", "-o", "json")
	if code != 0 || out != `{"line":1,"at":"2026-10-22T09:00:00.000Z","stream":"stdout","text":"a\u001bb"}`+"\n" {
		t.Fatalf("logs json: exit %d, out %q", code, out)
	}
	if code, _, _ := f.exec("scripts", "runs", "logs", scriptsTestRunID, "--after-line", "-1"); code != ExitValidation {
		t.Fatalf("negative after-line: exit %d", code)
	}
}

func TestScriptsRunsDownloads(t *testing.T) {
	f := newAPIFake(t)
	content := []byte("domain,policy\n")
	sum := sha256.Sum256(content)
	f.on("GET", "/s3/out", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("the presigned download carried the API token")
		}
		_, _ = w.Write(content)
	})
	f.reply("GET", "/api/script-runs/"+scriptsTestRunID+"/outputs/"+scriptsTestOutID, 200, map[string]any{
		"url": f.srv.URL + "/s3/out", "expiresAt": "2026-10-22T09:10:00.000Z", "name": "../csp.csv", "size": len(content),
		"sha256": hex.EncodeToString(sum[:]), "contentType": "text/csv", "inline": false,
	})
	f.reply("GET", "/api/script-runs/"+scriptsTestRunID, 200, scriptsRunFixture("completed", nil))
	f.reply("GET", "/api/script-runs/"+scriptsTestRunID+"/source", 200, map[string]any{"url": f.srv.URL + "/s3/out", "expiresAt": "2026-10-22T09:10:00.000Z"})
	t.Chdir(t.TempDir())

	code, out, errOut := f.exec("scripts", "runs", "outputs", "get", scriptsTestRunID, scriptsTestOutID)
	if code != 0 || !strings.Contains(out, "saved csp.csv") || f.last("GET", "/api/script-runs/"+scriptsTestRunID+"/outputs/"+scriptsTestOutID).Query.Get("redirect") != "false" {
		t.Fatalf("output: exit %d, out %q, err %q", code, out, errOut)
	}
	if data, err := os.ReadFile("csp.csv"); err != nil || !bytes.Equal(data, content) {
		t.Fatalf("saved %q, %v", data, err)
	}
	if code, out, _ = f.exec("scripts", "runs", "outputs", "get", scriptsTestRunID, scriptsTestOutID, "--file", "-"); code != 0 || out != string(content) {
		t.Fatalf("stdout: exit %d, out %q", code, out)
	}

	// The source is verified against the recorded pack size (11 bytes in the fixture, 14 served).
	code, _, errOut = f.exec("scripts", "runs", "source", scriptsTestRunID)
	if code != ExitPlatform || !strings.Contains(errOut, "download incomplete") {
		t.Fatalf("source size mismatch: exit %d, err %q", code, errOut)
	}
	f.reply("GET", "/api/script-runs/"+scriptsTestRunID, 200, scriptsRunFixture("completed", map[string]any{
		"source": map[string]any{"packSha256": "d41c7e00aa", "packBytes": len(content), "fileCount": 3}}))
	code, out, errOut = f.exec("scripts", "runs", "source", scriptsTestRunID)
	if code != 0 || !strings.Contains(out, "saved csp-report-4e5f6a7b.tar.gz") {
		t.Fatalf("source: exit %d, out %q, err %q", code, out, errOut)
	}
}

func TestScriptsInit(t *testing.T) {
	t.Chdir(t.TempDir())
	app, out, errOut := testApp(nil)
	if code := run(app, "scripts", "init", "csp-report", "--description", "CSP", "-o", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	res := apiDecode[scriptsInitResult](t, out.Bytes())
	if res.Name != "csp-report" || res.Language != "python" {
		t.Fatalf("result %+v", res)
	}
	for _, want := range []string{"scantor-script.yaml", "Dockerfile", "main.py"} {
		found := false
		for _, f := range res.Files {
			found = found || f == want
		}
		if !found {
			t.Errorf("%s missing from %v", want, res.Files)
		}
	}
	manifest, err := os.ReadFile(filepath.Join("csp-report", "scantor-script.yaml"))
	if err != nil || !strings.Contains(string(manifest), "csp-report") {
		t.Fatalf("manifest %q, %v", manifest, err)
	}

	app, _, errOut = testApp(nil)
	if code := run(app, "scripts", "init", "csp-report"); code != ExitValidation {
		t.Fatalf("existing directory: exit %d, %s", code, errOut)
	}
	app, _, errOut = testApp(nil)
	if code := run(app, "scripts", "init", "other", "--language", "go"); code != ExitValidation || !strings.Contains(errOut.String(), "does not support scripts") {
		t.Fatalf("go: exit %d, %s", code, errOut)
	}
}
