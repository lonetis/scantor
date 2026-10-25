package scantor

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The schema, instance and result of internal/schema's TestApplyDefaultsMatchesAjv (produced by ajv 8.20,
// ajv/dist/2020 with useDefaults: true): the connector fills defaults exactly as the orchestrator and
// the CLI do (docs/tasks.md §6.3).
const (
	platformDefaultsSchema = `{
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
	platformDefaultsInstance = `{"list": [{}, {"y": 9}], "map": {"k": {}}, "choice": {}, "all": {}, "ref": {}, "tuple": [1], "nul": null}`
	platformDefaultsResult   = `{"list":[{"y":2},{"y":9}],"map":{"k":{"z":3}},"choice":{},"all":{"v":5},"ref":{"u":6},"tuple":[1],"nul":null,"a":"A","nested":{"x":1}}`
)

func sameJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestApplyDefaultsMatchesThePlatform(t *testing.T) {
	doc := mustDecode(t, platformDefaultsSchema)
	got, err := marshalJSON(applyDefaults(doc, doc, mustDecode(t, platformDefaultsInstance)))
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, got, platformDefaultsResult)
}

func TestApplyDefaultsCopiesDefaults(t *testing.T) {
	doc := mustDecode(t, `{"type":"object","properties":{"a":{"type":"object","default":{"k":[1]}}}}`)
	first := applyDefaults(doc, doc, newObject()).(*object)
	first.getObject("a").set("k", "changed")
	second := applyDefaults(doc, doc, newObject()).(*object)
	if _, ok := second.getObject("a").values["k"].([]any); !ok {
		t.Fatal("the default is shared between instances")
	}
}

func TestApplyDefaultsTerminatesOnCycles(t *testing.T) {
	for _, schema := range []string{
		`{"$ref":"#/$defs/A","$defs":{"A":{"$ref":"#/$defs/B"},"B":{"$ref":"#/$defs/A"}}}`,
		`{"allOf":[{"$ref":"#"}]}`,
	} {
		doc := mustDecode(t, schema)
		applyDefaults(doc, doc, newObject())
	}
}

type defaultsTarget struct {
	Host string `json:"host" jsonschema:"default=localhost"`
	Port int    `json:"port,omitempty" jsonschema:"default=443"`
}

type defaultsConfig struct {
	Targets []defaultsTarget          `json:"targets,omitempty" jsonschema:"default=[]"`
	ByName  map[string]defaultsTarget `json:"byName,omitempty" jsonschema:"default={}"`
	Main    defaultsTarget            `json:"main"`
}

// TestNestedDefaultsAreFilled decodes the analysis config a schedule yields: encoding/json omits the
// zero ports there, and run must see the defaults inside slices and maps as it does at the top level.
func TestNestedDefaultsAreFilled(t *testing.T) {
	m, err := modelFor(reflect.TypeFor[defaultsConfig](), inputMode)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.decode([]byte(`{"targets":[{"host":"a"},{"port":8443}],"byName":{"x":{"host":"b"}},"main":{}}`), "analysis config")
	if err != nil {
		t.Fatal(err)
	}
	want := defaultsConfig{
		Targets: []defaultsTarget{{Host: "a", Port: 443}, {Host: "localhost", Port: 8443}},
		ByName:  map[string]defaultsTarget{"x": {Host: "b", Port: 443}},
		Main:    defaultsTarget{Host: "localhost", Port: 443},
	}
	if got := v.(defaultsConfig); !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}
