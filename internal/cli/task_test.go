package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// writeTaskDir creates a valid Python task folder.
func writeTaskDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	base := map[string]string{
		"scantor.yaml":  "scantor: 1\nname: echo\nlanguage: python\n",
		"Dockerfile":    "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n",
		"main.py":       "import scantor\n",
		".dockerignore": ".git/\n",
	}
	for k, v := range files {
		base[k] = v
	}
	for name, content := range base {
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

// pipelineEvents decodes NDJSON task-pipeline events.
func pipelineEvents(t *testing.T, data string) []taskpipe.Event {
	t.Helper()
	var out []taskpipe.Event
	for _, line := range strings.Split(strings.TrimSpace(data), "\n") {
		if line == "" {
			continue
		}
		var ev taskpipe.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("event %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

func TestTaskPackCommand(t *testing.T) {
	dir := writeTaskDir(t, nil)
	app, out, errOut := testApp(nil)
	if code := run(app, "task", "pack", dir); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	events := pipelineEvents(t, out.String())
	last := events[len(events)-1]
	if last.Type != taskpipe.EventResult || !last.Result.OK || last.Result.Pack.FileCount != 4 {
		t.Fatalf("result %+v", last)
	}

	// -o file writes the archive; the events stay on stdout.
	archive := filepath.Join(t.TempDir(), "echo.tgz")
	app, out, _ = testApp(nil)
	if code := run(app, "task", "pack", dir, "-o", archive, "--events", "text"); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(out.String(), "[result] ok: 4 files, sha256 "+last.Result.Pack.PackSHA256) {
		t.Fatalf("text events: %s", out)
	}
	info, err := os.Stat(archive)
	if err != nil || info.Size() != last.Result.Pack.PackBytes || info.Mode().Perm() != 0o644 {
		t.Fatalf("archive %v %v", info, err)
	}

	// -o - writes the archive to stdout and the events to stderr; check-static reads it from stdin.
	app, out, errOut = testApp(nil)
	if code := run(app, "task", "pack", dir, "-o", "-"); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !bytes.HasPrefix(out.Bytes(), []byte{0x1f, 0x8b}) || !strings.Contains(errOut.String(), `"type":"result"`) {
		t.Fatalf("stdout is not the tar.gz or the events are not on stderr")
	}
	app, out2, _ := testApp(nil)
	app.Stdin = bytes.NewReader(out.Bytes())
	if code := run(app, "task", "check-static", "-", "--expect-name", "echo"); code != 0 {
		t.Fatalf("check-static from stdin: exit %d: %s", code, out2)
	}
	app, _, _ = testApp(nil)
	if code := run(app, "task", "check-static", archive, "--expect-name", "other"); code != 2 {
		t.Fatalf("check-static of a pack file with a wrong name: exit %d, want 2", code)
	}
}

func TestTaskPackFailureLeavesNoFile(t *testing.T) {
	dir := writeTaskDir(t, nil)
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "evil")); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "echo.tgz")
	app, out, _ := testApp(nil)
	if code := run(app, "task", "pack", dir, "-o", archive); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Fatal("a failed pack must not leave an archive")
	}
	events := pipelineEvents(t, out.String())
	if e := events[0]; e.Type != taskpipe.EventError || e.Error.File != "evil" || e.Error.Phase != "pack" {
		t.Fatalf("first event %+v", e)
	}
	entries, _ := os.ReadDir(filepath.Dir(archive))
	if len(entries) != 0 {
		t.Fatalf("leftovers: %v", entries)
	}
}

func TestTaskCheckStaticCommand(t *testing.T) {
	dir := writeTaskDir(t, map[string]string{"Dockerfile": "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nVOLUME /data\nCMD [\"x\"]\n"})
	app, out, _ := testApp(nil)
	if code := run(app, "task", "check-static", dir, "--events", "text"); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	want := []string{
		"[static] warning: Dockerfile:4: CMD is ignored; the runtime is the entrypoint (W1)",
		"[static] error: Dockerfile:3: VOLUME is not allowed: anonymous volumes leak worker disk space (D11)",
		"[result] failed with 1 error(s)",
	}
	for _, w := range want {
		if !strings.Contains(out.String(), w) {
			t.Errorf("output lacks %q:\n%s", w, out)
		}
	}
	app, _, _ = testApp(nil)
	if code := run(app, "task", "check-static", writeTaskDir(t, map[string]string{"scantor.yaml": "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  privileged: true\n"}), "--allow-privileged"); code != 0 {
		t.Fatalf("--allow-privileged: exit %d", code)
	}
}

