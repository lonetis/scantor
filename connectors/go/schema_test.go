package scantor

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func schemaJSON(t *testing.T, typ reflect.Type, mode schemaMode) string {
	t.Helper()
	s, err := reflectSchema(typ, mode)
	if err != nil {
		t.Fatalf("reflect %s: %v", typ, err)
	}
	raw, err := marshalJSON(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func assertJSON(t *testing.T, got, want string) {
	t.Helper()
	g, w := mustDecode(t, got), mustDecode(t, want)
	if !jsonEqual(g, w) {
		t.Fatalf("schema mismatch\n got %s\nwant %s", got, want)
	}
}

func TestEmptySchema(t *testing.T) {
	got := schemaJSON(t, reflect.TypeFor[Empty](), inputMode)
	if got != `{"type":"object","properties":{},"additionalProperties":false}` {
		t.Fatalf("got %s", got)
	}
}

type inner struct {
	Depth int `json:"depth" jsonschema:"default=1"`
}

type Base struct {
	Shared string `json:"shared" jsonschema:"default=x"`
}

type configSample struct {
	Base
	Greeting string            `json:"greeting" jsonschema:"default=Hello,minLength=1"`
	Must     string            `json:"must" jsonschema:"required"`
	Token    Secret            `json:"token,omitempty" jsonschema:"description=API token"`
	Ports    []int             `json:"ports,omitempty" jsonschema:"maxItems=64,default=80,default=443"`
	Tags     []string          `json:"tags,omitempty" jsonschema:"default=[]"`
	Limit    *int              `json:"limit" jsonschema:"minimum=1,default=null"`
	Version  *int              `json:"version,omitempty" jsonschema:"enum=4,enum=6"`
	Inner    *inner            `json:"inner,omitempty" jsonschema:"description=nested,default={}"`
	Labels   map[string]string `json:"labels,omitempty" jsonschema:"default={}"`
	Ratio    float64           `json:"ratio" jsonschema:"default=0.5"`
	When     time.Time         `json:"when,omitzero"`
	Skipped  string            `json:"-"`
	hidden   string            //nolint:unused // unexported fields stay out of the schema
}

func TestConfigSchema(t *testing.T) {
	got := schemaJSON(t, reflect.TypeFor[configSample](), inputMode)
	assertJSON(t, got, `{
		"type": "object",
		"properties": {
			"shared": {"type": "string", "default": "x"},
			"greeting": {"type": "string", "minLength": 1, "default": "Hello"},
			"must": {"type": "string"},
			"token": {"type": "string", "description": "API token", "writeOnly": true},
			"ports": {"type": "array", "maxItems": 64, "items": {"type": "integer"}, "default": [80, 443]},
			"tags": {"type": "array", "items": {"type": "string"}, "default": []},
			"limit": {"type": ["integer", "null"], "minimum": 1, "default": null},
			"version": {"type": ["integer", "null"], "enum": [4, 6, null]},
			"inner": {"description": "nested", "anyOf": [{"$ref": "#/$defs/inner"}, {"type": "null"}], "default": {}},
			"labels": {"type": "object", "additionalProperties": {"type": "string"}, "default": {}},
			"ratio": {"type": "number", "default": 0.5},
			"when": {"type": "string", "format": "date-time"}
		},
		"additionalProperties": false,
		"required": ["must"],
		"$defs": {"inner": {"type": "object", "properties": {"depth": {"type": "integer", "default": 1}}, "additionalProperties": false}}
	}`)
	// Keywords come in a stable, readable order.
	if !strings.HasPrefix(got, `{"type":"object","properties":{"shared":`) {
		t.Fatalf("unexpected keyword order: %s", got)
	}
}

type resultSample struct {
	Text    string    `json:"text"`
	Gallery []FileRef `json:"gallery"`
	Body    *FileRef  `json:"body"`
	Note    string    `json:"note,omitempty"`
	Counts  map[string]int
}

func TestResultSchema(t *testing.T) {
	got := schemaJSON(t, reflect.TypeFor[resultSample](), outputMode)
	fileRef := `{"type":"object","x-scantor":"file","properties":{"id":{"type":"string"},"name":{"type":"string"},"size":{"type":"integer"},"sha256":{"type":"string"},"contentType":{"type":"string"}},"additionalProperties":false,"required":["id","name","size","sha256","contentType"]}`
	nullableFileRef := strings.Replace(fileRef, `"type":"object"`, `"type":["object","null"]`, 1)
	assertJSON(t, got, `{
		"type": "object",
		"properties": {
			"text": {"type": "string"},
			"gallery": {"type": "array", "items": `+fileRef+`},
			"body": `+nullableFileRef+`,
			"note": {"type": "string"},
			"Counts": {"type": "object", "additionalProperties": {"type": "integer"}}
		},
		"additionalProperties": false,
		"required": ["text", "gallery", "body", "Counts"]
	}`)
}

type treeNode struct {
	Name     string     `json:"name"`
	Children []treeNode `json:"children"`
}

func TestRecursiveRootKeepsDefinition(t *testing.T) {
	got := schemaJSON(t, reflect.TypeFor[treeNode](), outputMode)
	assertJSON(t, got, `{
		"type": "object",
		"properties": {"name": {"type": "string"}, "children": {"type": "array", "items": {"$ref": "#/$defs/treeNode"}}},
		"additionalProperties": false,
		"required": ["name", "children"],
		"$defs": {"treeNode": {"type": "object", "properties": {"name": {"type": "string"}, "children": {"type": "array", "items": {"$ref": "#/$defs/treeNode"}}}, "additionalProperties": false, "required": ["name", "children"]}}
	}`)
}

func collidingTypes() (reflect.Type, reflect.Type) {
	type Item struct {
		A int `json:"a"`
	}
	first := reflect.TypeFor[Item]()
	return first, func() reflect.Type {
		type Item struct {
			B string `json:"b"`
		}
		return reflect.TypeFor[Item]()
	}()
}

func TestDefinitionNamesAreUnique(t *testing.T) {
	a, b := collidingTypes()
	parent := reflect.StructOf([]reflect.StructField{
		{Name: "X", Type: a, Tag: `json:"x"`},
		{Name: "Y", Type: b, Tag: `json:"y"`},
	})
	got := schemaJSON(t, parent, outputMode)
	if !strings.Contains(got, `"#/$defs/Item"`) || !strings.Contains(got, `"#/$defs/Item2"`) {
		t.Fatalf("expected two distinct definitions: %s", got)
	}
}

type generic[T any] struct {
	Value T `json:"value"`
}

type withGeneric struct {
	G generic[int] `json:"g"`
}

func TestGenericTypeNamesAreValidPointers(t *testing.T) {
	got := schemaJSON(t, reflect.TypeFor[withGeneric](), outputMode)
	s := mustDecode(t, got)
	ref, err := resolvePointer(s, "/properties/g/$ref")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolvePointer(s, strings.TrimPrefix(ref.(string), "#")); err != nil {
		t.Fatalf("dangling reference %v in %s", ref, got)
	}
}

func TestInvalidDefinitions(t *testing.T) {
	type badDefault struct {
		N int `json:"n" jsonschema:"default=abc"`
	}
	type badPattern struct {
		S string `json:"s" jsonschema:"pattern=(("`
	}
	type badType struct {
		C chan int `json:"c"`
	}
	type badObjectDefault struct {
		I inner `json:"i" jsonschema:"default=x"`
	}
	for _, typ := range []reflect.Type{
		reflect.TypeFor[badDefault](), reflect.TypeFor[badPattern](),
		reflect.TypeFor[badType](), reflect.TypeFor[badObjectDefault](),
	} {
		if _, err := reflectSchema(typ, inputMode); err == nil {
			t.Errorf("%s: expected a definition error", typ)
		}
	}
}

func TestModelDecode(t *testing.T) {
	m, err := modelFor(reflect.TypeFor[configSample](), inputMode)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.decode([]byte(`{"must":"m","greeting":"Hi","limit":null,"ports":[1]}`), "task config")
	if err != nil {
		t.Fatal(err)
	}
	cfg := v.(configSample)
	if cfg.Greeting != "Hi" || cfg.Limit != nil || len(cfg.Ports) != 1 {
		t.Fatalf("decoded %+v", cfg)
	}
	for _, raw := range []string{`{"must":"m","greting":"typo"}`, `{"must":"m","limit":0}`, `{}`, `[]`, `{"must":1}`, `not json`} {
		_, err := m.decode([]byte(raw), "task config")
		var e *Error
		if err == nil || !errorAs(err, &e) || e.Type != "validation" {
			t.Errorf("%s: want a validation error, got %v", raw, err)
		}
	}
	_, err = m.decode([]byte(`{"must":"m","greting":"typo"}`), "task config")
	if !strings.Contains(err.Error(), "additional property 'greting'") {
		t.Errorf("message does not name the unknown key: %v", err)
	}
}

func errorAs(err error, target **Error) bool {
	e, ok := err.(*Error)
	if ok {
		*target = e
	}
	return ok
}

func TestModelEncode(t *testing.T) {
	m, err := modelFor(reflect.TypeFor[resultSample](), outputMode)
	if err != nil {
		t.Fatal(err)
	}
	o, err := m.encode(resultSample{Text: "t"}, "result")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := marshalJSON(o)
	if string(raw) != `{"text":"t","gallery":[],"body":null,"Counts":{}}` {
		t.Fatalf("nil collections must encode as empty: %s", raw)
	}
	type strict struct {
		S string  `json:"s" jsonschema:"minLength=2"`
		F float64 `json:"f"`
	}
	sm, err := modelFor(reflect.TypeFor[strict](), outputMode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.encode(strict{S: "x"}, "result"); err == nil {
		t.Error("a constraint violation must fail encoding")
	}
	if _, err := sm.encode(strict{S: "xy", F: math.NaN()}, "result"); err == nil || !strings.Contains(err.Error(), "not representable") {
		t.Errorf("NaN must fail encoding, got %v", err)
	}
	mm, err := modelFor(reflect.TypeFor[map[string]any](), outputMode)
	if err != nil {
		t.Fatal(err)
	}
	o, err = mm.encode(map[string]any(nil), "result")
	if err != nil || len(o.keys) != 0 {
		t.Fatalf("a nil map result must encode as {}: %v %v", o, err)
	}
}

func TestDecodeIssuePaths(t *testing.T) {
	type deep struct {
		A struct {
			B int `json:"b"`
		} `json:"a"`
	}
	var target deep
	err := json.Unmarshal([]byte(`{"a":{"b":"x"}}`), &target)
	if is := decodeIssue(err); is.Path != "/a/b" {
		t.Fatalf("got %+v", is)
	}
}
