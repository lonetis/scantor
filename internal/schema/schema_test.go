package schema

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
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

// A $ref or allOf cycle that consumes no instance level doubled the work with every level up to the
// depth bound; it is now followed once.
func TestDefaultsCycleAtOneLevel(t *testing.T) {
	s, err := Compile([]byte(`{"type":"object","allOf":[{"$ref":"#"},{"$ref":"#"}],"properties":{"a":{"default":1},"o":{"type":"object","allOf":[{"$ref":"#"},{"$ref":"#"}]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	out, _, err := s.Fill([]byte(`{"o":{"o":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, out, `{"a":1,"o":{"a":1,"o":{"a":1}}}`)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %s", elapsed)
	}
}

// Diamonds (the same definition reached through several branches) are applied again only after an
// insert, so a chain of them stays polynomial. (Validating such a chain is still exponential, so the
// test applies the defaults without validating.)
func TestDefaultsDiamondChain(t *testing.T) {
	defs := map[string]any{"A40": map[string]any{"properties": map[string]any{"x": map[string]any{"default": 1}}}}
	for i := range 40 {
		next := map[string]any{"$ref": fmt.Sprintf("#/$defs/A%d", i+1)}
		defs[fmt.Sprintf("A%d", i)] = map[string]any{"allOf": []any{next, next}}
	}
	doc, _ := json.Marshal(map[string]any{"type": "object", "$ref": "#/$defs/A0", "$defs": defs})
	s, err := Compile(doc)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	out, _ := json.Marshal(s.ApplyDefaults(map[string]any{}))
	jsonEqual(t, out, `{"x":1}`)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %s", elapsed)
	}
}

// A default that recurses into its own schema twice would grow the instance exponentially within the
// depth bound: the work bound stops it and Fill reports it.
func TestDefaultsUnbounded(t *testing.T) {
	s, err := Compile([]byte(`{"type":"object","properties":{"a":{"$ref":"#","default":{}},"b":{"$ref":"#","default":{}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, _, err := s.Fill([]byte(`{}`)); !errors.Is(err, ErrDefaultsUnbounded) {
		t.Fatalf("err = %v", err)
	}
	s.ApplyDefaults(map[string]any{})
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("took %s", elapsed)
	}
}

// referenceDefaults is the unbounded algorithm the bounded one replaces; on schemas without cycles both
// fill exactly the same defaults.
func referenceDefaults(root map[string]any, node, instance any, depth int) {
	sch, ok := node.(map[string]any)
	if !ok || depth > maxDefaultsDepth {
		return
	}
	if ref, ok := sch["$ref"].(string); ok {
		if target, ok := resolveLocalRef(root, ref); ok {
			referenceDefaults(root, target, instance, depth+1)
		}
	}
	if all, ok := sch["allOf"].([]any); ok {
		for _, sub := range all {
			referenceDefaults(root, sub, instance, depth+1)
		}
	}
	switch inst := instance.(type) {
	case map[string]any:
		props, _ := sch["properties"].(map[string]any)
		for name, sub := range props {
			subSchema, ok := sub.(map[string]any)
			if !ok {
				continue
			}
			if _, present := inst[name]; !present {
				if def, hasDefault := subSchema["default"]; hasDefault {
					b, _ := json.Marshal(def)
					inst[name], _ = ParseJSON(b)
				}
			}
			if v, present := inst[name]; present {
				referenceDefaults(root, subSchema, v, depth+1)
			}
		}
		if additional, ok := sch["additionalProperties"].(map[string]any); ok {
			for name, v := range inst {
				if _, listed := props[name]; !listed {
					referenceDefaults(root, additional, v, depth+1)
				}
			}
		}
	case []any:
		prefix, _ := sch["prefixItems"].([]any)
		for i, v := range inst {
			if i < len(prefix) {
				referenceDefaults(root, prefix[i], v, depth+1)
				continue
			}
			if items, ok := sch["items"].(map[string]any); ok {
				referenceDefaults(root, items, v, depth+1)
			}
		}
	}
}

func TestDefaultsMatchReference(t *testing.T) {
	// T is applied before S1's own property y is inserted, so only the second S1 branch fills y/z: the
	// repeated branch is not idle and must run again.
	const orderDependent = `{"allOf":[{"$ref":"#/$defs/S1"},{"$ref":"#/$defs/S1"}],"$defs":{
	  "S1":{"$ref":"#/$defs/T","properties":{"y":{"default":{}}}},
	  "T":{"properties":{"y":{"properties":{"z":{"default":1}}}}}}}`
	const shared = `{"type":"object","properties":{"p":{"$ref":"#/$defs/P"},"q":{"$ref":"#/$defs/P"},"l":{"type":"array","items":{"$ref":"#/$defs/P"}},
	  "m":{"type":"object","additionalProperties":{"allOf":[{"$ref":"#/$defs/P"},{"$ref":"#/$defs/P"}]}}},
	  "$defs":{"P":{"type":"object","properties":{"k":{"default":{"n":[{}]}},"j":{"type":"object","properties":{"i":{"default":3}},"default":{}}}}}}`
	for name, tc := range map[string]struct{ schema, instance string }{
		"ajv":             {ajvSchema, ajvInstance},
		"order dependent": {orderDependent, `{}`},
		"shared":          {shared, `{"l":[{},{"j":{}}],"m":{"a":{},"b":{"k":1}},"q":{}}`},
	} {
		t.Run(name, func(t *testing.T) {
			s, err := Compile([]byte(tc.schema))
			if err != nil {
				t.Fatal(err)
			}
			want, _ := ParseJSON([]byte(tc.instance))
			root, _ := s.doc.(map[string]any)
			referenceDefaults(root, s.doc, want, 0)
			wantJSON, _ := json.Marshal(want)
			got, _, err := s.Fill([]byte(tc.instance))
			if err != nil {
				t.Fatal(err)
			}
			jsonEqual(t, got, string(wantJSON))
		})
	}
}
