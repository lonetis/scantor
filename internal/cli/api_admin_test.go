package cli

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

const apiNodeID = "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"

func apiNodeFixture(name string) map[string]any {
	return map[string]any{
		"id": apiNodeID, "name": name, "builtIn": false, "state": "pending", "endpointProfile": "public", "tokenRotatedAt": nil,
		"pool": "remote", "labels": map[string]string{"region": "eu"}, "maxWorkers": 8, "cordoned": false, "instance": nil, "info": nil,
		"assignmentsRev": 0, "lastSeenAt": nil, "createdBy": nil, "activeWorkers": 0,
		"createdAt": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z",
	}
}

func TestAPINodes(t *testing.T) {
	f := newAPIFake(t)
	join := map[string]any{"dockerRun": "docker run -d --name scantor-node scantor:dev node", "compose": "name: scantor-node\n", "env": map[string]any{"SCANTOR_URL": "http://x", "SCANTOR_NODE_TOKEN": "snt_secret"}}
	f.reply("POST", "/api/nodes", 201, map[string]any{"node": apiNodeFixture("scan-eu-1"), "token": "snt_secret", "join": join})
	code, out, errOut := f.exec("nodes", "create", "scan-eu-1", "--pool", "remote", "--label", "region=eu", "--label", "gpu=", "--max-workers", "8")
	if code != 0 || !strings.Contains(out, "snt_secret") || !strings.Contains(out, "docker run -d --name scantor-node") || !strings.Contains(out, "name: scantor-node") {
		t.Fatalf("create: exit %d, out %q, err %q", code, out, errOut)
	}
	apiJSONEqual(t, f.last("POST", "/api/nodes").Body, `{"name":"scan-eu-1","pool":"remote","labels":{"region":"eu","gpu":""},"maxWorkers":8}`)
	if code, _, _ := f.exec("nodes", "create", "x", "--label", "novalue"); code != ExitValidation {
		t.Fatalf("bad label: exit %d", code)
	}

	// Names resolve through listNodes; ids are used directly.
	f.reply("GET", "/api/nodes", 200, map[string]any{"items": []any{apiNodeFixture("scan-eu-1")}})
	f.reply("GET", "/api/nodes/"+apiNodeID, 200, apiNodeFixture("scan-eu-1"))
	if code, out, _ := f.exec("nodes", "get", "scan-eu-1"); code != 0 || !strings.Contains(out, "region=eu") {
		t.Fatalf("get by name: exit %d, out %q", code, out)
	}
	listCalls := len(f.calls("GET", "/api/nodes"))
	if code, _, _ := f.exec("nodes", "get", apiNodeID); code != 0 || len(f.calls("GET", "/api/nodes")) != listCalls {
		t.Fatalf("get by id: exit %d", code)
	}
	if code, _, errOut := f.exec("nodes", "get", "nope"); code != ExitValidation || !strings.Contains(errOut, `node "nope" not found`) {
		t.Fatalf("unknown name: exit %d, %q", code, errOut)
	}

	f.reply("PATCH", "/api/nodes/"+apiNodeID, 200, apiNodeFixture("scan-eu-2"))
	if code, _, errOut := f.exec("nodes", "update", apiNodeID, "--name", "scan-eu-2", "--no-max-workers", "--cordoned=false", "--label", "zone=a"); code != 0 {
		t.Fatalf("update: exit %d, %q", code, errOut)
	}
	apiJSONEqual(t, f.last("PATCH", "/api/nodes/"+apiNodeID).Body, `{"name":"scan-eu-2","labels":{"zone":"a"},"cordoned":false,"maxWorkers":null}`)
	if code, _, errOut := f.exec("nodes", "update", apiNodeID, "--clear-labels"); code != 0 {
		t.Fatalf("update --clear-labels: exit %d, %q", code, errOut)
	}
	apiJSONEqual(t, f.last("PATCH", "/api/nodes/"+apiNodeID).Body, `{"labels":{}}`)
	for _, args := range [][]string{
		{"nodes", "update", apiNodeID},
		{"nodes", "update", apiNodeID, "--max-workers", "2", "--no-max-workers"},
		{"nodes", "update", apiNodeID, "--label", "a"},
		{"nodes", "update", apiNodeID, "--label", "a=b", "--clear-labels"},
	} {
		if code, _, _ := f.exec(args...); code != ExitValidation {
			t.Errorf("%v: exit %d", args, code)
		}
	}

	f.reply("POST", "/api/nodes/"+apiNodeID+"/token", 200, map[string]any{"node": apiNodeFixture("scan-eu-1"), "token": "snt_new", "join": join})
	if code, out, _ := f.exec("nodes", "token", "rotate", apiNodeID, "-o", "json"); code != 0 || apiDecode[api.NodeWithToken](t, []byte(out)).Token != "snt_new" {
		t.Fatalf("rotate: exit %d, out %q", code, out)
	}
	revoked := apiNodeFixture("scan-eu-1")
	revoked["state"] = "revoked"
	f.reply("DELETE", "/api/nodes/"+apiNodeID+"/token", 200, revoked)
	if code, out, _ := f.exec("nodes", "token", "revoke", apiNodeID); code != 0 || !strings.Contains(out, "(revoked)") {
		t.Fatalf("revoke: exit %d, out %q", code, out)
	}
	f.fail("DELETE", "/api/nodes/"+apiNodeID+"/token", 409, "builtInNode", "not allowed on the built-in node", nil)
	if code, _, _ := f.exec("nodes", "token", "revoke", apiNodeID); code != ExitValidation {
		t.Fatalf("built-in: exit %d", code)
	}
	f.reply("GET", "/api/nodes/"+apiNodeID+"/join", 200, join)
	if code, out, _ := f.exec("nodes", "join", apiNodeID); code != 0 || !strings.Contains(out, "docker compose up -d") {
		t.Fatalf("join: exit %d, out %q", code, out)
	}
	f.on("DELETE", "/api/nodes/"+apiNodeID, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	if code, out, _ := f.exec("nodes", "delete", apiNodeID); code != 0 || !strings.Contains(out, "deleted node") {
		t.Fatalf("delete: exit %d, out %q", code, out)
	}
	f.fail("GET", "/api/nodes", 403, "adminRequired", "admin only", nil)
	if code, _, _ := f.exec("nodes", "list"); code != ExitValidation {
		t.Fatalf("non-admin: exit %d", code)
	}
}

func TestAPIJobsAndWhoami(t *testing.T) {
	f := newAPIFake(t)
	job := map[string]any{"id": "job-1", "kind": "export", "subject": map[string]any{"kind": "export", "id": "e1"}, "state": "running",
		"progress": map[string]any{"done": 5, "total": nil}, "attempts": 1, "error": nil, "createdAt": "2026-10-21T10:00:00.000Z", "startedAt": nil, "finishedAt": nil}
	f.reply("GET", "/api/jobs", 200, map[string]any{"items": []any{job}, "nextCursor": nil})
	code, out, _ := f.exec("jobs", "list", "--kind", "export", "--state", "running", "--user", "u2")
	q := f.last("GET", "/api/jobs").Query
	if code != 0 || !strings.Contains(out, "job-1") || q.Get("kind") != "export" || q.Get("state") != "running" || q.Get("userId") != "u2" {
		t.Fatalf("jobs list: exit %d, out %q, query %v", code, out, q)
	}
	f.reply("GET", "/api/jobs/job-1", 200, job)
	if code, out, _ := f.exec("jobs", "get", "job-1"); code != 0 || !strings.Contains(out, "running") {
		t.Fatalf("jobs get: exit %d, out %q", code, out)
	}
	if q := f.last("GET", "/api/jobs/job-1").Query; q.Get("wait") != "" {
		t.Fatalf("get without --wait long-polled: %v", q)
	}

	f.reply("GET", "/api/account", 200, map[string]any{"id": "u1", "email": "ada@example.com", "name": "Ada", "role": "admin", "canRunPrivileged": true, "maxWorkers": 50, "credentials": map[string]any{"hasPassword": true, "passkeyCount": 0}, "createdAt": "2026-10-21T10:00:00.000Z"})
	code, out, _ = f.exec("whoami", "-o", "json")
	who := apiDecode[map[string]any](t, []byte(out))
	if code != 0 || who["url"] != f.srv.URL || who["email"] != "ada@example.com" {
		t.Fatalf("whoami: exit %d, out %q", code, out)
	}
	f.reply("GET", "/api/info", 200, map[string]any{"version": "1.4.0", "publicUrl": "https://scantor.example.com", "editorUrl": "https://editor.example.com", "mcpUrl": nil, "registryPublicHost": "registry.example.com", "cliImage": "ghcr.io/lonetis/scantor:1.4.0",
		"features": map[string]any{"passkeys": true, "mcp": false, "mcpOAuth": false, "editor": true}, "limits": map[string]any{"maxWorkersPerScan": 100, "maxProcessesPerWorker": 64, "maxResultBytes": 1048576, "maxFileBytes": 1073741824, "scanConfirmThreshold": 1000000, "waitMaxSeconds": 120}, "user": map[string]any{"id": "u1", "role": "admin"}})
	if code, out, _ := f.exec("instance"); code != 0 || !strings.Contains(out, "editor, passkeys") || !strings.Contains(out, "ghcr.io/lonetis/scantor:1.4.0") {
		t.Fatalf("instance: exit %d, out %q", code, out)
	}
}

func TestAPIDocsCLI(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs/guide"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "tasks/echo"), 0o755); err != nil {
		t.Fatal(err)
	}
	guide := "# Guide\n\n<!-- scantor:include tasks/echo/main.py -->\n```python\nold\n```\n<!-- scantor:include:end -->\n\nafter\n"
	if err := os.WriteFile(filepath.Join(root, "docs/guide/authoring-python.md"), []byte(guide), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tasks/echo/main.py"), []byte("print('new')\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	app, out, errOut := testApp(nil)
	if code := run(app, "docs", "cli", "--root", root, "--check"); code != ExitValidation || !strings.Contains(out.String(), "stale docs/guide/cli.md") || !strings.Contains(out.String(), "stale docs/guide/authoring-python.md") {
		t.Fatalf("check stale: exit %d, out %q, err %q", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(filepath.Join(root, "docs/guide/cli.md")); !os.IsNotExist(err) {
		t.Fatal("--check wrote a file")
	}
	app, out, errOut = testApp(nil)
	if code := run(app, "docs", "cli", "--root", root); code != 0 {
		t.Fatalf("write: exit %d, out %q, err %q", code, out.String(), errOut.String())
	}
	refreshed, _ := os.ReadFile(filepath.Join(root, "docs/guide/authoring-python.md"))
	if string(refreshed) != "# Guide\n\n<!-- scantor:include tasks/echo/main.py -->\n```python\nprint('new')\n```\n<!-- scantor:include:end -->\n\nafter\n" {
		t.Fatalf("refreshed guide:\n%s", refreshed)
	}
	reference, _ := os.ReadFile(filepath.Join(root, "docs/guide/cli.md"))
	for _, want := range []string{"# CLI reference", "## scantor scans start", "## scantor tasks files put", "## scantor nodes token rotate", "(#scantor-scans-retry-failed)", "## scantor completion", "&lt;task&gt;@&lt;number&gt;"} {
		if !strings.Contains(string(reference), want) {
			t.Errorf("reference lacks %q", want)
		}
	}
	for _, unwanted := range []string{"## scantor docs", "## scantor help", "Auto generated by spf13/cobra", "addressed as <task>"} {
		if strings.Contains(string(reference), unwanted) {
			t.Errorf("reference contains %q", unwanted)
		}
	}
	app, out, _ = testApp(nil)
	if code := run(app, "docs", "cli", "--root", root, "--check"); code != 0 || !strings.Contains(out.String(), "up to date") {
		t.Fatalf("check after write: exit %d, out %q", code, out.String())
	}

	// The docs command is hidden from help.
	app, out, _ = testApp(nil)
	if run(app, "--help"); strings.Contains(out.String(), "docs") {
		t.Fatalf("help lists docs:\n%s", out.String())
	}
}

func TestAPIRefreshIncludes(t *testing.T) {
	files := map[string]string{"a.go": "x := \"```\"\n", "b.ts": "const b = 1", "c.yaml": "k: v\n"}
	read := func(p string) ([]byte, error) {
		if s, ok := files[p]; ok {
			return []byte(s), nil
		}
		return nil, os.ErrNotExist
	}
	in := "<!-- scantor:include a.go -->\n<!-- scantor:include:end -->\n" +
		"<!-- scantor:include b.ts -->\n```ts\nstale\n```\n<!-- scantor:include:end -->\n" +
		"<!-- scantor:include c.yaml -->\n<!-- scantor:include:end -->\n"
	got, err := apiRefreshIncludes([]byte(in), "g.md", read)
	if err != nil {
		t.Fatal(err)
	}
	want := "<!-- scantor:include a.go -->\n````go\nx := \"```\"\n````\n<!-- scantor:include:end -->\n" +
		"<!-- scantor:include b.ts -->\n```ts\nconst b = 1\n```\n<!-- scantor:include:end -->\n" +
		"<!-- scantor:include c.yaml -->\n```yaml\nk: v\n```\n<!-- scantor:include:end -->\n"
	if string(got) != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	for name, bad := range map[string]string{
		"no end":       "<!-- scantor:include a.go -->\ntext\n",
		"stray end":    "<!-- scantor:include:end -->\n",
		"nested":       "<!-- scantor:include a.go -->\n<!-- scantor:include b.ts -->\n<!-- scantor:include:end -->\n",
		"escaping":     "<!-- scantor:include ../secret -->\n<!-- scantor:include:end -->\n",
		"absolute":     "<!-- scantor:include /etc/passwd -->\n<!-- scantor:include:end -->\n",
		"missing file": "<!-- scantor:include nope.go -->\n<!-- scantor:include:end -->\n",
	} {
		if _, err := apiRefreshIncludes([]byte(bad), "g.md", read); err == nil || ExitCode(err) != ExitValidation {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

// Every public command of this command set has a short and a long description, so the generated
// reference is complete.
func TestAPICommandsDocumented(t *testing.T) {
	app, _, _ := testApp(nil)
	root := newRootCommand(app)
	var walk func(cmd *cobra.Command)
	walk = func(cmd *cobra.Command) {
		for _, c := range cmd.Commands() {
			if !c.IsAvailableCommand() {
				continue
			}
			switch strings.Fields(c.CommandPath())[1] {
			case "tasks", "revisions", "scans", "analyses", "export", "exports", "files", "uploads", "nodes", "jobs", "whoami", "instance":
				if c.Short == "" || (!c.HasSubCommands() && c.Long == "") {
					t.Errorf("%s lacks a description", c.CommandPath())
				}
			}
			walk(c)
		}
	}
	walk(root)
}
