package scantor_test

import (
	"io/fs"
	"testing"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/languages"
)

// Every language of languages.json must have a non-empty embedded scaffold (guards the go.mod.tmpl rule:
// a scaffold directory containing go.mod would be excluded from the embed as a separate module).
func TestEmbeddedScaffolds(t *testing.T) {
	table := languages.MustLoad()
	present := 0
	for _, l := range table.All() {
		if _, err := fs.Stat(scantor.Scaffolds, l.Scaffold); err == nil {
			present++
		}
	}
	if present == 0 {
		t.Skip("no scaffold directory exists yet; this check becomes strict as soon as the first scaffold lands")
	}
	for _, l := range table.All() {
		files := 0
		err := fs.WalkDir(scantor.Scaffolds, l.Scaffold, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() {
				files++
			}
			if d.Name() == "go.mod" || d.Name() == "go.sum" {
				t.Errorf("%s: scaffold contains %s; store it as %s.tmpl", l.Name, path, d.Name())
			}
			return nil
		})
		if err != nil {
			t.Errorf("%s: scaffold %s: %v", l.Name, l.Scaffold, err)
			continue
		}
		if files == 0 {
			t.Errorf("%s: scaffold %s is empty", l.Name, l.Scaffold)
		}
	}
}

func TestEmbeddedSchemasAndGuides(t *testing.T) {
	for _, p := range []string{
		"schemas/languages.json", "schemas/managed-labels.json", "schemas/task-manifest.schema.json",
		"schemas/describe.schema.json", "schemas/protocol/message.schema.json", "schemas/messages/result.schema.json",
		"schemas/templates/single.json",
	} {
		if _, err := fs.Stat(scantor.Schemas, p); err != nil {
			t.Errorf("embedded schemas lack %s: %v", p, err)
		}
	}
	if _, err := fs.Stat(scantor.Guides, "docs/guide/README.md"); err != nil {
		t.Errorf("embedded guides: %v", err)
	}
}
