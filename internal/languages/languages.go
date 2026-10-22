// Package languages loads schemas/languages.json, the single language table of the platform
// (docs/tasks.md §4.1). No Go code switches on language names; everything language-specific comes from
// this table and the base image ENV contract.
package languages

import (
	"encoding/json"
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/version"
)

// TablePath is the path of the language table inside scantor.Schemas.
const TablePath = "schemas/languages.json"

// Entry kinds.
const (
	EntryKindSource = "source"
	EntryKindBinary = "binary"
)

// Language is one row of the table.
type Language struct {
	// Name is the key of the row (python, typescript, javascript, go).
	Name             string   `json:"-"`
	Title            string   `json:"title"`
	Base             string   `json:"base"`
	Image            string   `json:"image"`
	Entry            string   `json:"entry"`
	EntryKind        string   `json:"entryKind"`
	Extensions       []string `json:"extensions"`
	Scaffold         string   `json:"scaffold"`
	Guide            string   `json:"guide"`
	EditorExtensions []string `json:"editorExtensions"`
}

// IsSource reports whether the entry is a source file in the task folder (as opposed to a binary built
// by the Dockerfile).
func (l Language) IsSource() bool { return l.EntryKind == EntryKindSource }

// HasExtension reports whether p ends in one of the language's entry extensions.
func (l Language) HasExtension(p string) bool {
	return slices.Contains(l.Extensions, path.Ext(p))
}

// BaseImageRef returns the reference of the language's base image, "<prefix><image>:<tag>", following
// the image-reference rule of docs/architecture.md §4.2.
func (l Language) BaseImageRef(override version.ImageOverride) string {
	return version.ImageRef(l.Image, override)
}

// Table is the parsed language table.
type Table struct {
	Version                int      `json:"version"`
	CommonEditorExtensions []string `json:"commonEditorExtensions"`
	byName                 map[string]Language
}

// Parse parses and validates the table format.
func Parse(data []byte) (*Table, error) {
	var raw struct {
		Version                int                 `json:"version"`
		CommonEditorExtensions []string            `json:"commonEditorExtensions"`
		Languages              map[string]Language `json:"languages"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse %s: %w", TablePath, err)
	}
	if raw.Version != 1 {
		return nil, fmt.Errorf("parse %s: unsupported table version %d", TablePath, raw.Version)
	}
	if len(raw.Languages) == 0 {
		return nil, fmt.Errorf("parse %s: no languages", TablePath)
	}
	t := &Table{Version: raw.Version, CommonEditorExtensions: raw.CommonEditorExtensions, byName: map[string]Language{}}
	for name, l := range raw.Languages {
		l.Name = name
		if err := l.validate(); err != nil {
			return nil, fmt.Errorf("parse %s: language %s: %w", TablePath, name, err)
		}
		t.byName[name] = l
	}
	return t, nil
}

func (l Language) validate() error {
	switch {
	case l.Title == "" || l.Base == "" || l.Image == "" || l.Entry == "":
		return fmt.Errorf("title, base, image and entry are required")
	case l.EntryKind != EntryKindSource && l.EntryKind != EntryKindBinary:
		return fmt.Errorf("entryKind %q is neither %s nor %s", l.EntryKind, EntryKindSource, EntryKindBinary)
	case len(l.Extensions) == 0:
		return fmt.Errorf("extensions are required")
	case l.IsSource() && !l.HasExtension(l.Entry):
		return fmt.Errorf("default entry %q has none of the extensions %s", l.Entry, strings.Join(l.Extensions, ", "))
	}
	return nil
}

// Get returns the language named name.
func (t *Table) Get(name string) (Language, bool) {
	l, ok := t.byName[name]
	return l, ok
}

// Names returns the language names, sorted.
func (t *Table) Names() []string {
	names := make([]string, 0, len(t.byName))
	for n := range t.byName {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// All returns every language, sorted by name.
func (t *Table) All() []Language {
	out := make([]Language, 0, len(t.byName))
	for _, n := range t.Names() {
		out = append(out, t.byName[n])
	}
	return out
}

// Bases returns the distinct base image families (python, js, go), sorted.
func (t *Table) Bases() []string {
	var bases []string
	for _, l := range t.byName {
		if !slices.Contains(bases, l.Base) {
			bases = append(bases, l.Base)
		}
	}
	sort.Strings(bases)
	return bases
}

var (
	loadOnce  sync.Once
	loaded    *Table
	loadError error
)

// Load returns the table embedded in the binary. It is parsed once.
func Load() (*Table, error) {
	loadOnce.Do(func() {
		data, err := scantor.Schemas.ReadFile(TablePath)
		if err != nil {
			loadError = fmt.Errorf("read embedded %s: %w", TablePath, err)
			return
		}
		loaded, loadError = Parse(data)
	})
	return loaded, loadError
}

// MustLoad returns the embedded table and panics when it is invalid, which can only happen with a
// broken build (the table is embedded and covered by tests).
func MustLoad() *Table {
	t, err := Load()
	if err != nil {
		panic(err)
	}
	return t
}
