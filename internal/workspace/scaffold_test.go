package workspace

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
	"github.com/lonetis/scantor/internal/version"
)

func TestTemplates(t *testing.T) {
	got, err := Templates()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"cidr", "crux", "custom", "list", "range", "repeat", "single", "tranco"}
	if !slices.Equal(got, want) {
		t.Fatalf("templates %v, want %v", got, want)
	}
}

func TestManifestSchemaURL(t *testing.T) {
	if got := ManifestSchemaURL("1.4.0"); got != "https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json" {
		t.Fatalf("release URL %s", got)
	}
	if got := ManifestSchemaURL("dev"); got != "https://raw.githubusercontent.com/lonetis/scantor/main/schemas/task-manifest.schema.json" {
		t.Fatalf("dev URL %s", got)
	}
}

// TestRenderEveryScaffold renders every language × template and checks that the result passes the
// task pipeline's static checks (manifest, required files, Dockerfile policy) unchanged.
func TestRenderEveryScaffold(t *testing.T) {
	table, err := languages.Load()
	if err != nil {
		t.Fatal(err)
	}
	templates, err := Templates()
	if err != nil {
		t.Fatal(err)
	}
	description := `Scans "things": with YAML-special characters # and ü`
	for _, lang := range table.All() {
		for _, tmpl := range templates {
			t.Run(lang.Name+"/"+tmpl, func(t *testing.T) {
				t.Parallel()
				name := "t-" + lang.Name + "-" + tmpl
				dir := filepath.Join(t.TempDir(), name)
				written, err := RenderInto(dir, ScaffoldRequest{Name: name, Language: lang.Name, Template: tmpl, Description: description})
				if err != nil {
					t.Fatalf("RenderInto: %v", err)
				}
				checkRendered(t, dir, written, lang, name, description)

				pack, err := taskpipe.PackDir(bg, dir, taskpipe.PackLimits{})
				if err != nil {
					t.Fatalf("PackDir: %v", err)
				}
				defer pack.Close()
				res := taskpipe.CheckStatic(pack, taskpipe.StaticOptions{ExpectName: name}, taskpipe.Config{ManifestLimits: manifest.DefaultLimits()})
				if !res.OK() {
					t.Fatalf("check-static errors: %+v", res.Errors)
				}
				if len(res.Warnings) > 0 {
					t.Fatalf("check-static warnings: %v", res.Warnings)
				}
				if res.Manifest.Manifest.Description != description || res.Manifest.Language.Name != lang.Name {
					t.Fatalf("manifest %+v", res.Manifest.Manifest)
				}
			})
		}
	}
}

