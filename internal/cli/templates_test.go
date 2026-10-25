package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/templates"
)

func runTemplates(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	app, out, errOut := testApp(nil)
	app.Stdin = strings.NewReader(stdin)
	code := run(app, args...)
	return code, out.String(), errOut.String()
}

func TestTemplatesList(t *testing.T) {
	code, out, _ := runTemplates(t, "", "templates", "list", "-o", "json")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	var doc struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	var names []string
	for _, item := range doc.Items {
		var name string
		if err := json.Unmarshal(item["name"], &name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
		for _, key := range []string{"title", "description", "scanConfigSchema", "analysisConfigSchema", "example", "resolves"} {
			if _, ok := item[key]; !ok {
				t.Errorf("%s lacks %q", name, key)
			}
		}
	}
	if strings.Join(names, ",") != strings.Join(templates.Names(), ",") {
		t.Fatalf("names %v, want %v", names, templates.Names())
	}

	code, out, _ = runTemplates(t, "", "templates", "list")
	if code != 0 || !strings.Contains(out, "NAME") || !strings.Contains(out, "tranco") || !strings.Contains(out, "upperBound") {
		t.Fatalf("human output (exit %d):\n%s", code, out)
	}
}

func TestTemplatesEstimate(t *testing.T) {
	file := filepath.Join(t.TempDir(), "scan.json")
	if err := os.WriteFile(file, []byte(`{"start": 0, "end": 100, "step": 7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	const upload = "7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c"
	cases := []struct {
		name  string
		stdin string
		args  []string
		want  string
	}{
		{"defaults", "", []string{"cidr"}, `{"expectedTotal": 8, "exact": true}`},
		{"inline", "", []string{"cidr", "--config", `{"cidrs": ["10.0.0.0/24", "10.0.0.128/25"]}`}, `{"expectedTotal": 256, "exact": true}`},
		{"stdin", `{"times": 5}`, []string{"repeat", "--config", "-"}, `{"expectedTotal": 5, "exact": true}`},
		{"empty stdin is {}", "  \n", []string{"repeat", "--config", "-"}, `{"expectedTotal": 1, "exact": true}`},
		{"blank inline is {}", "", []string{"repeat", "--config", " "}, `{"expectedTotal": 1, "exact": true}`},
		{"file", "", []string{"range", "--config", "@" + file}, `{"expectedTotal": 15, "exact": true}`},
		{"scan-config alias", "", []string{"tranco", "--scan-config", `{"offset": 10, "limit": 500}`}, `{"expectedTotal": 500, "exact": true}`},
		{"upper bound", "", []string{"crux", "--config", `{"country": "de", "bucket": 5000}`}, `{"expectedTotal": 5000, "exact": false}`},
		{
			"upload lines", `{"items": ["a", " ", "b"], "upload": "` + upload + `", "offset": 1}`,
			[]string{"list", "--config", "-", "--upload", upload + "=10"}, `{"expectedTotal": 11, "exact": true}`,
		},
		{"json output mode", "", []string{"single", "-o", "json"}, `{"expectedTotal": 1, "exact": true}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, out, errOut := runTemplates(t, tc.stdin, append([]string{"templates", "estimate"}, tc.args...)...)
			if code != 0 {
				t.Fatalf("exit %d: %s %s", code, out, errOut)
			}
			apiJSONEqual(t, []byte(out), tc.want)
		})
	}
}

func TestTemplatesEstimateRejects(t *testing.T) {
	const upload = "7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c"
	cases := []struct {
		name  string
		stdin string
		args  []string
		path  string
		msg   string
	}{
		{"semantic", "", []string{"cidr", "--config", `{"cidrs": ["10.0.0.0/8"]}`}, "/maxAnalyses", "cidrs expand to 16777216 analyses, above maxAnalyses 65536"},
		{"semantic step", "", []string{"range", "--config", `{"step": 0}`}, "/step", "must not be 0"},
		{"tranco window", "", []string{"tranco", "--config", `{"offset": 999999, "limit": 2}`}, "/limit", "offset + limit"},
		{"schema", "", []string{"repeat", "--config", `{"times": 0}`}, "/times", ""},
		{"unknown key", "", []string{"single", "--config", `{"x": 1}`}, "", ""},
		{"not JSON", "{bad", []string{"range", "--config", "-"}, "", "not valid JSON"},
		{"upload without its line count", `{"upload": "` + upload + `"}`, []string{"list", "--config", "-"}, "/upload", "unknown upload " + upload},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, mode := range []string{"human", "json"} {
				code, out, errOut := runTemplates(t, tc.stdin, append([]string{"templates", "estimate", "-o", mode}, tc.args...)...)
				if code != 2 {
					t.Fatalf("%s: exit %d: %s %s", mode, code, out, errOut)
				}
				var doc struct {
					Issues []templates.Issue `json:"issues"`
				}
				if err := json.Unmarshal([]byte(out), &doc); err != nil || len(doc.Issues) == 0 {
					t.Fatalf("%s: stdout %q: %v", mode, out, err)
				}
				if doc.Issues[0].Path != tc.path || !strings.Contains(doc.Issues[0].Message, tc.msg) {
					t.Fatalf("%s: issues %+v, want path %q containing %q", mode, doc.Issues, tc.path, tc.msg)
				}
				if mode == "human" && !strings.Contains(errOut, "the scan config is invalid") {
					t.Fatalf("human stderr %q", errOut)
				}
			}
		})
	}
}

func TestTemplatesEstimateUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"nope"},
		{},
		{"cidr", "--config", "{}", "--scan-config", "{}"},
		{"list", "--upload", "x"},
		{"list", "--upload", "x=-1"},
		{"cidr", "--config", "@/nonexistent/scan.json"},
		{"cidr", "--config", "@"},
	} {
		code, out, errOut := runTemplates(t, "", append([]string{"templates", "estimate"}, args...)...)
		if code != 2 {
			t.Errorf("%v: exit %d, want 2: %s %s", args, code, out, errOut)
		}
	}
}
