package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
	"github.com/lonetis/scantor/internal/version"
)

const testScriptManifest = "scantor: 1\nname: report\nlanguage: python\n"

func TestFolderRel(t *testing.T) {
	if got := TaskFolder("echo").Rel(); got != "echo" {
		t.Fatalf("task rel %q", got)
	}
	if got := ScriptFolder("echo").Rel(); got != ".scripts/echo" {
		t.Fatalf("script rel %q", got)
	}
	wantCode(t, ScriptFolder("Bad_Name").Validate(), CodeInvalidArgument)
	wantCode(t, ScriptFolder("latest").Validate(), CodeInvalidArgument)
	if err := ScriptFolder("upload").Validate(); err == nil || !strings.Contains(err.Error(), "invalid script name") {
		t.Fatalf("reserved script name: %v", err)
	}
	if _, err := ParseFolderKind("job"); err == nil {
		t.Fatal("ParseFolderKind accepted an unknown kind")
	}
}

// TestRenderEveryScriptScaffold renders the script scaffold of every language with script support and
// checks that the result passes the script build's static checks unchanged.
func TestRenderEveryScriptScaffold(t *testing.T) {
	table, err := languages.Load()
	if err != nil {
		t.Fatal(err)
	}
	scriptLanguages := table.WithScripts()
	if len(scriptLanguages) == 0 {
		t.Fatal("no language supports scripts")
	}
	description := `Counts "things": with YAML-special characters # and ü`
	for _, lang := range scriptLanguages {
		t.Run(lang.Name, func(t *testing.T) {
			name := "s-" + lang.Name
			dir := filepath.Join(t.TempDir(), name)
			if err := RenderScriptInto(dir, ScriptScaffoldRequest{Name: name, Language: lang.Name, Description: description}); err != nil {
				t.Fatalf("RenderScriptInto: %v", err)
			}
			for _, f := range []string{manifest.ScriptFileName, "Dockerfile", lang.Script.Entry, "models.py", "AGENTS.md", "requirements.txt", ".dockerignore"} {
				if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
					t.Errorf("the script scaffold lacks %s: %v", f, err)
				}
			}
			for _, e := range listTestTree(t, dir) {
				if e.Type != TypeFile {
					continue
				}
				data := readTestFile(t, filepath.Join(dir, filepath.FromSlash(e.Path)))
				if strings.Contains(data, "[[") || strings.Contains(data, "<no value>") || strings.HasSuffix(e.Path, templateSuffix) {
					t.Errorf("%s contains unrendered template syntax", e.Path)
				}
				if e.Mode != 0o644 {
					t.Errorf("%s has mode %o", e.Path, e.Mode)
				}
			}
			data := readTestFile(t, filepath.Join(dir, manifest.ScriptFileName))
			if modeline := "# yaml-language-server: $schema=" + ScriptManifestSchemaURL(version.Version) + "\n"; !strings.HasPrefix(data, modeline) {
				t.Errorf("%s does not start with the modeline:\n%s", manifest.ScriptFileName, data)
			}
			agents := readTestFile(t, filepath.Join(dir, "AGENTS.md"))
			if !strings.Contains(agents, name) || !strings.Contains(agents, lang.Script.Guide) {
				t.Errorf("AGENTS.md does not name the script and link %s:\n%s", lang.Script.Guide, agents)
			}

			pack, err := taskpipe.PackDir(bg, dir, taskpipe.PackLimits{})
			if err != nil {
				t.Fatalf("PackDir: %v", err)
			}
			defer pack.Close()
			res := taskpipe.CheckScriptStatic(pack, taskpipe.ScriptStaticOptions{ExpectName: name}, taskpipe.Config{ManifestLimits: manifest.DefaultLimits()})
			if !res.OK() {
				t.Fatalf("script static errors: %+v", res.Errors)
			}
			if len(res.Warnings) > 0 {
				t.Fatalf("script static warnings: %v", res.Warnings)
			}
			if res.Script.Manifest.Description != description || res.Script.Manifest.Entry != lang.Script.Entry {
				t.Fatalf("manifest %+v", res.Script.Manifest)
			}
		})
	}
}

func TestRenderScriptScaffoldRejections(t *testing.T) {
	for name, req := range map[string]ScriptScaffoldRequest{
		"language without scripts": {Name: "x", Language: "go"},
		"unknown language":         {Name: "x", Language: "rust"},
		"invalid name":             {Name: "Bad_Name", Language: "python"},
		"uuid name":                {Name: "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", Language: "python"},
		"description too long":     {Name: "x", Language: "python", Description: strings.Repeat("d", 1025)},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := RenderScriptScaffold(req)
			wantCode(t, err, CodeInvalidArgument)
		})
	}
	dir := t.TempDir()
	writeTree(t, dir, map[string]node{"keep.txt": file("x")})
	wantCode(t, RenderScriptInto(dir, ScriptScaffoldRequest{Name: "x", Language: "python"}), CodeExists)
}

