package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/taskpipe"
)

// writeScriptDir creates a valid Python script folder.
func writeScriptDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	base := map[string]string{
		"scantor-script.yaml": "scantor: 1\nname: csp-stats\nlanguage: python\n",
		"Dockerfile":          "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n",
		"main.py":             "from scantor.script import Script\n",
		".dockerignore":       ".git/\n",
	}
	for k, v := range files {
		base[k] = v
	}
	for name, content := range base {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestScriptBuildUsage(t *testing.T) {
	dir := writeScriptDir(t, nil)
	for _, args := range [][]string{
		{"script", "build", dir, "--expect-name", "csp-stats"},
		{"script", "build", dir, "--tag", "scripts/x:y"},
		{"script", "build", dir, "--tag", "scripts/x:y", "--expect-name", "csp-stats", "--events", "json"},
		{"script", "build", "--tag", "scripts/x:y", "--expect-name", "csp-stats"},
		{"script", "build", dir, "--tag", "scripts/x:y", "--expect-name", "csp-stats", "--push"},
	} {
		app, _, errOut := testApp(nil)
		if code := run(app, args...); code != 2 {
			t.Errorf("%v: exit %d, want 2 (%s)", args, code, errOut)
		}
	}
}

// Content errors are found before the build touches the Docker daemon, and the result event names the
// script manifest.
func TestScriptBuildReportsContentErrors(t *testing.T) {
	dir := writeTaskDir(t, nil)
	app, out, errOut := testApp(nil)
	if code := run(app, "script", "build", dir, "--tag", "scripts/x:y", "--expect-name", "echo", "--events", "ndjson"); code != 2 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	var last taskpipe.ScriptEvent
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatal(err)
	}
	res := last.Result
	if last.Type != taskpipe.EventResult || res == nil || res.OK || len(res.Errors) != 1 || res.Errors[0].Phase != api.BuildPhaseStatic ||
		res.Errors[0].File != "scantor-script.yaml" || res.Pack == nil || res.Manifest != nil || res.Image != nil {
		t.Fatalf("result %+v", res)
	}

	app, out, _ = testApp(nil)
	if code := run(app, "script", "build", writeScriptDir(t, nil), "--tag", "scripts/x:y", "--expect-name", "other", "--events", "text"); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(out.String(), "[result] failed with 1 error(s)\n  [static] scantor-script.yaml:2:7: name \"csp-stats\" does not match script \"other\"") {
		t.Fatalf("text events:\n%s", out)
	}
}

func TestScriptCommandsAreHidden(t *testing.T) {
	app, out, _ := testApp(nil)
	if code := run(app, "--help"); code != 0 {
		t.Fatal(code)
	}
	if strings.Contains(out.String(), "\n  script ") {
		t.Fatalf("the script group must be hidden:\n%s", out)
	}
	root := newRootCommand(app)
	for _, path := range [][]string{{"script", "build"}, {"runtime", "script"}} {
		if cmd, _, err := root.Find(path); err != nil || cmd.Name() != path[1] {
			t.Errorf("%v is not registered (%v)", path, err)
		}
	}
}

func TestRuntimeScriptCommand(t *testing.T) {
	app, _, _ := testApp(nil)
	cmd, _, err := newRootCommand(app).Find([]string{"runtime", "script"})
	if err != nil || !ownsSignals(cmd) {
		t.Fatalf("runtime script must handle signals itself (%v)", err)
	}

	app, _, errOut := testApp(nil)
	if code := run(app, "runtime", "script"); code != ExitValidation {
		t.Fatalf("without --entry: exit %d (%s)", code, errOut)
	}

	// A base image without SCANTOR_SCRIPT_CMD: exit 2 with the reason, before anything starts.
	app, out, errOut := testApp(map[string]string{"TMPDIR": t.TempDir()})
	if code := run(app, "runtime", "script", "--entry", "main.py"); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if out.Len() != 0 || errOut.String() != "scantor: this base image does not support scripts: SCANTOR_SCRIPT_CMD is not set\n" {
		t.Fatalf("stdout %q stderr %q", out, errOut)
	}
}
