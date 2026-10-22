// Package core holds the contract of the scan templates (docs/templates.md §1.2): the Template
// interface and its value types, the Error type of Estimate, Resolve and Stream, and the Definition
// that pairs an implementation with its canonical schema file.
//
// Package templates re-exports these types and holds the registry. The per-template packages
// (internal/templates/<name>) import core instead of templates, so the registry can import them
// without an import cycle.
package core

import (
	"context"
	"encoding/json"
	"iter"
	"net/http"
	"time"
)

// Data-source keys of Env.DataSources (docs/templates.md §7.1).
const (
	DataSourceTranco = "tranco"
	DataSourceCrux   = "crux"
)

// Issue is one semantic validation failure of a scan config.
type Issue struct {
	Path    string `json:"path"` // instance JSON pointer into the scan config
	Message string `json:"message"`
}

// String renders "<path>: <message>", or only the message for the root.
func (i Issue) String() string {
	if i.Path == "" {
		return i.Message
	}
	return i.Path + ": " + i.Message
}

// Estimate is the scan-size estimate of a scan config, computed without network access.
type Estimate struct {
	ExpectedTotal *int64 `json:"expectedTotal"` // nil = unknown
	Exact         bool   `json:"exact"`
}

// Resolution pins the non-deterministic inputs of a scan config (docs/templates.md §4).
type Resolution struct {
	ScanConfig    json.RawMessage `json:"scanConfig"`    // concrete inputs (e.g. list id instead of "latest")
	Provenance    map[string]any  `json:"provenance"`    // template-specific, docs/templates.md §4
	ExpectedTotal *int64          `json:"expectedTotal"` // exact count when known after resolving
}

// Upload is the access to one uploaded list.
type Upload struct {
	URL    string // presigned GET
	SHA256 string
	Bytes  int64
	Lines  int64 // only known to Estimate (from the uploads collection)
}

// Env is everything a template may use besides its scan config. The zero value of every field
// except DataSources and Uploads has a working default: HTTP nil uses a client with the §7.2 policy
// and the system roots, Now nil uses time.Now, an empty UserAgent uses DefaultUserAgent(). TmpDir is
// required by templates that download data.
type Env struct {
	DataSources map[string]string // "tranco", "crux" → base URL without trailing slash
	Uploads     map[string]Upload // upload id → access
	HTTP        *http.Client      // §7.2 policy
	TmpDir      string            // scratch space for downloaded data
	Now         func() time.Time  // injected for tests ("latest" resolution)
	UserAgent   string            // "scantor/<version> (+https://github.com/lonetis/scantor)"
}

// Clock returns Env.Now, or time.Now when it is not set.
func (e Env) Clock() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// DataSource returns the base URL of a data source without a trailing slash, or a non-retryable
// platform error when the environment does not configure it (a deployment defect, not a bad input).
func (e Env) DataSource(key string) (string, error) {
	base := e.DataSources[key]
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	if base == "" {
		return "", Platformf(false, nil, "the %s data source is not configured", key)
	}
	return base, nil
}

// Template is one scan template implementation.
type Template interface {
	Name() string
	// Validate checks the rules JSON Schema cannot express. cfg is schema-valid with defaults applied.
	Validate(cfg json.RawMessage) []Issue
	// Estimate counts analyses without network access (uploads: Env.Uploads[id].Lines).
	Estimate(cfg json.RawMessage, env Env) (Estimate, error)
	// Resolve pins non-deterministic inputs, fetches what the stream needs and computes provenance.
	Resolve(ctx context.Context, env Env, cfg json.RawMessage) (Resolution, error)
	// Stream yields analysis configs for a resolution, in the template's contractual order (§6).
	Stream(ctx context.Context, env Env, res Resolution) iter.Seq2[json.RawMessage, error]
}

// Total returns a pointer to n, for Estimate.ExpectedTotal and Resolution.ExpectedTotal.
func Total(n int64) *int64 { return &n }
