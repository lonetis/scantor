package templates

import (
	"encoding/json"
	"io/fs"
	"path"
	"slices"
	"strings"
	"testing"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/languages"
)

func TestRegistryMatchesSchemaFiles(t *testing.T) {
	if _, err := load(); err != nil {
		t.Fatal(err)
	}
	files, err := fs.Glob(scantor.Schemas, "schemas/templates/*.json")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range files {
		if name := strings.TrimSuffix(path.Base(f), ".json"); !strings.HasSuffix(name, ".fixtures") {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	if !slices.Equal(Names(), names) {
		t.Fatalf("registry %v, schema files %v", Names(), names)
	}
	for _, name := range names {
		def, ok := Lookup(name)
		if !ok || def.Name() != name {
			t.Fatalf("Lookup(%q)", name)
		}
		if _, err := scantor.Schemas.ReadFile("schemas/templates/" + name + ".fixtures.json"); err != nil {
			t.Errorf("%s has no fixtures file: %v", name, err)
		}
	}
	if _, ok := Lookup("nope"); ok {
		t.Fatal("Lookup of an unknown template")
	}
	if _, ok := Lookup(Single); !ok {
		t.Fatal("the default template single is missing")
	}
}

func TestInfo(t *testing.T) {
	for _, def := range List() {
		info := def.Info()
		if info.Title == "" || info.Description == "" || info.Version != 1 || len(info.ScanConfigSchema) == 0 || len(info.AnalysisConfigSchema) == 0 {
			t.Errorf("%s: incomplete info %+v", def.Name(), info)
		}
		// The listTemplates item fields are present in the JSON form.
		raw, err := json.Marshal(info)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"name", "title", "description", "scanConfigSchema", "analysisConfigSchema", "example", "resolves"} {
			if _, ok := m[key]; !ok {
				t.Errorf("%s: JSON lacks %q", def.Name(), key)
			}
		}
		// Every property of the scan config has a default, so {} is a valid scan config (§9).
		if _, issues, err := def.Effective(json.RawMessage(`{}`)); err != nil || len(issues) > 0 {
			t.Errorf("%s: {} is not a valid scan config: %v %v", def.Name(), issues, err)
		}
		if (len(info.DataSources) > 0) != info.Resolves {
			t.Errorf("%s: resolves %t with data sources %v", def.Name(), info.Resolves, info.DataSources)
		}
	}
}

func TestScaffoldsCoverEveryTemplate(t *testing.T) {
	langs, err := languages.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, lang := range langs.All() {
		dir := path.Join(lang.Scaffold, "entry")
		entries, err := fs.ReadDir(scantor.Scaffolds, dir)
		if err != nil || len(entries) == 0 {
			t.Errorf("%s has no scaffold entries: %v", dir, err)
			continue
		}
		var have []string
		for _, e := range entries {
			have = append(have, strings.SplitN(e.Name(), ".", 2)[0])
		}
		for _, name := range Names() {
			if !slices.Contains(have, name) {
				t.Errorf("%s has no entry for template %s (docs/templates.md §11 step 5)", dir, name)
			}
		}
	}
}
