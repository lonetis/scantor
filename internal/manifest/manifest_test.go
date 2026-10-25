package manifest

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

func check(t *testing.T, yaml string, opts Options) (*Result, []Issue) {
	t.Helper()
	return Check([]byte(yaml), opts)
}

func TestMinimalManifestUsesFallbacks(t *testing.T) {
	res, issues := check(t, "# yaml-language-server: $schema=https://example/schema.json\nscantor: 1\nname: echo\nlanguage: python\n", Options{})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	if res.Manifest.Entry != "main.py" || res.Language.Name != "python" || res.Privileged {
		t.Fatalf("result: %+v", res)
	}
	want := api.DefaultScanSettings()
	if res.SettingsDefaults != want {
		t.Fatalf("settings = %+v, want %+v", res.SettingsDefaults, want)
	}
	b, _ := json.Marshal(res.Manifest)
	if string(b) != `{"scantor":1,"name":"echo","language":"python","entry":"main.py","defaults":{}}` {
		t.Fatalf("manifest JSON = %s", b)
	}
	sd, _ := json.Marshal(res.SettingsDefaults)
	if string(sd) != `{"workers":1,"processes":1,"timeoutMs":300000,"maxAttempts":3,"backoff":{"initialMs":5000,"factor":2,"maxMs":600000,"jitter":true},"resources":{"cpus":1,"memoryMiB":512},"maxAnalysesPerProcess":1000,"privileged":false}` {
		t.Fatalf("settingsDefaults JSON = %s", sd)
	}
}

// The full example of docs/tasks.md §3.4 and its normalised settingsDefaults.
func TestFullExample(t *testing.T) {
	const full = `scantor: 1
name: origins-http
language: typescript
description: Fetch the landing page of every origin of a CrUX top list.
entry: main.ts
defaults:
  workers: 4
  processes: 8
  timeout: 2m
  maxAttempts: 3
  backoff:
    initial: 10s
    factor: 2
    max: 10m
    jitter: true
  resources:
    cpus: 0.5
    memory: 768MiB
  maxAnalysesPerProcess: 500
  privileged: false
`
	res, issues := check(t, full, Options{IsRegularFile: func(p string) bool { return p == "main.ts" }})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	got, _ := json.Marshal(res.SettingsDefaults)
	want := `{"workers":4,"processes":8,"timeoutMs":120000,"maxAttempts":3,"backoff":{"initialMs":10000,"factor":2,"maxMs":600000,"jitter":true},"resources":{"cpus":0.5,"memoryMiB":768},"maxAnalysesPerProcess":500,"privileged":false}`
	if string(got) != want {
		t.Fatalf("settingsDefaults = %s\nwant %s", got, want)
	}
	m, _ := json.Marshal(res.Manifest)
	if !strings.Contains(string(m), `"defaults":{"workers":4,"processes":8,"timeout":"2m"`) || !strings.Contains(string(m), `"memory":"768MiB"`) {
		t.Fatalf("manifest keeps the written defaults: %s", m)
	}
}

