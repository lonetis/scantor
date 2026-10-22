package languages

import (
	"encoding/json"
	"slices"
	"testing"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/version"
)

func TestLoad(t *testing.T) {
	table, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := table.Names(); !slices.Equal(got, []string{"go", "javascript", "python", "typescript"}) {
		t.Fatalf("Names = %v", got)
	}
	py, ok := table.Get("python")
	if !ok || py.Base != "python" || py.Image != "scantor-base-python" || py.Entry != "main.py" || !py.IsSource() {
		t.Fatalf("python row = %+v", py)
	}
	goLang, _ := table.Get("go")
	if goLang.IsSource() || goLang.Entry != "/task/task" {
		t.Fatalf("go row = %+v", goLang)
	}
	ts, _ := table.Get("typescript")
	if !ts.HasExtension("src/main.mts") || ts.HasExtension("main.js") {
		t.Fatal("typescript extensions")
	}
	if got := table.Bases(); !slices.Equal(got, []string{"go", "js", "python"}) {
		t.Fatalf("Bases = %v", got)
	}
	if _, ok := table.Get("rust"); ok {
		t.Fatal("unknown language found")
	}
}

func TestBaseImageRef(t *testing.T) {
	origPrefix, origVersion := version.ImagePrefix, version.Version
	t.Cleanup(func() { version.ImagePrefix, version.Version = origPrefix, origVersion })
	version.ImagePrefix, version.Version = "ghcr.io/lonetis/", "1.4.0"
	js, _ := MustLoad().Get("javascript")
	if got := js.BaseImageRef(version.ImageOverride{}); got != "ghcr.io/lonetis/scantor-base-js:1.4.0" {
		t.Fatalf("BaseImageRef = %q", got)
	}
}

// The manifest schema's language enum and the table must stay identical (docs/tasks.md §3.2 M3).
func TestManifestSchemaEnumMatchesTable(t *testing.T) {
	data, err := scantor.Schemas.ReadFile("schemas/task-manifest.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Properties struct {
			Language struct {
				Enum []string `json:"enum"`
			} `json:"language"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	enum := slices.Clone(schema.Properties.Language.Enum)
	slices.Sort(enum)
	if !slices.Equal(enum, MustLoad().Names()) {
		t.Fatalf("manifest language enum %v differs from languages.json %v", enum, MustLoad().Names())
	}
}

func TestParseRejectsInvalidTables(t *testing.T) {
	for name, data := range map[string]string{
		"bad version":    `{"version": 2, "languages": {"x": {}}}`,
		"no languages":   `{"version": 1, "languages": {}}`,
		"missing fields": `{"version": 1, "languages": {"x": {"title": "X"}}}`,
		"bad entry kind": `{"version": 1, "languages": {"x": {"title": "X", "base": "x", "image": "i", "entry": "main.x", "entryKind": "script", "extensions": [".x"]}}}`,
		"entry ext":      `{"version": 1, "languages": {"x": {"title": "X", "base": "x", "image": "i", "entry": "main.y", "entryKind": "source", "extensions": [".x"]}}}`,
	} {
		if _, err := Parse([]byte(data)); err == nil {
			t.Errorf("%s: Parse accepted an invalid table", name)
		}
	}
}
