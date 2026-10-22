package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestInitCommand(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "My Echo Task")
	app, out, errOut := testApp(nil)
	if code := run(app, "init", dir, "--language", "python", "--description", "Echoes"); code != 0 {
		t.Fatalf("init exited %d: %s", code, errOut)
	}
	if !strings.Contains(out.String(), `Created task "my-echo-task"`) || !strings.Contains(out.String(), "scantor dev run "+dir) {
		t.Fatalf("human output:\n%s", out)
	}
	manifest, err := os.ReadFile(filepath.Join(dir, "scantor.yaml"))
	if err != nil || !strings.Contains(string(manifest), "name: my-echo-task") || !strings.Contains(string(manifest), `description: "Echoes"`) {
		t.Fatalf("scantor.yaml %q (%v)", manifest, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.py")); err != nil {
		t.Fatal(err)
	}

	// An existing non-empty directory is refused.
	app, _, errOut = testApp(nil)
	if code := run(app, "init", dir, "--language", "python"); code != ExitValidation || !strings.Contains(errOut.String(), "not empty") {
		t.Fatalf("second init exited %d: %s", code, errOut)
	}
}

func TestInitCommandDefaultsAndJSON(t *testing.T) {
	t.Chdir(t.TempDir())
	app, out, errOut := testApp(map[string]string{"SCANTOR_IMAGE_PREFIX": "registry.example/", "SCANTOR_IMAGE_TAG": "7.0.0"})
	if code := run(app, "-o", "json", "init", "--name", "rdns", "--language", "go", "--template", "cidr"); code != 0 {
		t.Fatalf("init exited %d: %s", code, errOut)
	}
	var res initResult
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("stdout %q: %v", out, err)
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if res.Name != "rdns" || res.Language != "go" || res.Template != "cidr" || filepath.Base(res.Dir) != "rdns" ||
		!slices.Contains(res.Files, "main.go") || !slices.Contains(res.Files, "go.mod") {
		t.Fatalf("result %+v (cwd %s)", res, wd)
	}
	devcontainer, err := os.ReadFile(filepath.Join("rdns", ".devcontainer", "devcontainer.json"))
	if err != nil || !strings.Contains(string(devcontainer), "registry.example/scantor-base-go:7.0.0") {
		t.Fatalf("devcontainer.json does not use the image override (%v)", err)
	}
}

func TestInitCommandErrors(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, args := range [][]string{
		{"init", "x"},
		{"init", "--language", "python"},
		{"init", "x", "--language", "rust"},
		{"init", "x", "--language", "python", "--template", "nope"},
		{"init", "--name", "Bad_Name", "--language", "python"},
		{"init", "___", "--language", "python"},
		{"init", "a", "b", "--language", "python"},
	} {
		app, _, errOut := testApp(nil)
		if code := run(app, args...); code != ExitValidation {
			t.Errorf("%v exited %d: %s", args, code, errOut)
		}
	}
	entries, err := os.ReadDir(".")
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed inits left files behind: %v %v", entries, err)
	}
}

func TestSlugifyTaskName(t *testing.T) {
	for in, want := range map[string]string{
		"echo":                         "echo",
		"My Echo Task":                 "my-echo-task",
		"--x__y--":                     "x-y",
		"Ünïcode":                      "n-code",
		strings.Repeat("a", 70):        strings.Repeat("a", 64),
		strings.Repeat("a", 63) + "-b": strings.Repeat("a", 63),
		"___":                          "",
	} {
		if got := slugifyTaskName(in); got != want {
			t.Errorf("slugifyTaskName(%q) = %q, want %q", in, got, want)
		}
	}
}