func TestRules(t *testing.T) {
	cases := []struct {
		name    string
		yaml    string
		opts    Options
		rule    string
		line    int
		message string
	}{
		{"duplicate key", "scantor: 1\nname: echo\nlanguage: python\nname: other\n", Options{}, "M1", 4, `duplicate key "name"`},
		{"invalid yaml", "scantor: 1\nname: [echo\n", Options{}, "M1", 0, "invalid YAML"},
		{"not a mapping", "- a\n- b\n", Options{}, "M1", 1, "root must be a mapping"},
		{"two documents", "scantor: 1\n---\nname: x\n", Options{}, "M1", 0, "exactly one YAML document"},
		{"empty", "", Options{}, "M1", 1, "empty"},
		{"unknown key", "scantor: 1\nname: echo\nlanguage: python\n$schema: x\n", Options{}, "M2", 4, `unknown key "$schema"`},
		{"missing key", "scantor: 1\nname: echo\n", Options{}, "M2", 1, `missing required key "language"`},
		{"bad version", "scantor: 2\nname: echo\nlanguage: python\n", Options{}, "M2", 1, "/scantor"},
		{"bad duration syntax", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 5 minutes\n", Options{}, "M2", 5, "/defaults/timeout"},
		{"reserved name", "scantor: 1\nname: latest\nlanguage: python\n", Options{}, "M2", 2, "reserved name"},
		{"uuid name", "scantor: 1\nname: 7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c\nlanguage: python\n", Options{}, "M2", 2, "reserved name"},
		{"unknown language", "scantor: 1\nname: echo\nlanguage: rust\n", Options{}, "M2", 3, "/language"},
		{"entry extension", "scantor: 1\nname: echo\nlanguage: typescript\nentry: src/main.rs\n", Options{}, "M4", 4, `entry "src/main.rs" must end in .ts or .mts`},
		{"entry absolute", "scantor: 1\nname: echo\nlanguage: python\nentry: /task/main.py\n", Options{}, "M4", 4, "relative"},
		{"entry not normalised", "scantor: 1\nname: echo\nlanguage: python\nentry: ./main.py\n", Options{}, "M4", 4, "normalised"},
		{"entry dotdot", "scantor: 1\nname: echo\nlanguage: python\nentry: src/../main.py\n", Options{}, "M4", 4, "normalised"},
		{"entry missing", "scantor: 1\nname: echo\nlanguage: python\nentry: src/main.py\n", Options{IsRegularFile: func(string) bool { return false }}, "M4", 4, "not a regular file"},
		{"default entry missing", "scantor: 1\nname: echo\nlanguage: typescript\n", Options{IsRegularFile: func(string) bool { return false }}, "M4", 1, `entry "main.ts" is not a regular file of the task folder (the default entry of typescript tasks`},
		{"binary entry dotdot", "scantor: 1\nname: echo\nlanguage: go\nentry: /task/../bin/task\n", Options{}, "M5", 4, "normalised"},
		{"timeout bounds", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 25h\n", Options{}, "M6", 5, "/defaults/timeout: 25h is outside 1s … 24h"},
		{"timeout too short", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 500ms\n", Options{}, "M6", 5, "outside"},
		{"backoff max < initial", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  backoff:\n    initial: 5s\n    max: 2s\n", Options{}, "M6", 7, "/defaults/backoff/max: 2s is shorter than initial 5s"},
		{"backoff initial > default max", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  backoff:\n    initial: 15m\n", Options{}, "M6", 6, "longer than the default max 10m"},
		{"memory not MiB", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  resources:\n    memory: 1000KiB\n", Options{}, "M7", 6, "whole number of MiB"},
		{"memory bounds", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  resources:\n    memory: 32MiB\n", Options{}, "M7", 6, "outside 64MiB … 64GiB"},
		{"processes limit", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  processes: 200\n", Options{}, "M8", 5, "/defaults/processes: 200 exceeds this instance's maximum 64"},
		{"workers limit", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  workers: 5\n", Options{Limits: Limits{MaxWorkersPerScan: 4, MaxProcessesPerWorker: 64}}, "M8", 5, "exceeds this instance's maximum 4"},
		{"expect name", "scantor: 1\nname: echo2\nlanguage: python\n", Options{ExpectName: "echo"}, "M9", 2, `name "echo2" does not match task "echo"; task names are immutable`},
		{"privileged", "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  privileged: true\n", Options{}, "M10", 5, "privileged tasks require the canRunPrivileged permission"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, issues := check(t, tc.yaml, tc.opts)
			if res != nil || len(issues) == 0 {
				t.Fatalf("accepted: %+v", res)
			}
			var found bool
			for _, is := range issues {
				if is.Rule == tc.rule && strings.Contains(is.Message, tc.message) {
					found = true
					if tc.line != 0 && is.Line != tc.line {
						t.Errorf("line = %d, want %d (%s)", is.Line, tc.line, is.Message)
					}
					be := is.BuildError()
					if be.Phase != api.BuildPhaseStatic || be.File != FileName {
						t.Errorf("BuildError = %+v", be)
					}
				}
			}
			if !found {
				t.Fatalf("no %s issue containing %q in %v", tc.rule, tc.message, issues)
			}
		})
	}
}

func TestPrivilegedAllowed(t *testing.T) {
	res, issues := check(t, "scantor: 1\nname: dind\nlanguage: python\ndefaults:\n  privileged: true\n", Options{AllowPrivileged: true})
	if issues != nil || !res.Privileged || !res.SettingsDefaults.Privileged {
		t.Fatalf("privileged: %+v %v", res, issues)
	}
}

func TestDefaultEntryExists(t *testing.T) {
	exists := func(p string) bool { return p == "main.py" }
	res, issues := check(t, "scantor: 1\nname: echo\nlanguage: python\n", Options{IsRegularFile: exists})
	if issues != nil || res.Manifest.Entry != "main.py" {
		t.Fatalf("python default entry: %+v %v", res, issues)
	}
	// Binary languages have no file to check: the entry is a path inside the image.
	res, issues = check(t, "scantor: 1\nname: echo\nlanguage: go\n", Options{IsRegularFile: exists})
	if issues != nil || res.Manifest.Entry != "/task/task" {
		t.Fatalf("go default entry: %+v %v", res, issues)
	}
}

func TestYAMLFeatures(t *testing.T) {
	const doc = `scantor: 1
name: anchors
language: go
defaults: &d
  workers: 2
  backoff:
    <<: {initial: 2s, factor: 3}
    max: 1m
description: "2026-10-21"
`
	res, issues := check(t, doc, Options{})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	if res.Manifest.Entry != "/task/task" || res.SettingsDefaults.Backoff.InitialMs != 2000 || res.SettingsDefaults.Backoff.Factor != 3 || res.SettingsDefaults.Backoff.MaxMs != 60000 || res.SettingsDefaults.Workers != 2 {
		t.Fatalf("result: %+v", res.SettingsDefaults)
	}
	if res.Manifest.Description != "2026-10-21" {
		t.Fatalf("description = %q", res.Manifest.Description)
	}
	// An unquoted timestamp stays the written string (and is then a valid string for the schema).
	res, issues = check(t, "scantor: 1\nname: ts\nlanguage: python\ndescription: 2026-10-21\n", Options{})
	if issues != nil || res.Manifest.Description != "2026-10-21" {
		t.Fatalf("timestamp: %+v %v", res, issues)
	}
}

func TestTooLarge(t *testing.T) {
	big := "scantor: 1\nname: echo\nlanguage: python\ndescription: \"" + strings.Repeat("x", MaxBytes) + "\"\n"
	_, issues := check(t, big, Options{})
	if len(issues) != 1 || issues[0].Rule != "M1" {
		t.Fatalf("issues: %v", issues)
	}
}

// Nested anchors (billion laughs) expand a few hundred bytes into 8^8 values: the converter's budget
// stops the expansion with an M1 issue long before it allocates them.
func TestAliasExpansionBudget(t *testing.T) {
	var b strings.Builder
	b.WriteString("scantor: 1\nname: echo\nlanguage: python\nx-a0: &a0 [a,a,a,a,a,a,a,a]\n")
	for i := 1; i <= 8; i++ {
		fmt.Fprintf(&b, "x-a%d: &a%d [", i, i)
		for j := 0; j < 8; j++ {
			if j > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, "*a%d", i-1)
		}
		b.WriteString("]\n")
	}
	start := time.Now()
	res, issues := check(t, b.String(), Options{})
	if res != nil || len(issues) != 1 || issues[0].Rule != "M1" || !strings.Contains(issues[0].Message, "expands to more than") {
		t.Fatalf("issues: %v", issues)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("took %s", elapsed)
	}

	// One alias to a large string, repeated, is bounded by the scalar budget.
	b.Reset()
	b.WriteString("scantor: 1\nname: echo\nlanguage: python\nx-s: &s \"" + strings.Repeat("x", 60<<10) + "\"\nx-l: [")
	for j := 0; j < 20; j++ {
		b.WriteString("*s,")
	}
	b.WriteString("]\n")
	if _, issues := check(t, b.String(), Options{}); len(issues) != 1 || !strings.Contains(issues[0].Message, "bytes of values") {
		t.Fatalf("scalar budget: %v", issues)
	}
}

// A long key above many values makes every one of their instance paths long: the pointer budget stops
// both the aliased and the plain variant before the paths, the positions and the JSON copies grow.
func TestLongKeyBudget(t *testing.T) {
	list := func(item string, n int) string {
		return "[" + strings.TrimSuffix(strings.Repeat(item+",", n), ",") + "]"
	}
	var aliased strings.Builder
	aliased.WriteString("scantor: 1\nname: echo\nlanguage: python\nx-m: &m\n  ? " + strings.Repeat("k", 60<<10) + "\n  : " + list("a", 200) + "\n")
	aliased.WriteString("x-a0: &a0 " + list("*m", 8) + "\n")
	for i := 1; i <= 3; i++ {
		fmt.Fprintf(&aliased, "x-a%d: &a%d %s\n", i, i, list(fmt.Sprintf("*a%d", i-1), 8))
	}
	plain := "scantor: 1\nname: echo\nlanguage: python\nx-m:\n  ? " + strings.Repeat("k", 30<<10) + "\n  : " + list("a", 15000) + "\n"
	for name, doc := range map[string]string{"aliased": aliased.String(), "plain": plain} {
		t.Run(name, func(t *testing.T) {
			if len(doc) > MaxBytes {
				t.Fatalf("the document is %d bytes", len(doc))
			}
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			res, issues := check(t, doc, Options{})
			runtime.ReadMemStats(&after)
			if res != nil || len(issues) != 1 || issues[0].Rule != "M1" || !strings.Contains(issues[0].Message, "bytes of keys and paths") {
				t.Fatalf("issues: %v", issues)
			}
			if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 64<<20 {
				t.Fatalf("allocated %d MiB", alloc>>20)
			}
		})
	}
}

// Ordinary anchors, aliases and merge keys stay well inside the budget.
func TestSmallAnchorsPass(t *testing.T) {
	const doc = `scantor: 1
name: anchors
language: go
defaults:
  backoff: &b
    initial: 2s
    factor: 3
  resources:
    <<: [{cpus: 0.5}, {memory: 256MiB}]
description: &d "same text"
`
	res, issues := check(t, doc, Options{})
	if issues != nil {
		t.Fatalf("issues: %v", issues)
	}
	if res.SettingsDefaults.Backoff.Factor != 3 || res.SettingsDefaults.Resources.MemoryMiB != 256 {
		t.Fatalf("result: %+v", res.SettingsDefaults)
	}
}
