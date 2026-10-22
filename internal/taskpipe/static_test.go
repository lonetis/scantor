package taskpipe

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// corpusDir is the shared Dockerfile-policy corpus (docs/testing.md §2).
var corpusDir = filepath.Join("..", "..", "tests", "corpora", "dockerfile-policy")

type corpusExpect struct {
	Description string `json:"description"`
	Options     struct {
		RegistryPublicHost string `json:"registryPublicHost"`
		PublicURL          string `json:"publicUrl"`
	} `json:"options"`
	Errors []struct {
		Phase string `json:"phase"`
		File  string `json:"file"`
		Line  int    `json:"line"`
		Rule  string `json:"rule"`
	} `json:"errors"`
	Warnings []struct {
		Line int    `json:"line"`
		Rule string `json:"rule"`
	} `json:"warnings"`
}

// ruleSuffix extracts the rule id at the end of a policy message ("… (D5)").
var ruleSuffix = regexp.MustCompile(`\(([DW][0-9]+)\)$`)

// warningLine extracts the line of a rendered warning ("Dockerfile:7: … (W1)").
var warningLine = regexp.MustCompile(`^Dockerfile(?::([0-9]+))?: `)

type ruleAt struct {
	Rule string
	Line int
}

func sortRules(rs []ruleAt) []ruleAt {
	slices.SortFunc(rs, func(a, b ruleAt) int {
		if a.Line != b.Line {
			return a.Line - b.Line
		}
		return strings.Compare(a.Rule, b.Rule)
	})
	return rs
}

// TestDockerfilePolicyCorpus runs check-static over every case of tests/corpora/dockerfile-policy and
// compares the structured errors {phase, file, line} and their rule ids, and the warnings.
func TestDockerfilePolicyCorpus(t *testing.T) {
	entries, err := os.ReadDir(corpusDir)
	if err != nil {
		t.Fatal(err)
	}
	cases := 0
	rulesSeen := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		cases++
		t.Run(e.Name(), func(t *testing.T) {
			dockerfile, err := os.ReadFile(filepath.Join(corpusDir, e.Name(), "Dockerfile"))
			if err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(corpusDir, e.Name(), "expect.json"))
			if err != nil {
				t.Fatal(err)
			}
			var exp corpusExpect
			if err := json.Unmarshal(raw, &exp); err != nil {
				t.Fatal(err)
			}
			files := minimalTask()
			files["Dockerfile"] = string(dockerfile)
			cfg := testConfig()
			if exp.Options.PublicURL != "" {
				cfg.PublicURL = exp.Options.PublicURL
			}
			if exp.Options.RegistryPublicHost != "" {
				cfg.RegistryPublicHost = exp.Options.RegistryPublicHost
			}
			res := CheckStatic(mustPackDir(t, writeTree(t, files)), StaticOptions{}, cfg)

			var want, got []ruleAt
			for _, we := range exp.Errors {
				want = append(want, ruleAt{we.Rule, we.Line})
				rulesSeen[we.Rule] = true
			}
			for _, be := range res.Errors {
				if be.Phase != api.BuildPhaseStatic || be.File != DockerfileName {
					t.Errorf("error %+v: want phase static and file Dockerfile", be)
				}
				m := ruleSuffix.FindStringSubmatch(be.Message)
				if m == nil {
					t.Errorf("error message %q does not end with a rule id", be.Message)
					continue
				}
				got = append(got, ruleAt{m[1], be.Line})
			}
			if !slices.Equal(sortRules(got), sortRules(want)) {
				t.Errorf("%s\nerrors: got %v, want %v\nmessages: %v", exp.Description, got, want, res.Errors)
			}

			var wantW, gotW []ruleAt
			for _, w := range exp.Warnings {
				wantW = append(wantW, ruleAt{w.Rule, w.Line})
				rulesSeen[w.Rule] = true
			}
			for _, w := range res.Warnings {
				m, lm := ruleSuffix.FindStringSubmatch(w), warningLine.FindStringSubmatch(w)
				if m == nil || lm == nil {
					t.Errorf("warning %q is not rendered as Dockerfile[:line]: … (Wn)", w)
					continue
				}
				line := 0
				if lm[1] != "" {
					line, _ = strconv.Atoi(lm[1])
				}
				gotW = append(gotW, ruleAt{m[1], line})
			}
			if !slices.Equal(sortRules(gotW), sortRules(wantW)) {
				t.Errorf("%s\nwarnings: got %v, want %v (%q)", exp.Description, gotW, wantW, res.Warnings)
			}
		})
	}
	if cases < 50 {
		t.Fatalf("the corpus has %d cases; expected the full corpus", cases)
	}
	for _, rule := range []string{"D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "W1", "W2"} {
		if !rulesSeen[rule] {
			t.Errorf("no corpus case covers rule %s", rule)
		}
	}
}

