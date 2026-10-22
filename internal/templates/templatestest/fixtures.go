package templatestest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync"
	"testing"
	"time"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/runtime/canonical"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// Fixtures is the content of schemas/templates/<name>.fixtures.json (docs/templates.md §10).
type Fixtures struct {
	Template   string `json:"template"`
	ScanConfig struct {
		Valid []struct {
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			Effective json.RawMessage `json:"effective"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
			Kind  string          `json:"kind"` // schema | semantic
			Path  string          `json:"path"`
		} `json:"invalid"`
	} `json:"scanConfig"`
	AnalysisConfig struct {
		Valid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
			Path  string          `json:"path"`
		} `json:"invalid"`
	} `json:"analysisConfig"`
	Cases []Case `json:"cases"`
}

// Case is one end-to-end case of a fixtures file.
type Case struct {
	Name       string            `json:"name"`
	ScanConfig json.RawMessage   `json:"scanConfig"`
	Now        string            `json:"now,omitempty"`
	HTTP       []Route           `json:"http,omitempty"`
	Uploads    []FixtureUpload   `json:"uploads,omitempty"`
	Estimate   core.Estimate     `json:"estimate"`
	Resolution json.RawMessage   `json:"resolution,omitempty"`
	Analyses   []json.RawMessage `json:"analyses,omitempty"`
	Complete   *bool             `json:"complete,omitempty"`
	Error      *CaseError        `json:"error,omitempty"`
}

// FixtureUpload is an upload served at a presigned-style URL; sha256 and bytes come from Content.
type FixtureUpload struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Lines   int64  `json:"lines"`
}

// CaseError is the expected error of Resolve or Stream.
type CaseError struct {
	Type      string `json:"type"`
	Retryable bool   `json:"retryable"`
	Contains  string `json:"contains"`
}

// LoadFixtures reads the embedded fixtures file of a template. Unknown keys are rejected so typos in
// fixtures cannot silently skip checks.
func LoadFixtures(name string) (*Fixtures, error) {
	raw, err := scantor.Schemas.ReadFile(path.Join(core.SchemaDir, name+".fixtures.json"))
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var fx Fixtures
	if err := dec.Decode(&fx); err != nil {
		return nil, fmt.Errorf("%s.fixtures.json: %w", name, err)
	}
	if fx.Template != name {
		return nil, fmt.Errorf("%s.fixtures.json names the template %q", name, fx.Template)
	}
	return &fx, nil
}

// FixedNow is the clock of fixture cases without `now`.
var FixedNow = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

// RunFixtures drives a template through its fixtures file: schema acceptance and rejection of scan
// and analysis configs, defaults (ApplyDefaults(input) == effective), semantic issues at their paths,
// and for every case Estimate, Resolve and Stream against fake data sources, followed by the resume
// checks: a resolution that went through JSON streams the same items with the same tail hash from a
// fresh scratch directory, and tampered data hashes fail with a validation error.
//
// newTemplate returns a fresh instance per case (templates may hold process-wide state such as a
// request spacer).
func RunFixtures(t *testing.T, newTemplate func() core.Template) {
	t.Helper()
	def, err := core.LoadDefinition(newTemplate())
	if err != nil {
		t.Fatal(err)
	}
	fx, err := LoadFixtures(def.Name())
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.ScanConfig.Valid) == 0 || len(fx.Cases) == 0 {
		t.Fatalf("%s.fixtures.json needs valid scan configs and cases", def.Name())
	}

	for _, v := range fx.ScanConfig.Valid {
		t.Run("scanConfig/valid/"+v.Name, func(t *testing.T) {
			effective, issues, err := def.Effective(v.Input)
			if err != nil || len(issues) > 0 {
				t.Fatalf("Effective(%s) = issues %v, err %v", v.Input, issues, err)
			}
			assertJSONEqual(t, "effective config", effective, v.Effective)
		})
	}
	for _, v := range fx.ScanConfig.Invalid {
		t.Run("scanConfig/invalid/"+v.Name, func(t *testing.T) {
			checkInvalidScanConfig(t, def, v.Input, v.Kind, v.Path)
		})
	}
	for _, v := range fx.AnalysisConfig.Valid {
		t.Run("analysisConfig/valid/"+v.Name, func(t *testing.T) {
			if issues, err := def.ValidateAnalysisConfig(v.Input); err != nil || len(issues) > 0 {
				t.Fatalf("analysis config %s rejected: %v %v", v.Input, issues, err)
			}
		})
	}
	for _, v := range fx.AnalysisConfig.Invalid {
		t.Run("analysisConfig/invalid/"+v.Name, func(t *testing.T) {
			issues, err := def.ValidateAnalysisConfig(v.Input)
			if err != nil {
				t.Fatal(err)
			}
			if !hasIssueAt(issues, v.Path) {
				t.Fatalf("analysis config %s: want an issue at %q, got %v", v.Input, v.Path, issues)
			}
		})
	}
	for _, c := range fx.Cases {
		t.Run("case/"+c.Name, func(t *testing.T) {
			caseDef, err := core.LoadDefinition(newTemplate())
			if err != nil {
				t.Fatal(err)
			}
			runCase(t, caseDef, c)
		})
	}
}

func checkInvalidScanConfig(t *testing.T, def *core.Definition, input json.RawMessage, kind, at string) {
	t.Helper()
	filled, schemaIssues, err := def.ScanConfigSchema().Fill(input)
	if err != nil {
		t.Fatal(err)
	}
	switch kind {
	case "schema":
		issues := make([]core.Issue, len(schemaIssues))
		for i, is := range schemaIssues {
			issues[i] = core.Issue{Path: is.Path, Message: is.Message}
		}
		if !hasIssueAt(issues, at) {
			t.Fatalf("schema: want an issue at %q, got %v", at, schemaIssues)
		}
	case "semantic":
		if len(schemaIssues) > 0 {
			t.Fatalf("semantic case rejected by the schema: %v", schemaIssues)
		}
		_, issues, err := def.Effective(input)
		if err != nil {
			t.Fatal(err)
		}
		if hasIssueAt(issues, at) {
			for _, is := range issues {
				if is.Message == "" {
					t.Fatalf("issue without message: %+v", is)
				}
			}
			return
		}
		if len(issues) > 0 {
			t.Fatalf("want an issue at %q, got %v", at, issues)
		}
		// Data-dependent (for example an unknown upload): Estimate and Resolve reject it at the path.
		env := core.Env{TmpDir: t.TempDir(), Now: func() time.Time { return FixedNow }, DataSources: map[string]string{}}
		if _, err := def.Estimate(filled, env); !isValidationAt(err, at) {
			t.Fatalf("Estimate: want a validation error at %q, got %v", at, err)
		}
		if _, err := def.Resolve(context.Background(), env, filled); !isValidationAt(err, at) {
			t.Fatalf("Resolve: want a validation error at %q, got %v", at, err)
		}
	default:
		t.Fatalf("unknown kind %q", kind)
	}
}

func isValidationAt(err error, at string) bool {
	e, ok := core.AsError(err)
	return ok && e.Type == "validation" && !e.Retryable && core.ErrorPath(e) == at
}

func hasIssueAt(issues []core.Issue, at string) bool {
	for _, is := range issues {
		if is.Path == at {
			return true
		}
	}
	return false
}

// caseServer is the fake data-source server of one case.
type caseServer struct {
	*httptest.Server
	uploads *Uploads
	mu      sync.Mutex
	agents  []string
}

func newCaseServer(t *testing.T, info core.Info, c Case) *caseServer {
	t.Helper()
	cs := &caseServer{}
	content := map[string][]byte{}
	for _, u := range c.Uploads {
		content[u.ID] = []byte(u.Content)
	}
	cs.uploads = NewUploads("/uploads", content)
	mux := http.NewServeMux()
	cs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cs.mu.Lock()
		cs.agents = append(cs.agents, r.UserAgent())
		cs.mu.Unlock()
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(cs.Close)
	vars := map[string]string{core.DataSourceTranco: cs.URL + "/tranco", core.DataSourceCrux: cs.URL + "/crux"}
	if len(info.DataSources) > 1 {
		t.Fatalf("fixture cases support one data source per template, %s has %v", info.Name, info.DataSources)
	}
	for _, ds := range info.DataSources {
		mux.Handle("/"+ds+"/", NewRoutes("/"+ds, c.HTTP, vars))
	}
	if len(info.DataSources) == 0 && len(c.HTTP) > 0 {
		t.Fatalf("case %q has http entries, but %s has no data source", c.Name, info.Name)
	}
	mux.Handle("/uploads/", cs.uploads)
	return cs
}

func (cs *caseServer) env(t *testing.T, c Case) core.Env {
	t.Helper()
	now := FixedNow
	if c.Now != "" {
		parsed, err := time.Parse(time.RFC3339, c.Now)
		if err != nil {
			t.Fatalf("case now: %v", err)
		}
		now = parsed
	}
	client, err := fetch.NewHTTPClient("")
	if err != nil {
		t.Fatal(err)
	}
	uploads := map[string]core.Upload{}
	for _, u := range c.Uploads {
		sum := sha256.Sum256([]byte(u.Content))
		uploads[u.ID] = core.Upload{URL: cs.uploads.URL(cs.URL, u.ID), SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(u.Content)), Lines: u.Lines}
	}
	return core.Env{
		DataSources: map[string]string{core.DataSourceTranco: cs.URL + "/tranco", core.DataSourceCrux: cs.URL + "/crux"},
		Uploads:     uploads,
		HTTP:        client,
		TmpDir:      t.TempDir(),
		Now:         func() time.Time { return now },
	}
}

func (cs *caseServer) vars() map[string]string {
	return map[string]string{"tranco": cs.URL + "/tranco", "crux": cs.URL + "/crux"}
}

func runCase(t *testing.T, def *core.Definition, c Case) {
	ctx := context.Background()
	cs := newCaseServer(t, def.Info(), c)
	env := cs.env(t, c)

	effective, issues, err := def.Effective(c.ScanConfig)
	if err != nil || len(issues) > 0 {
		t.Fatalf("Effective(%s) = issues %v, err %v", c.ScanConfig, issues, err)
	}
	est, err := def.Estimate(effective, env)
	if err != nil {
		t.Fatalf("Estimate: %v", err)
	}
	assertJSONEqual(t, "estimate", mustJSON(t, est), mustJSON(t, c.Estimate))

	res, err := def.Resolve(ctx, env, effective)
	if c.Error != nil {
		if err == nil {
			_, err = Collect(ctx, def, env, res)
		}
		checkCaseError(t, err, c.Error)
		return
	}
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	checkResolution(t, def, res, expand(c.Resolution, cs.vars()))

	items, err := Collect(ctx, def, env, res)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	checkAnalyses(t, def, c, items, res)

	for _, agent := range cs.agents {
		if !strings.HasPrefix(agent, "scantor/") || !strings.HasSuffix(agent, "(+https://github.com/lonetis/scantor)") {
			t.Errorf("User-Agent %q does not follow the data-source policy", agent)
		}
	}
	checkResume(t, def, cs, c, res, items)
}

func checkCaseError(t *testing.T, err error, want *CaseError) {
	t.Helper()
	e, ok := core.AsError(err)
	if !ok {
		t.Fatalf("want a %s error containing %q, got %v", want.Type, want.Contains, err)
	}
	if string(e.Type) != want.Type || e.Retryable != want.Retryable || !strings.Contains(e.Message, want.Contains) {
		t.Fatalf("error = {type %s, retryable %t, message %q}, want {type %s, retryable %t, contains %q}",
			e.Type, e.Retryable, e.Message, want.Type, want.Retryable, want.Contains)
	}
}

func checkResolution(t *testing.T, def *core.Definition, res core.Resolution, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		t.Fatal("the case has neither resolution nor error")
	}
	var expected struct {
		ScanConfig    json.RawMessage `json:"scanConfig"`
		Provenance    map[string]any  `json:"provenance"`
		ExpectedTotal *int64          `json:"expectedTotal"`
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, "resolved scan config", res.ScanConfig, expected.ScanConfig)
	provenance := map[string]any{}
	for k, v := range res.Provenance {
		provenance[k] = v
	}
	if fetchedAt, ok := provenance["fetchedAt"]; ok {
		s, _ := fetchedAt.(string)
		if _, err := time.Parse("2006-01-02T15:04:05.000Z", s); err != nil {
			t.Errorf("provenance.fetchedAt %v is not ISO 8601 UTC with milliseconds", fetchedAt)
		}
		delete(provenance, "fetchedAt")
	}
	assertJSONEqual(t, "provenance", mustJSON(t, provenance), mustJSON(t, expected.Provenance))
	assertJSONEqual(t, "expectedTotal", mustJSON(t, res.ExpectedTotal), mustJSON(t, expected.ExpectedTotal))

	// The resolved config is a complete, valid effective config: resuming re-reads it.
	again, issues, err := def.Effective(res.ScanConfig)
	if err != nil || len(issues) > 0 {
		t.Fatalf("resolved scan config %s is invalid: %v %v", res.ScanConfig, issues, err)
	}
	assertJSONEqual(t, "resolved scan config after defaults", again, res.ScanConfig)
}

func checkAnalyses(t *testing.T, def *core.Definition, c Case, items []json.RawMessage, res core.Resolution) {
	t.Helper()
	complete := c.Complete != nil && *c.Complete
	if complete && len(items) != len(c.Analyses) {
		t.Fatalf("stream yielded %d analyses, want %d: %s", len(items), len(c.Analyses), items)
	}
	if len(items) < len(c.Analyses) {
		t.Fatalf("stream yielded %d analyses, want at least %d", len(items), len(c.Analyses))
	}
	for i, want := range c.Analyses {
		assertJSONEqual(t, fmt.Sprintf("analysis %d", i), items[i], want)
	}
	for i, item := range items {
		issues, err := def.ValidateAnalysisConfig(item)
		if err != nil || len(issues) > 0 {
			t.Fatalf("analysis %d %s violates the analysis config schema: %v %v", i, item, issues, err)
		}
	}
	if complete && (res.ExpectedTotal == nil || *res.ExpectedTotal != int64(len(items))) {
		t.Fatalf("expectedTotal %v, but the stream yielded %d analyses", res.ExpectedTotal, len(items))
	}
}

// checkResume streams a resolution that went through JSON (as stored by the orchestrator) from a fresh
// scratch directory and compares items and tail hashes; then it tampers the recorded data hashes.
func checkResume(t *testing.T, def *core.Definition, cs *caseServer, c Case, res core.Resolution, items []json.RawMessage) {
	t.Helper()
	ctx := context.Background()
	stored := roundTrip(t, res)
	env := cs.env(t, c)
	again, err := Collect(ctx, def, env, stored)
	if err != nil {
		t.Fatalf("Stream after a JSON round trip: %v", err)
	}
	if len(again) != len(items) {
		t.Fatalf("resumed stream yielded %d items, the first %d", len(again), len(items))
	}
	for i := range items {
		if !bytes.Equal(items[i], again[i]) {
			t.Fatalf("item %d differs on resume: %s vs %s", i, items[i], again[i])
		}
	}
	if len(items) > 0 {
		h1, err := canonical.Hash(items[len(items)-1])
		if err != nil {
			t.Fatal(err)
		}
		h2, err := canonical.Hash(again[len(again)-1])
		if err != nil {
			t.Fatal(err)
		}
		if h1 != h2 {
			t.Fatalf("tail hash differs on resume: %s vs %s", h1, h2)
		}
	}

	tampered := roundTrip(t, res)
	if !tamperHashes(tampered.Provenance) {
		return
	}
	_, err = Collect(ctx, def, cs.env(t, c), tampered)
	e, ok := core.AsError(err)
	if !ok || e.Type != "validation" || e.Retryable || !strings.Contains(e.Message, "changed since resolution") {
		t.Fatalf("stream with a tampered sha256: want a validation error about changed content, got %v", err)
	}
}

func roundTrip(t *testing.T, res core.Resolution) core.Resolution {
	t.Helper()
	provenance, err := json.Marshal(res.Provenance)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := core.ResolutionFromJSON(append(json.RawMessage(nil), res.ScanConfig...), provenance, res.ExpectedTotal)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}

// tamperHashes replaces every "sha256" string in a provenance map and reports whether one existed.
func tamperHashes(m map[string]any) bool {
	found := false
	for k, v := range m {
		switch tv := v.(type) {
		case string:
			if k == "sha256" {
				m[k] = strings.Repeat("0", 64)
				found = true
			}
		case map[string]any:
			found = tamperHashes(tv) || found
		}
	}
	return found
}

// Collect runs a template's Stream to the end and returns the items and the first error.
func Collect(ctx context.Context, t core.Template, env core.Env, res core.Resolution) ([]json.RawMessage, error) {
	var items []json.RawMessage
	for item, err := range t.Stream(ctx, env, res) {
		if err != nil {
			return items, err
		}
		items = append(items, item)
	}
	return items, nil
}

func expand(raw json.RawMessage, vars map[string]string) json.RawMessage {
	s := string(raw)
	for k, v := range vars {
		s = strings.ReplaceAll(s, "${"+k+"}", v)
	}
	return json.RawMessage(s)
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// assertJSONEqual compares two JSON values semantically (canonical forms).
func assertJSONEqual(t *testing.T, what string, got, want []byte) {
	t.Helper()
	g, err := canonical.Transform(got)
	if err != nil {
		t.Fatalf("%s: invalid JSON %s: %v", what, got, err)
	}
	w, err := canonical.Transform(want)
	if err != nil {
		t.Fatalf("%s: invalid expected JSON %s: %v", what, want, err)
	}
	if !bytes.Equal(g, w) {
		t.Fatalf("%s = %s, want %s", what, g, w)
	}
}
