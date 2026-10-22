// Package templates is the registry of the scan templates (docs/templates.md): reusable schedule
// implementations with predefined scan config and analysis config types, implemented once in Go and
// described by the canonical schemas in schemas/templates/.
//
// The runtime runs them natively for unwrapped templates and serves wrapped template calls with them;
// `scantor templates list|estimate` exposes them to the orchestrator and to users. The contract types
// live in package core (re-exported here); each template is a package below this one.
//
// Typical use by a scheduler:
//
//	def, ok := templates.Lookup(name)
//	effective, issues, err := def.Effective(scanConfig) // canonical defaults, schema, Validate
//	if len(issues) > 0 { return templates.IssuesError(issues) }
//	res, err := def.Resolve(ctx, env, effective)        // pin inputs, fetch data, provenance
//	for item, err := range def.Stream(ctx, env, res) { … }
//
// A stored resolution (bootstrap scheduler.resolved.<key>, or the answer of POST
// /api/runtime/scheduler/resolved) is turned back into a Resolution with ResolutionFromJSON. Env.HTTP
// comes from NewHTTPClient(SCANTOR_CA_CERT).
//
// Errors of Estimate, Resolve and Stream are *runtime.Error values (type validation or platform, with
// retryable); context cancellation is returned as the context's error.
package templates

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"slices"
	"strings"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/templates/cidr"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/crux"
	"github.com/lonetis/scantor/internal/templates/fetch"
	"github.com/lonetis/scantor/internal/templates/list"
	ranges "github.com/lonetis/scantor/internal/templates/range"
	"github.com/lonetis/scantor/internal/templates/repeat"
	"github.com/lonetis/scantor/internal/templates/single"
	"github.com/lonetis/scantor/internal/templates/tranco"
)

// Re-exported contract types (docs/templates.md §1.2).
type (
	Issue      = core.Issue
	Estimate   = core.Estimate
	Resolution = core.Resolution
	Upload     = core.Upload
	Env        = core.Env
	Template   = core.Template
	Error      = core.Error
	Definition = core.Definition
	Info       = core.Info
	Example    = core.Example
)

// Data-source keys of Env.DataSources.
const (
	DataSourceTranco = core.DataSourceTranco
	DataSourceCrux   = core.DataSourceCrux
)

// Single is the template of a task without a schedule.
const Single = single.Name

// builtins are the template implementations. Adding a template: implement core.Template in a package
// below this one, add its constructor here and its schema file to schemas/templates (§11).
func builtins() []core.Template {
	return []core.Template{
		cidr.New(),
		crux.New(),
		list.New(),
		ranges.New(),
		repeat.New(),
		single.New(),
		tranco.New(),
	}
}

var registry = mustLoad()

// mustLoad pairs every implementation with its embedded schema file and checks that both sets match.
// The files are embedded, so a mismatch is a build defect caught by the package tests.
func mustLoad() map[string]*core.Definition {
	defs, err := load()
	if err != nil {
		panic(fmt.Sprintf("templates: %v", err))
	}
	return defs
}

func load() (map[string]*core.Definition, error) {
	defs := map[string]*core.Definition{}
	for _, t := range builtins() {
		if _, dup := defs[t.Name()]; dup {
			return nil, fmt.Errorf("template %s is implemented twice", t.Name())
		}
		def, err := core.LoadDefinition(t)
		if err != nil {
			return nil, err
		}
		defs[t.Name()] = def
	}
	files, err := fs.Glob(scantor.Schemas, path.Join(core.SchemaDir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		name := strings.TrimSuffix(path.Base(f), ".json")
		if strings.HasSuffix(name, ".fixtures") {
			continue
		}
		if _, ok := defs[name]; !ok {
			return nil, fmt.Errorf("%s has no implementation", f)
		}
	}
	return defs, nil
}

// AsError returns the *Error in err's chain.
func AsError(err error) (*Error, bool) { return core.AsError(err) }

// IssuesError returns the validation error of a scan config rejected with issues (an invalid wrapped
// template call is answered with it).
func IssuesError(issues []Issue) *Error { return core.IssuesError(issues) }

// ErrorPath returns the scan config path an error concerns, or "".
func ErrorPath(e *Error) string { return core.ErrorPath(e) }

// ErrorIssues returns an error as scan config issues.
func ErrorIssues(e *Error) []Issue { return core.ErrorIssues(e) }

// ResolutionFromJSON builds a Resolution from its stored JSON parts.
func ResolutionFromJSON(scanConfig, provenance json.RawMessage, expectedTotal *int64) (Resolution, error) {
	return core.ResolutionFromJSON(scanConfig, provenance, expectedTotal)
}

// NewHTTPClient returns the data-source HTTP client of docs/templates.md §7.2 for Env.HTTP, trusting
// the system roots plus caCertPEM (SCANTOR_CA_CERT; empty for none).
func NewHTTPClient(caCertPEM string) (*http.Client, error) { return fetch.NewHTTPClient(caCertPEM) }

// Lookup returns the template of the given name.
func Lookup(name string) (*Definition, bool) {
	def, ok := registry[name]
	return def, ok
}

// List returns every template, ordered by name.
func List() []*Definition {
	out := make([]*Definition, 0, len(registry))
	for _, def := range registry {
		out = append(out, def)
	}
	slices.SortFunc(out, func(a, b *Definition) int { return strings.Compare(a.Name(), b.Name()) })
	return out
}

// Names returns the template names, ordered.
func Names() []string {
	defs := List()
	names := make([]string, len(defs))
	for i, def := range defs {
		names[i] = def.Name()
	}
	return names
}
