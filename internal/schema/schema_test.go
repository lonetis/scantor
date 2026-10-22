package schema

import (
	"encoding/json"
	"strings"
	"testing"
)

// The expectation below was produced by ajv 8.20 (ajv/dist/2020, useDefaults: true) on the same schema
// and instance, so ApplyDefaults stays identical to the orchestrator's validator.
const ajvSchema = `{
  "type": "object",
  "properties": {
    "a": {"type": "string", "default": "A"},
    "nested": {"type": "object", "properties": {"x": {"type": "integer", "default": 1}}, "default": {}},
    "list": {"type": "array", "items": {"type": "object", "properties": {"y": {"type": "integer", "default": 2}}}},
    "map": {"type": "object", "additionalProperties": {"type": "object", "properties": {"z": {"type": "integer", "default": 3}}}},
    "choice": {"anyOf": [{"type": "object", "properties": {"w": {"default": 4}}}]},
    "all": {"allOf": [{"type": "object", "properties": {"v": {"default": 5}}}]},
    "ref": {"$ref": "#/$defs/R"},
    "tuple": {"type": "array", "prefixItems": [{"type": "integer", "default": 7}, {"type": "integer", "default": 8}]},
    "nul": {"type": ["string", "null"], "default": "N"}
  },
  "$defs": {"R": {"type": "object", "properties": {"u": {"default": 6}}}}
}`

const ajvInstance = `{"list": [{}, {"y": 9}], "map": {"k": {}}, "choice": {}, "all": {}, "ref": {}, "tuple": [1], "nul": null}`

const ajvResult = `{"list":[{"y":2},{"y":9}],"map":{"k":{"z":3}},"choice":{},"all":{"v":5},"ref":{"u":6},"tuple":[1],"nul":null,"a":"A","nested":{"x":1}}`

func jsonEqual(t *testing.T, got []byte, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	gb, _ := json.Marshal(g)
	wb, _ := json.Marshal(w)
	if string(gb) != string(wb) {
		t.Fatalf("got %s\nwant %s", gb, wb)
	}
}

func TestApplyDefaultsMatchesAjv(t *testing.T) {
	s, err := Compile([]byte(ajvSchema))
	if err != nil {
		t.Fatal(err)
	}
	out, issues, err := s.Fill([]byte(ajvInstance))
	if err != nil {
		t.Fatal(err)
	}
	if len(issues) != 0 {
		t.Fatalf("issues: %v", issues)
	}
	jsonEqual(t, out, ajvResult)
}

func TestDefaultsAreDeepCopies(t *testing.T) {
	s, err := Compile([]byte(`{"type":"object","properties":{"a":{"type":"object","default":{"k":[1]}},"b":{"type":"object","default":{"k":[1]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	inst := map[string]any{}
	s.ApplyDefaults(inst)
	inst["a"].(map[string]any)["k"] = "changed"
	second := map[string]any{}
	s.ApplyDefaults(second)
	if _, ok := second["a"].(map[string]any)["k"].([]any); !ok {
		t.Fatal("default shared between instances")
	}
}

func TestValidateIssues(t *testing.T) {
	s, err := Compile([]byte(`{
	  "$schema": "https://json-schema.org/draft/2020-12/schema",
	  "type": "object",
	  "additionalProperties": false,
	  "required": ["name"],
	  "properties": {
	    "name": {"type": "string", "minLength": 2},
	    "rank": {"type": "integer"},
	    "id": {"type": "string", "format": "uuid"},
	    "token": {"type": "string", "format": "password", "writeOnly": true}
	  }
	}`))
	if err != nil {
		t.Fatal(err)
	}
	inst, _ := ParseJSON([]byte(`{"name": "x", "rank": "1", "nam": 1, "id": "nope", "token": "s"}`))
	issues := s.Validate(inst)
	paths := map[string]bool{}
	for _, is := range issues {
		paths[is.Path] = true
		if is.Message == "" {
			t.Errorf("empty message for %s", is.Path)
		}
	}
	for _, p := range []string{"", "/name", "/rank", "/id"} {
		if !paths[p] {
			t.Errorf("missing issue at %q: %v", p, issues)
		}
	}
	if paths["/token"] {
		t.Errorf("unknown format password must be an annotation: %v", issues)
	}
	ok, _ := ParseJSON([]byte(`{"name": "xy", "rank": 12345678901234567890}`))
	if issues := s.Validate(ok); issues == nil {
		// 12345678901234567890 is an integer beyond int64 and stays exact as json.Number
		t.Log("big integer accepted")
	} else {
		t.Fatalf("valid instance rejected: %v", issues)
	}
}

func TestBigIntegersSurviveFill(t *testing.T) {
	s, err := Compile([]byte(`{"type":"object","properties":{"n":{"type":"integer"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	out, issues, err := s.Fill([]byte(`{"n": 9007199254740993}`))
	if err != nil || issues != nil {
		t.Fatalf("Fill: %v %v", err, issues)
	}
	if !strings.Contains(string(out), "9007199254740993") {
		t.Fatalf("precision lost: %s", out)
	}
}

func TestRemoteRefsRejected(t *testing.T) {
	if _, err := Compile([]byte(`{"$ref": "https://example.com/schema.json"}`)); err == nil {
		t.Fatal("remote reference compiled")
	}
}

func TestFillRejectsInvalidJSON(t *testing.T) {
	s, _ := Compile([]byte(`{"type":"object"}`))
	for _, in := range []string{`{`, `{} {}`, ``} {
		if _, _, err := s.Fill([]byte(in)); err == nil {
			t.Errorf("Fill(%q) accepted invalid JSON", in)
		}
	}
}

func TestRecursiveRefTerminates(t *testing.T) {
	s, err := Compile([]byte(`{"$ref":"#/$defs/A","$defs":{"A":{"$ref":"#/$defs/B"},"B":{"$ref":"#/$defs/A"}}}`))
	if err != nil {
		// a pure reference cycle may be rejected at compile time; either way it must not hang
		return
	}
	s.ApplyDefaults(map[string]any{})
}