func TestScriptFolderOperations(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	if _, err := ws.ScaffoldScript(bg, ScriptScaffoldRequest{Name: "report", Language: "python"}); err != nil {
		t.Fatalf("ScaffoldScript: %v", err)
	}
	folder := filepath.Join(ws.dir, ScriptsDir, "report")
	if _, err := os.Stat(filepath.Join(folder, manifest.ScriptFileName)); err != nil {
		t.Fatal(err)
	}
	_, err := ws.ScaffoldScript(bg, ScriptScaffoldRequest{Name: "report", Language: "python"})
	wantCode(t, err, CodeExists)

	// A task of the same name is a different folder.
	if _, err := ws.Scaffold(bg, ScaffoldRequest{Name: "report", Language: "python"}); err != nil {
		t.Fatalf("task with the script's name: %v", err)
	}

	list, err := ws.List(bg, ScriptFolder("report"), ListOptions{Recursive: true, MaxEntries: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(list.Entries, func(e FileEntry) bool { return e.Path == "main.py" }) {
		t.Fatalf("list %+v lacks main.py", list.Entries)
	}
	read, err := ws.Read(bg, ScriptFolder("report"), manifest.ScriptFileName, 0)
	if err != nil || !strings.Contains(read.Content, "name: report") {
		t.Fatalf("read %+v (%v)", read, err)
	}

	res, err := ws.WriteFiles(bg, ScriptFolder("fresh"), true, writeRequest(t, map[string]any{manifest.ScriptFileName: testScriptManifest}))
	if err != nil {
		t.Fatalf("write-files --create: %v", err)
	}
	var pack bytes.Buffer
	sum, err := ws.Snapshot(bg, ScriptFolder("fresh"), &pack)
	if err != nil {
		t.Fatal(err)
	}
	if sum.PackSHA256 != res.Workspace.PackSHA256 || sum.PackSHA256 != packHash(t, filepath.Join(ws.dir, ScriptsDir, "fresh")) {
		t.Fatalf("snapshot %+v, write %+v", sum, res.Workspace)
	}
	_, err = ws.WriteFiles(bg, ScriptFolder("missing"), false, writeRequest(t, map[string]any{"a.txt": "x"}))
	wantCode(t, err, CodeNotFound)

	if _, err := ws.DeleteFiles(bg, ScriptFolder("fresh"), "", true); err != nil {
		t.Fatal(err)
	}
	mustNotExist(t, filepath.Join(ws.dir, ScriptsDir, "fresh"))
	if _, err := ws.DeleteFiles(bg, ScriptFolder("fresh"), "", true); err != nil {
		t.Fatalf("deleting a missing script folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(ws.dir, "report", manifest.FileName)); err != nil {
		t.Fatalf("the task folder of the same name is gone: %v", err)
	}
}

func TestScriptsDirSymlinkRefused(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	outside := t.TempDir()
	writeTree(t, outside, map[string]node{"report/" + manifest.ScriptFileName: file(testScriptManifest)})
	writeTree(t, ws.dir, map[string]node{ScriptsDir: symlink(outside)})
	_, err := ws.List(bg, ScriptFolder("report"), ListOptions{Recursive: true})
	wantCode(t, err, CodeInvalidPath)
	_, err = ws.WriteFiles(bg, ScriptFolder("other"), true, writeRequest(t, map[string]any{"a.txt": "x"}))
	wantCode(t, err, CodeInvalidPath)
	_, err = ws.ScaffoldScript(bg, ScriptScaffoldRequest{Name: "other", Language: "python"})
	wantCode(t, err, CodeInvalidPath)
	mustNotExist(t, filepath.Join(outside, "other"))
}

func TestExtractAndCommitScript(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	var archive bytes.Buffer
	if err := buildTarGz(t, &archive, []archiveSpec{
		{Name: "report-main/", Type: "dir"},
		{Name: "report-main/" + manifest.ScriptFileName, Type: "file", Content: testScriptManifest},
		{Name: "report-main/Dockerfile", Type: "file", Content: "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\n"},
		{Name: "report-main/main.py", Type: "file", Content: "script = None\n"},
	}); err != nil {
		t.Fatal(err)
	}
	res, err := ws.ExtractScript(bg, "up1", &archive)
	if err != nil {
		t.Fatalf("ExtractScript: %v", err)
	}
	if res.Manifest.Name != "report" || res.Manifest.Entry != "main.py" || res.Staging != "up1" {
		t.Fatalf("extract result %+v", res)
	}
	commit, err := ws.Commit(bg, CommitOptions{Staging: "up1", Script: "report", Expect: ExpectAbsent})
	if err != nil {
		t.Fatalf("Commit --script: %v", err)
	}
	if commit.Script != "report" || commit.Task != "" || !commit.Changed || commit.Workspace.PackSHA256 != res.Summary.PackSHA256 {
		t.Fatalf("commit result %+v", commit)
	}
	if got := readTestFile(t, filepath.Join(ws.dir, ScriptsDir, "report", "main.py")); got != "script = None\n" {
		t.Fatalf("main.py %q", got)
	}

	// A task archive is not a script.
	var task bytes.Buffer
	if err := buildTarGz(t, &task, []archiveSpec{{Name: manifest.FileName, Type: "file", Content: testManifest}}); err != nil {
		t.Fatal(err)
	}
	_, err = ws.ExtractScript(bg, "up2", &task)
	e := codeOf(t, err, CodeManifestInvalid)
	if !strings.Contains(e.Message, manifest.ScriptFileName) || !strings.Contains(e.Message, "script folder") {
		t.Fatalf("message %q", e.Message)
	}
	mustNotExist(t, filepath.Join(ws.dir, StagingDir, "up2"))

	// An invalid script manifest names scantor-script.yaml in its errors.
	var bad bytes.Buffer
	if err := buildTarGz(t, &bad, []archiveSpec{{Name: manifest.ScriptFileName, Type: "file", Content: "scantor: 1\nname: report\nlanguage: go\n"}}); err != nil {
		t.Fatal(err)
	}
	_, err = ws.ExtractScript(bg, "up3", &bad)
	e = codeOf(t, err, CodeManifestInvalid)
	if !strings.Contains(e.Message, "scripts") {
		t.Fatalf("message %q", e.Message)
	}

	_, err = ws.Commit(bg, CommitOptions{Staging: "up1", Task: "report", Script: "report", Expect: ExpectAny})
	wantCode(t, err, CodeInvalidArgument)
}
