package manifest

import (
	"encoding/json"
	"strings"
	"testing"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/languages"
)

func checkScript(t *testing.T, yaml string, opts Options) (*ScriptResult, []Issue) {
	t.Helper()
	return CheckScript([]byte(yaml), opts)
}

func TestMinimalScriptManifestUsesFallbacks(t *testing.T) {
	res, issues := checkScript(t, "# yaml-language-server: $schema=https://example/script.json\nscantor: 1\nname: csp-stats\nlanguage: python\n", Options{IsRegularFile: func(p string) bool { return p == "main.py" }})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	if res.Manifest.Entry != "main.py" || res.Language.Name != "python" || res.Language.Script == nil {
		t.Fatalf("result: %+v", res)
	}
	m, _ := json.Marshal(res.Manifest)
	if string(m) != `{"scantor":1,"name":"csp-stats","language":"python","entry":"main.py","defaults":{}}` {
		t.Fatalf("manifest JSON = %s", m)
	}
	d, _ := json.Marshal(res.Defaults)
	if string(d) != `{"timeoutMs":null,"resources":{"cpus":1,"memoryMiB":1024}}` {
		t.Fatalf("defaults JSON = %s", d)
	}
}

func TestFullScriptExample(t *testing.T) {
	const full = `scantor: 1
name: title-report
language: python
description: Count the pages with a title and write a CSV report.
entry: src/main.py
defaults:
  timeoutMs: 7200000
  resources:
    cpus: 2.5
    memoryMiB: 2048
`
	res, issues := checkScript(t, full, Options{ExpectName: "title-report", IsRegularFile: func(p string) bool { return p == "src/main.py" }})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	if res.Manifest.Entry != "src/main.py" || res.Manifest.Description == "" {
		t.Fatalf("manifest: %+v", res.Manifest)
	}
	d, _ := json.Marshal(res.Defaults)
	if string(d) != `{"timeoutMs":7200000,"resources":{"cpus":2.5,"memoryMiB":2048}}` {
		t.Fatalf("defaults JSON = %s", d)
	}
	m, _ := json.Marshal(res.Manifest)
	if !strings.Contains(string(m), `"defaults":{"timeoutMs":7200000,"resources":{"cpus":2.5,"memoryMiB":2048}}`) {
		t.Fatalf("manifest keeps the written defaults: %s", m)
	}
	// One resource set, the other falls back.
	res, issues = checkScript(t, "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  resources:\n    memoryMiB: 512\n", Options{})
	if issues != nil || res.Defaults.Resources != (api.Resources{CPUs: 1, MemoryMiB: 512}) || res.Defaults.TimeoutMs != nil {
		t.Fatalf("partial resources: %+v %v", res, issues)
	}
}

