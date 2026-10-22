package conformance

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/templates"
)

// specCases are the case ids of docs/protocol.md §12.3; P1 (every fd 4 line is valid) is checked in
// every case instead of being a case of its own.
var specCases = []string{
	"H1", "H2", "H3", "H4", "H5", "D1", "D2", "D3", "D4", "D5",
	"R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14",
	"C1", "C2", "C3", "C4", "C5", "S1", "S2", "S3", "S4", "S5", "T1", "T2", "T3", "T4", "P2", "P3", "P4",
}

func TestCatalogueCoversTheSpec(t *testing.T) {
	var ids []string
	for _, c := range Cases {
		if slices.Contains(ids, c.ID) {
			t.Errorf("case %s is defined twice", c.ID)
		}
		ids = append(ids, c.ID)
		if got, ok := Lookup(c.ID); !ok || got.ID != c.ID {
			t.Errorf("Lookup(%s) = %v, %v", c.ID, got.ID, ok)
		}
	}
	for _, id := range specCases {
		if !slices.Contains(ids, id) {
			t.Errorf("case %s of docs/protocol.md §12.3 is missing", id)
		}
	}
	if _, ok := Lookup("X9"); ok {
		t.Error("Lookup of an unknown id succeeded")
	}
}

// TestFixturesOfEveryLanguage: every fixture a case needs exists for every language of
// schemas/languages.json, and its manifest is valid and names the fixture and the language (Go has no
// echo-async, import-error and bad-definition fixtures, docs/protocol.md §12.2).
func TestFixturesOfEveryLanguage(t *testing.T) {
	table, err := languages.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, lang := range table.Names() {
		t.Run(lang, func(t *testing.T) {
			dir := filepath.Join("testdata", lang)
			needed := map[string]bool{}
			for _, c := range Cases {
				for _, f := range c.Fixtures {
					switch {
					case f == "template-*":
						for _, name := range templates.Names() {
							needed["template-"+name] = true
						}
					case c.Applies(lang, f):
						needed[f] = true
					}
				}
			}
			for fixture := range needed {
				data, err := os.ReadFile(filepath.Join(dir, fixture, manifest.FileName))
				if err != nil {
					t.Errorf("fixture %s: %v", fixture, err)
					continue
				}
				res, issues := manifest.Check(data, manifest.Options{ExpectName: fixture, AllowPrivileged: true})
				if len(issues) > 0 {
					t.Errorf("fixture %s: %v", fixture, issues)
					continue
				}
				if res.Manifest.Language != lang {
					t.Errorf("fixture %s has language %s", fixture, res.Manifest.Language)
				}
				if _, err := os.Stat(filepath.Join(dir, fixture, "Dockerfile")); err != nil {
					t.Errorf("fixture %s: %v", fixture, err)
				}
			}
			if lang == "go" {
				for _, absent := range []string{"echo-async", "import-error", "bad-definition"} {
					if needed[absent] {
						t.Errorf("a case needs the %s fixture, which Go does not have", absent)
					}
				}
			}
		})
	}
}

func TestApplies(t *testing.T) {
	d5, _ := Lookup("D5")
	if !d5.Applies("python", "template-cidr") || d5.Applies("python", "template-unwrapped") || d5.Applies("python", "echo") {
		t.Error("D5 must run on exactly the template-<name> fixtures")
	}
	h3, _ := Lookup("H3")
	if h3.Applies("go", "import-error") || !h3.Applies("typescript", "import-error") {
		t.Error("H3 does not apply to Go")
	}
	if !IsTemplateFixture("template-range") || IsTemplateFixture("template-models") || IsTemplateFixture("echo") {
		t.Error("IsTemplateFixture")
	}
}
