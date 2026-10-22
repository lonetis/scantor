package core

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
)

func TestDecodeConfig(t *testing.T) {
	type cfg struct {
		N    int64   `json:"n"`
		List []int64 `json:"list"`
	}
	var c cfg
	if err := DecodeConfig(json.RawMessage(`{"n": 1.0e3, "list": [2.0, 3]}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.N != 1000 || len(c.List) != 2 || c.List[0] != 2 {
		t.Fatalf("decoded %+v", c)
	}
	for _, bad := range []string{`{"n": 1.5}`, `{"x": 1}`, `{"n": 1} {}`, `[`, `{"n": 1e400}`, `{"n": 1e999999999}`, `{"n": 1e-999999999}`} {
		err := DecodeConfig(json.RawMessage(bad), &c)
		if e, ok := AsError(err); !ok || e.Type != api.ErrorValidation || e.Retryable {
			t.Errorf("DecodeConfig(%s) = %v, want a validation error", bad, err)
		}
	}
}

func TestLines(t *testing.T) {
	var got []string
	for line, err := range Lines(strings.NewReader("a\r\nb\n\nc"), 8) {
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, string(line.Text))
	}
	if strings.Join(got, "|") != "a|b||c" {
		t.Fatalf("lines %q", got)
	}
	var lastErr error
	for _, err := range Lines(strings.NewReader("ok\n0123456789\n"), 8) {
		lastErr = err
	}
	if !errors.Is(lastErr, ErrLineTooLong) || !strings.Contains(lastErr.Error(), "line 2") {
		t.Fatalf("err %v", lastErr)
	}
	// Stopping early is allowed.
	for _, err := range Lines(strings.NewReader("a\nb\n"), 8) {
		if err != nil {
			t.Fatal(err)
		}
		break
	}
}

func TestErrors(t *testing.T) {
	e := IssuesError([]Issue{{Path: "/step", Message: "must not be 0"}, {Path: "", Message: "bad"}})
	if e.Type != api.ErrorValidation || e.Retryable || ErrorPath(e) != "/step" || e.Message != "invalid scan config: /step: must not be 0; bad" {
		t.Fatalf("%+v", e)
	}
	if issues := ErrorIssues(e); len(issues) != 2 || issues[1] != (Issue{Message: "bad"}) {
		t.Fatalf("ErrorIssues = %v", issues)
	}
	cause := errors.New("reset")
	p := Platformf(true, cause, "GET %s: %v", "x", cause)
	if !errors.Is(p, cause) || !p.Retryable || p.Type != api.ErrorPlatform {
		t.Fatalf("%+v", p)
	}
	got, ok := AsError(errors.Join(errors.New("x"), ValidationAt("/a", "v")))
	if !ok || len(ErrorIssues(got)) != 1 || ErrorIssues(got)[0] != (Issue{Path: "/a", Message: "v"}) {
		t.Fatalf("AsError: %v", got)
	}
	// Template errors are the runtime's classified errors (docs/templates.md §1.2).
	if _, ok := runtime.AsError(Platformf(false, nil, "x")); !ok {
		t.Fatal("not a *runtime.Error")
	}
	if ErrorPath(Validationf("no path")) != "" || ErrorPath(nil) != "" {
		t.Fatal("ErrorPath of an error without a path")
	}
}

func TestEnvDataSource(t *testing.T) {
	env := Env{DataSources: map[string]string{DataSourceTranco: "https://tranco-list.eu/"}}
	if base, err := env.DataSource(DataSourceTranco); err != nil || base != "https://tranco-list.eu" {
		t.Fatalf("%q %v", base, err)
	}
	if _, err := env.DataSource(DataSourceCrux); err == nil {
		t.Fatal("a missing data source must fail")
	}
	if !strings.HasPrefix(DefaultUserAgent(), "scantor/") || !strings.HasSuffix(DefaultUserAgent(), " (+https://github.com/lonetis/scantor)") {
		t.Fatal(DefaultUserAgent())
	}
}

func TestResolutionFromJSON(t *testing.T) {
	res, err := ResolutionFromJSON(json.RawMessage(`{"a":1}`), json.RawMessage(`{"upload":{"bytes":24},"sha256":"x"}`), Total(3))
	if err != nil {
		t.Fatal(err)
	}
	var prov struct {
		Upload struct {
			Bytes int64 `json:"bytes"`
		} `json:"upload"`
		SHA256 string `json:"sha256"`
	}
	if err := DecodeProvenance(res.Provenance, &prov); err != nil || prov.Upload.Bytes != 24 || prov.SHA256 != "x" || *res.ExpectedTotal != 3 {
		t.Fatalf("%+v %v", prov, err)
	}
	for _, empty := range []string{``, `null`} {
		res, err := ResolutionFromJSON(json.RawMessage(`{}`), json.RawMessage(empty), nil)
		if err != nil || res.Provenance == nil || len(res.Provenance) != 0 {
			t.Fatalf("provenance %q: %v %v", empty, res.Provenance, err)
		}
	}
}

// fake is a template whose schema file is given inline.
type fake struct{ issues []Issue }

func (fake) Name() string { return "fake" }

func (f fake) Validate(json.RawMessage) []Issue { return f.issues }

func (fake) Estimate(json.RawMessage, Env) (Estimate, error) { return Estimate{}, nil }

func (fake) Resolve(context.Context, Env, json.RawMessage) (Resolution, error) {
	return Resolution{}, nil
}

func (fake) Stream(context.Context, Env, Resolution) iter.Seq2[json.RawMessage, error] {
	return func(func(json.RawMessage, error) bool) {}
}

const fakeSchema = `{
  "title": "Fake", "description": "A fake.",
  "x-scantor-template": {"name": "fake", "version": 1, "resolves": false, "estimate": "exact", "dataSources": [], "uploads": false,
    "example": {"scanConfig": {"n": 2}, "analysisConfig": {"v": 1}}},
  "$defs": {
    "scanConfig": {"type": "object", "properties": {"n": {"type": "integer", "minimum": 1, "default": 1}}, "additionalProperties": false},
    "analysisConfig": {"type": "object", "properties": {"v": {"type": "integer"}}, "required": ["v"], "additionalProperties": false}
  }
}`

func TestDefinition(t *testing.T) {
	d, err := Define(fake{}, []byte(fakeSchema))
	if err != nil {
		t.Fatal(err)
	}
	info := d.Info()
	if info.Name != "fake" || info.Title != "Fake" || info.Estimate != EstimateExact || info.DataSources == nil {
		t.Fatalf("info %+v", info)
	}
	effective, issues, err := d.Effective(nil)
	if err != nil || len(issues) > 0 || string(effective) != `{"n":1}` {
		t.Fatalf("Effective(nil) = %s %v %v", effective, issues, err)
	}
	if _, issues, _ := d.Effective(json.RawMessage(`{"n": 0, "x": 1}`)); len(issues) != 2 {
		t.Fatalf("schema issues %v", issues)
	}
	if _, _, err := d.Effective(json.RawMessage(`{`)); err == nil {
		t.Fatal("invalid JSON must fail")
	}
	if issues, err := d.ValidateAnalysisConfig(json.RawMessage(`{}`)); err != nil || len(issues) != 1 {
		t.Fatalf("analysis issues %v %v", issues, err)
	}

	semantic, err := Define(fake{issues: []Issue{{Path: "/z", Message: "b"}, {Path: "/a", Message: "a"}}}, []byte(strings.Replace(fakeSchema, `{"n": 2}`, `{}`, 1)))
	if err == nil {
		t.Fatalf("an example rejected by Validate must fail Define: %v", semantic)
	}
	for _, bad := range []string{
		strings.Replace(fakeSchema, `"name": "fake"`, `"name": "other"`, 1),
		strings.Replace(fakeSchema, `"estimate": "exact"`, `"estimate": "guess"`, 1),
		strings.Replace(fakeSchema, `"analysisConfig": {"v": 1}`, `"analysisConfig": {}`, 1),
		`{"$defs": {}}`,
	} {
		if _, err := Define(fake{}, []byte(bad)); err == nil {
			t.Errorf("Define accepted %s", bad)
		}
	}
}

func TestEffectiveSortsSemanticIssues(t *testing.T) {
	schema := strings.Replace(fakeSchema, `"example": {"scanConfig": {"n": 2}`, `"example": {"scanConfig": {"n": 2}`, 1)
	d, err := Define(fake{}, []byte(schema))
	if err != nil {
		t.Fatal(err)
	}
	d.Template = fake{issues: []Issue{{Path: "/z", Message: "b"}, {Path: "/a", Message: "a"}}}
	_, issues, err := d.Effective(json.RawMessage(`{}`))
	if err != nil || len(issues) != 2 || issues[0].Path != "/a" {
		t.Fatalf("issues %v %v", issues, err)
	}
}