// TestForbiddenManagedLabelKeys checks that every key of the managed label set (schemas/managed-labels.json)
// is rejected as a Dockerfile LABEL key, in any case (rule D9, docs/security.md LBL-2).
func TestForbiddenManagedLabelKeys(t *testing.T) {
	set, err := container.Labels()
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{set.KindKey}
	for k := range set.Fixed {
		keys = append(keys, k)
	}
	for k := range set.IdentityKeys {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, key := range keys {
		for _, variant := range []string{key, strings.ToUpper(key), `"` + key + `"`} {
			files := minimalTask()
			files["Dockerfile"] = testDockerfile + "LABEL " + variant + "=x\n"
			res := CheckStatic(mustPackDir(t, writeTree(t, files)), StaticOptions{}, testConfig())
			if len(res.Errors) != 1 || !strings.HasSuffix(res.Errors[0].Message, "(D9)") || res.Errors[0].Line != 6 {
				t.Errorf("LABEL %s: got %+v, want one D9 error on line 6", variant, res.Errors)
			}
		}
	}
	files := minimalTask()
	files["Dockerfile"] = testDockerfile + "LABEL org.opencontainers.image.title=echo traefikx=1 scantorx.y=2\n"
	if res := CheckStatic(mustPackDir(t, writeTree(t, files)), StaticOptions{}, testConfig()); !res.OK() {
		t.Errorf("ordinary labels rejected: %+v", res.Errors)
	}
}

func TestCheckStaticSteps(t *testing.T) {
	tests := []struct {
		name    string
		edit    func(files map[string]string)
		opts    StaticOptions
		wantErr []api.BuildError
	}{
		{
			name: "valid",
			edit: func(map[string]string) {},
		},
		{
			name:    "missing manifest",
			edit:    func(f map[string]string) { delete(f, "scantor.yaml") },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Message: "scantor.yaml is missing: every task needs a manifest at its root"}},
		},
		{
			name: "scantor.yml is not accepted",
			edit: func(f map[string]string) {
				f["scantor.yml"] = f["scantor.yaml"]
				delete(f, "scantor.yaml")
			},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Message: "scantor.yaml is missing: rename scantor.yml to scantor.yaml"}},
		},
		{
			name:    "manifest over 64 KiB",
			edit:    func(f map[string]string) { f["scantor.yaml"] = testManifest + "#" + strings.Repeat("x", 64<<10) + "\n" },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Message: fmt.Sprintf("the manifest is %d bytes; the limit is 65536 (M1)", len(testManifest)+64<<10+2)}},
		},
		{
			name:    "missing Dockerfile",
			edit:    func(f map[string]string) { delete(f, "Dockerfile") },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "Dockerfile", Message: "Dockerfile is missing: every task needs a Dockerfile at its root (FROM ${SCANTOR_BASE})"}},
		},
		{
			name: "manifest errors stop before the Dockerfile policy",
			edit: func(f map[string]string) {
				f["scantor.yaml"] = "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  privileged: true\n"
				f["Dockerfile"] = "FROM alpine\n"
			},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Line: 5, Column: 15, Message: "privileged tasks require the canRunPrivileged permission"}},
		},
		{
			name: "privileged allowed",
			edit: func(f map[string]string) {
				f["scantor.yaml"] = "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  privileged: true\n"
			},
			opts: StaticOptions{AllowPrivileged: true},
		},
		{
			name:    "expected name",
			edit:    func(map[string]string) {},
			opts:    StaticOptions{ExpectName: "echo2"},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Line: 2, Column: 7, Message: `name "echo" does not match task "echo2"; task names are immutable`}},
		},
		{
			name: "default entry missing (M4)",
			edit: func(f map[string]string) { delete(f, "main.py") },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor.yaml", Line: 1, Column: 1,
				Message: `entry "main.py" is not a regular file of the task folder (the default entry of python tasks; set entry in scantor.yaml to use another file)`}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := minimalTask()
			tt.edit(files)
			res := CheckStatic(mustPackDir(t, writeTree(t, files)), tt.opts, testConfig())
			if !slices.Equal(res.Errors, tt.wantErr) {
				t.Fatalf("errors:\n got  %+v\n want %+v", res.Errors, tt.wantErr)
			}
			if res.OK() && res.Manifest == nil {
				t.Fatal("a passing check must return the normalised manifest")
			}
		})
	}
}

func TestCheckStaticNormalisedResult(t *testing.T) {
	files := minimalTask()
	files["scantor.yaml"] = "scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 2m\n  resources:\n    memory: 768MiB\n"
	res := CheckStatic(mustPackDir(t, writeTree(t, files)), StaticOptions{}, testConfig())
	if !res.OK() {
		t.Fatal(res.Errors)
	}
	m := res.Manifest
	if m.Manifest.Entry != "main.py" || m.Language.Name != "python" || m.SettingsDefaults.TimeoutMs != 120000 || m.SettingsDefaults.Resources.MemoryMiB != 768 {
		t.Fatalf("normalised manifest: %+v", m)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("warnings: %v", res.Warnings)
	}
	delete(files, ".dockerignore")
	res = CheckStatic(mustPackDir(t, writeTree(t, files)), StaticOptions{}, testConfig())
	if len(res.Warnings) != 1 || !strings.HasPrefix(res.Warnings[0], ".dockerignore: ") || !strings.HasSuffix(res.Warnings[0], "(W3)") {
		t.Fatalf("W3: %v", res.Warnings)
	}
}

func TestForbiddenHosts(t *testing.T) {
	cfg := Config{PublicURL: "https://Scantor.Example:8443/x", RegistryPublicHost: "Registry.Example:5000"}
	if got := cfg.ForbiddenHosts(); !slices.Equal(got, []string{"registry.example", "scantor.example"}) {
		t.Fatalf("ForbiddenHosts = %v", got)
	}
	if got := (Config{RegistryPublicHost: "[::1]:5000"}).ForbiddenHosts(); !slices.Equal(got, []string{"::1"}) {
		t.Fatalf("ForbiddenHosts = %v", got)
	}
	if got := (Config{}).ForbiddenHosts(); len(got) != 0 {
		t.Fatalf("ForbiddenHosts = %v", got)
	}
}