func checkRendered(t *testing.T, dir string, written []string, lang languages.Language, name, description string) {
	t.Helper()
	entry := EntryFile(lang)
	if !slices.Contains(written, entry) || !slices.Contains(written, manifest.FileName) || !slices.Contains(written, "Dockerfile") {
		t.Fatalf("written files %v lack the entry %s, the manifest or the Dockerfile", written, entry)
	}
	for _, p := range written {
		if strings.HasSuffix(p, templateSuffix) || filepath.Base(p) == ".DS_Store" {
			t.Errorf("unexpected file %s", p)
		}
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte("[[")) || bytes.Contains(data, []byte("<no value>")) {
			t.Errorf("%s contains unrendered template syntax", p)
		}
		if strings.HasSuffix(p, ".json") && !json.Valid(data) {
			t.Errorf("%s is not valid JSON", p)
		}
	}
	got := listTestTree(t, dir)
	for _, e := range got {
		if (e.Type == TypeFile && e.Mode != 0o644) || (e.Type == TypeDir && e.Mode != 0o755) {
			t.Errorf("%s has mode %o", e.Path, e.Mode)
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatal(err)
	}
	modeline := "# yaml-language-server: $schema=" + ManifestSchemaURL(version.Version) + "\n"
	if !strings.HasPrefix(string(data), modeline) {
		t.Errorf("scantor.yaml does not start with the modeline:\n%s", data)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil || doc["name"] != name || doc["description"] != description {
		t.Errorf("scantor.yaml %v (%v)", doc, err)
	}
	if lang.Name == "go" {
		for _, f := range []string{"go.mod", "go.sum"} {
			if !slices.Contains(written, f) {
				t.Errorf("the Go scaffold lacks %s", f)
			}
		}
		src, err := os.ReadFile(filepath.Join(dir, entry))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parser.ParseFile(token.NewFileSet(), entry, src, parser.AllErrors); err != nil {
			t.Errorf("%s does not parse: %v", entry, err)
		}
	}
	agents, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil || !strings.Contains(string(agents), name) {
		t.Errorf("AGENTS.md does not name the task (%v)", err)
	}
}

func TestRenderScaffoldRejections(t *testing.T) {
	tests := []struct {
		name string
		req  ScaffoldRequest
	}{
		{"unknown language", ScaffoldRequest{Name: "x", Language: "rust"}},
		{"unknown template", ScaffoldRequest{Name: "x", Language: "python", Template: "nope"}},
		{"invalid name", ScaffoldRequest{Name: "Bad_Name", Language: "python"}},
		{"reserved name", ScaffoldRequest{Name: "latest", Language: "python"}},
		{"uuid name", ScaffoldRequest{Name: "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", Language: "python"}},
		{"description too long", ScaffoldRequest{Name: "x", Language: "python", Description: strings.Repeat("d", 501)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := RenderScaffold(tt.req)
			wantCode(t, err, CodeInvalidArgument)
		})
	}
}

func TestRenderScaffoldBaseImage(t *testing.T) {
	files, err := RenderScaffold(ScaffoldRequest{Name: "x", Language: "typescript", Images: version.ImageOverride{Prefix: "registry.example/", Tag: "9.9.9"}})
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(files, func(f ScaffoldFile) bool { return f.Path == ".devcontainer/devcontainer.json" })
	if i < 0 || !bytes.Contains(files[i].Content, []byte(`"registry.example/scantor-base-js:9.9.9"`)) {
		t.Fatalf("devcontainer.json does not use the overridden base image")
	}
}

func TestScaffoldIntoWorkspace(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	res, err := ws.Scaffold(bg, ScaffoldRequest{Name: "echo", Language: "go", Template: "cidr"})
	if err != nil {
		t.Fatal(err)
	}
	task := filepath.Join(ws.dir, "echo")
	if res.Workspace.PackSHA256 != packHash(t, task) {
		t.Fatalf("summary %+v does not match the folder", res.Workspace)
	}
	if _, err := os.Stat(filepath.Join(task, "main.go")); err != nil {
		t.Fatal(err)
	}
	_, err = ws.Scaffold(bg, ScaffoldRequest{Name: "echo", Language: "python"})
	wantCode(t, err, CodeExists)

	// An empty folder is replaced.
	if err := os.Mkdir(filepath.Join(ws.dir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.Scaffold(bg, ScaffoldRequest{Name: "empty", Language: "python"}); err != nil {
		t.Fatalf("scaffold into an empty folder: %v", err)
	}
	// A symlinked task folder is refused.
	writeTree(t, ws.dir, map[string]node{"linked": symlink(t.TempDir())})
	_, err = ws.Scaffold(bg, ScaffoldRequest{Name: "linked", Language: "python"})
	wantCode(t, err, CodeInvalidPath)

	small := newTestWorkspace(t, Limits{MaxFiles: 3})
	_, err = small.Scaffold(bg, ScaffoldRequest{Name: "echo", Language: "python"})
	wantCode(t, err, CodeTooManyFiles)
	mustNotExist(t, filepath.Join(small.dir, "echo"))
	if entries, err := os.ReadDir(filepath.Join(small.dir, StagingDir)); err == nil && len(entries) > 0 {
		t.Fatalf("staging left behind: %v", entries)
	}
}

func TestRenderIntoRefusesNonEmptyDirectory(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]node{"keep.txt": file("x")})
	_, err := RenderInto(dir, ScaffoldRequest{Name: "x", Language: "python"})
	wantCode(t, err, CodeExists)
	if got := listTestTree(t, dir); len(got) != 1 {
		t.Fatalf("the directory changed: %v", got)
	}
	nested := filepath.Join(t.TempDir(), "a", "b", "task")
	if _, err := RenderInto(nested, ScaffoldRequest{Name: "task", Language: "javascript", Template: "custom"}); err != nil {
		t.Fatalf("render into a new nested directory: %v", err)
	}
}