func TestTaskBuildUsage(t *testing.T) {
	dir := writeTaskDir(t, nil)
	for _, args := range [][]string{
		{"task", "build", dir},
		{"task", "build", dir, "--tag", "x:y", "--push-gate", "3"},
		{"task", "build", dir, "--tag", "x:y", "--push", "--push-gate", "1"},
		{"task", "build", dir, "--tag", "x:y", "--events", "json"},
		{"task", "pack"},
	} {
		app, _, errOut := testApp(nil)
		if code := run(app, args...); code != 2 {
			t.Errorf("%v: exit %d, want 2 (%s)", args, code, errOut)
		}
	}
}

func TestTaskCommandsAreHidden(t *testing.T) {
	app, out, _ := testApp(nil)
	if code := run(app, "--help"); code != 0 {
		t.Fatal(code)
	}
	if strings.Contains(out.String(), "\n  task ") {
		t.Fatalf("the task group must be hidden:\n%s", out)
	}
	for _, cmd := range []string{"validate", "push", "dev"} {
		if !strings.Contains(out.String(), "\n  "+cmd+" ") {
			t.Errorf("%s is not listed", cmd)
		}
	}
}

func TestOpenTaskInput(t *testing.T) {
	app, _, _ := testApp(nil)
	in, done, err := openTaskInput(app, "-")
	if err != nil || in.Archive == nil || in.Dir != "" {
		t.Fatalf("stdin: %+v %v", in, err)
	}
	done()
	dir := t.TempDir()
	if in, _, err := openTaskInput(app, dir); err != nil || in.Dir != dir {
		t.Fatalf("dir: %+v %v", in, err)
	}
	missing := filepath.Join(dir, "missing")
	if in, _, err := openTaskInput(app, missing); err != nil || in.Dir != missing {
		t.Fatalf("a missing path is reported by the pack phase: %+v %v", in, err)
	}
	file := filepath.Join(dir, "x.tgz")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	in, done, err = openTaskInput(app, file)
	if err != nil || in.Archive == nil {
		t.Fatalf("file: %+v %v", in, err)
	}
	done()
}

func TestDevImageTag(t *testing.T) {
	if got := devImageTag("echo", "a3f1b2c3d4e5f60718293a4b5c6d7e8f"); got != "scantor-dev/echo:a3f1b2c3d4e5" {
		t.Fatalf("tag %s", got)
	}
	if got := devDebugImageTag("echo", "a3f1b2c3d4e5f60718293a4b5c6d7e8f"); got != "scantor-dev/echo:a3f1b2c3d4e5-debug" {
		t.Fatalf("debug tag %s", got)
	}
}

func TestTaskPipelineConfig(t *testing.T) {
	cfg, err := LoadConfig(func(k string) string {
		return map[string]string{
			"SCANTOR_TASK_MAX_FILES":         "10",
			"SCANTOR_REGISTRY_PUSH_PASSWORD": "pw",
			"SCANTOR_IMAGE_TAG":              "1.4.0",
			"SCANTOR_IMAGE_PREFIX":           "ghcr.io/lonetis/",
		}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	pc := taskPipelineConfig(cfg)
	if pc.Pack.MaxFiles != 10 || pc.RegistryPushPassword != "pw" || pc.Images.Tag != "1.4.0" || pc.BuildTimeout != DefaultBuildTimeout ||
		pc.ManifestLimits.MaxProcessesPerWorker != 64 || pc.RegistryPublicHost != DefaultRegistryPublicHost {
		t.Fatalf("config %+v", pc)
	}
	if r := taskRuntimeBinary(nil, cfg); r.Images != cfg.Images || r.Executable == "" {
		t.Fatalf("runtime %+v", r)
	}
}