// The examples of the schema are valid script manifests.
func TestScriptSchemaExamples(t *testing.T) {
	data, err := scantor.Schemas.ReadFile(ScriptSchemaPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Examples []json.RawMessage `json:"examples"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Examples) == 0 {
		t.Fatal("the schema has no examples")
	}
	for i, example := range doc.Examples {
		// JSON is YAML.
		if _, issues := CheckScript(example, Options{}); issues != nil {
			t.Errorf("example %d: %v", i, issues)
		}
	}
}

func TestScriptRules(t *testing.T) {
	noFiles := Options{IsRegularFile: func(string) bool { return false }}
	cases := []struct {
		name    string
		yaml    string
		opts    Options
		rule    string
		line    int
		message string
	}{
		{"too large", "scantor: 1\nname: x\nlanguage: python\ndescription: \"" + strings.Repeat("x", MaxBytes) + "\"\n", Options{}, "S1", 0, "the limit is"},
		{"duplicate key", "scantor: 1\nname: x\nlanguage: python\nname: y\n", Options{}, "S1", 4, `duplicate key "name"`},
		{"invalid yaml", "scantor: 1\nname: [x\n", Options{}, "S1", 0, "invalid YAML"},
		{"not a mapping", "- a\n", Options{}, "S1", 1, "root must be a mapping"},
		{"empty", "", Options{}, "S1", 1, "empty"},
		{"unknown key", "scantor: 1\nname: x\nlanguage: python\ntemplate: tranco\n", Options{}, "S2", 4, `unknown key "template"`},
		{"task defaults key", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  workers: 2\n", Options{}, "S2", 5, `unknown key "workers"`},
		{"missing key", "scantor: 1\nname: x\n", Options{}, "S2", 1, `missing required key "language"`},
		{"bad version", "scantor: 2\nname: x\nlanguage: python\n", Options{}, "S2", 1, "/scantor"},
		{"bad name", "scantor: 1\nname: My_Script\nlanguage: python\n", Options{}, "S2", 2, "/name"},
		{"reserved name", "scantor: 1\nname: new\nlanguage: python\n", Options{}, "S2", 2, "reserved name"},
		{"uuid name", "scantor: 1\nname: 7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c\nlanguage: python\n", Options{}, "S2", 2, "reserved name"},
		{"description too long", "scantor: 1\nname: x\nlanguage: python\ndescription: " + strings.Repeat("d", 1025) + "\n", Options{}, "S2", 4, "/description"},
		{"timeout too short", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  timeoutMs: 999\n", Options{}, "S2", 5, "/defaults/timeoutMs"},
		{"timeout not an integer", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  timeoutMs: 2h\n", Options{}, "S2", 5, "/defaults/timeoutMs"},
		{"cpus zero", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  resources:\n    cpus: 0\n", Options{}, "S2", 6, "/defaults/resources/cpus"},
		{"memory too small", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  resources:\n    memoryMiB: 128\n", Options{}, "S2", 6, "/defaults/resources/memoryMiB"},
		{"memory as a size", "scantor: 1\nname: x\nlanguage: python\ndefaults:\n  resources:\n    memory: 1GiB\n", Options{}, "S2", 6, `unknown key "memory"`},
		{"entry with backslash", "scantor: 1\nname: x\nlanguage: python\nentry: 'src\\main.py'\n", Options{}, "S2", 4, "/entry"},
		{"unknown language", "scantor: 1\nname: x\nlanguage: rust\n", Options{}, "S3", 3, `unknown language "rust"; scripts can be written in python`},
		{"language without scripts", "scantor: 1\nname: x\nlanguage: go\n", Options{}, "S3", 3, "go does not support scripts; scripts can be written in python"},
		{"entry extension", "scantor: 1\nname: x\nlanguage: python\nentry: main.ts\n", Options{}, "S4", 4, `entry "main.ts" must end in .py`},
		{"entry absolute", "scantor: 1\nname: x\nlanguage: python\nentry: /task/main.py\n", Options{}, "S4", 4, "relative"},
		{"entry not normalised", "scantor: 1\nname: x\nlanguage: python\nentry: ./main.py\n", Options{}, "S4", 4, "normalised"},
		{"entry dotdot", "scantor: 1\nname: x\nlanguage: python\nentry: a/../main.py\n", Options{}, "S4", 4, "normalised"},
		{"entry missing", "scantor: 1\nname: x\nlanguage: python\nentry: src/main.py\n", noFiles, "S4", 4, `entry "src/main.py" is not a regular file of the script folder`},
		{"default entry missing", "scantor: 1\nname: x\nlanguage: python\n", noFiles, "S4", 1, `entry "main.py" is not a regular file of the script folder (the default entry of python scripts; set entry in scantor-script.yaml to use another file)`},
		{"expect name", "scantor: 1\nname: other\nlanguage: python\n", Options{ExpectName: "csp-stats"}, "S6", 2, `name "other" does not match script "csp-stats"; script names are immutable`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, issues := checkScript(t, tc.yaml, tc.opts)
			if res != nil || len(issues) == 0 {
				t.Fatalf("accepted: %+v", res)
			}
			var found bool
			for _, is := range issues {
				if is.File != ScriptFileName || strings.HasPrefix(is.Rule, "M") {
					t.Errorf("issue of the task manifest: %+v", is)
				}
				be := is.BuildError()
				if be.Phase != api.BuildPhaseStatic || be.File != ScriptFileName {
					t.Errorf("BuildError = %+v", be)
				}
				if is.Rule == tc.rule && strings.Contains(is.Message, tc.message) {
					found = true
					if tc.line != 0 && is.Line != tc.line {
						t.Errorf("line = %d, want %d (%s)", is.Line, tc.line, is.Message)
					}
				}
			}
			if !found {
				t.Fatalf("no %s issue containing %q in %v", tc.rule, tc.message, issues)
			}
		})
	}
}

// S3–S6 are collected together, like M3–M10.
func TestScriptSemanticIssuesTogether(t *testing.T) {
	_, issues := checkScript(t, "scantor: 1\nname: other\nlanguage: python\nentry: main.js\n", Options{ExpectName: "x"})
	var rules []string
	for _, is := range issues {
		rules = append(rules, is.Rule)
	}
	if strings.Join(rules, ",") != "S4,S6" {
		t.Fatalf("rules = %v (%v)", rules, issues)
	}
	if got := issues[0].String(); got != `scantor-script.yaml:4: entry "main.js" must end in .py` {
		t.Fatalf("String = %q", got)
	}
}

// A script language's entry kind decides between S4 and S5, and its script.entry is the default entry.
func TestScriptEntryFromTable(t *testing.T) {
	table, err := languages.Parse([]byte(`{"version": 1, "languages": {
		"src": {"title": "S", "base": "s", "image": "i", "entry": "main.s", "entryKind": "source", "extensions": [".s"], "script": {"entry": "script.s", "scaffold": "x", "guide": "g"}},
		"bin": {"title": "B", "base": "b", "image": "i", "entry": "/task/task", "entryKind": "binary", "extensions": [".b"], "script": {"entry": "/task/script", "scaffold": "x", "guide": "g"}},
		"none": {"title": "N", "base": "n", "image": "i", "entry": "main.n", "entryKind": "source", "extensions": [".n"]}
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	res, issues := checkScript(t, "scantor: 1\nname: x\nlanguage: src\n", Options{Languages: table, IsRegularFile: func(p string) bool { return p == "script.s" }})
	if issues != nil || res.Manifest.Entry != "script.s" {
		t.Fatalf("source default entry: %+v %v", res, issues)
	}
	res, issues = checkScript(t, "scantor: 1\nname: x\nlanguage: bin\n", Options{Languages: table, IsRegularFile: func(string) bool { return false }})
	if issues != nil || res.Manifest.Entry != "/task/script" {
		t.Fatalf("binary default entry: %+v %v", res, issues)
	}
	_, issues = checkScript(t, "scantor: 1\nname: x\nlanguage: bin\nentry: /task/../x\n", Options{Languages: table})
	if len(issues) != 1 || issues[0].Rule != "S5" {
		t.Fatalf("binary entry: %v", issues)
	}
	_, issues = checkScript(t, "scantor: 1\nname: x\nlanguage: none\n", Options{Languages: table})
	if len(issues) != 1 || issues[0].Rule != "S3" || !strings.Contains(issues[0].Message, "none does not support scripts; scripts can be written in bin or src") {
		t.Fatalf("language without scripts: %v", issues)
	}
}

// Check keeps the rule ids and the file of scantor.yaml; the task's scan-setting defaults are unknown
// keys of a script manifest.
func TestTaskManifestRulesUnchanged(t *testing.T) {
	_, issues := check(t, "scantor: 1\nname: echo\nlanguage: python\nname: x\n", Options{})
	if len(issues) != 1 || issues[0].Rule != "M1" || issues[0].File != "" || issues[0].BuildError().File != FileName {
		t.Fatalf("task issues: %+v", issues)
	}
	if got := issues[0].String(); !strings.HasPrefix(got, "scantor.yaml:4: ") {
		t.Fatalf("String = %q", got)
	}
	if _, issues := checkScript(t, "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 5m\n", Options{}); len(issues) != 1 || issues[0].Rule != "S2" {
		t.Fatalf("task defaults in a script manifest: %v", issues)
	}
}

// The name and entry rules of the two manifests are identical (task and script names share one slug
// rule), and the Go fallbacks equal the schema's `default` annotations.
func TestScriptSchemaMatchesTaskSchema(t *testing.T) {
	read := func(path string) map[string]any {
		t.Helper()
		data, err := scantor.Schemas.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}
	task, script := read(SchemaPath), read(ScriptSchemaPath)
	property := func(doc map[string]any, name, key string) string {
		b, _ := json.Marshal(doc["properties"].(map[string]any)[name].(map[string]any)[key])
		return string(b)
	}
	for _, name := range []string{"name", "entry"} {
		for _, key := range []string{"type", "minLength", "maxLength", "pattern", "not"} {
			if a, b := property(task, name, key), property(script, name, key); a != b {
				t.Errorf("%s.%s: task %s, script %s", name, key, a, b)
			}
		}
	}
	resources := script["$defs"].(map[string]any)["defaults"].(map[string]any)["properties"].(map[string]any)["resources"].(map[string]any)["properties"].(map[string]any)
	if cpus := resources["cpus"].(map[string]any)["default"]; cpus != float64(ScriptDefaultCPUs) {
		t.Errorf("cpus default = %v, want %v", cpus, ScriptDefaultCPUs)
	}
	if memory := resources["memoryMiB"].(map[string]any)["default"]; memory != float64(ScriptDefaultMemoryMiB) {
		t.Errorf("memoryMiB default = %v, want %v", memory, ScriptDefaultMemoryMiB)
	}
}
