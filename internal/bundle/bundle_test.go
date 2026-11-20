package bundle

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func canonical(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// mutate decodes the canonical info, applies fn to the generic document and encodes it again.
func mutate(t *testing.T, fn func(doc map[string]any)) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(canonical(t), &doc); err != nil {
		t.Fatal(err)
	}
	fn(doc)
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func object(doc map[string]any, path ...string) map[string]any {
	cur := doc
	for _, p := range path {
		cur = cur[p].(map[string]any)
	}
	return cur
}

// sameInfo compares two infos field by field; the JSON Schemas of the description are compared as
// documents, since Marshal compacts them.
func sameInfo(t *testing.T, got, want *Info) {
	t.Helper()
	g, w := *got, *want
	for _, pair := range [][2]*json.RawMessage{
		{&g.Description.Schemas.TaskConfig, &w.Description.Schemas.TaskConfig},
		{&g.Description.Schemas.ScanConfig, &w.Description.Schemas.ScanConfig},
		{&g.Description.Schemas.AnalysisConfig, &w.Description.Schemas.AnalysisConfig},
		{&g.Description.Schemas.Result, &w.Description.Schemas.Result},
	} {
		var a, b any
		if err := json.Unmarshal(*pair[0], &a); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(*pair[1], &b); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("schema differs: got %s, want %s", *pair[0], *pair[1])
		}
		*pair[0], *pair[1] = nil, nil
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("info differs\ngot  %+v\nwant %+v", g, w)
	}
}

func TestParseCanonical(t *testing.T) {
	info, err := Parse(canonical(t))
	if err != nil {
		t.Fatal(err)
	}
	if info.V != InfoVersion || info.Image != "localhost/scantor/echo:3" || info.Ref != "echo@3" || info.Task != "echo" ||
		info.Revision != 3 || info.Language != "python" || info.Entry != "main.py" ||
		info.Platform != (api.Platform{OS: "linux", Arch: "amd64"}) {
		t.Fatalf("info %+v", info)
	}
	d := info.Description
	if d.ProtocolVersion != 1 || d.Schedule != (api.Schedule{Kind: api.ScheduleKindTemplate, Template: "single"}) ||
		d.Connector.Language != "python" || !bytes.Contains(d.Schemas.TaskConfig, []byte(`"Hello, World!"`)) ||
		d.SecretPaths.Result == nil || d.UploadPaths.ScanConfig == nil || d.FileRefPaths == nil || d.Warnings == nil {
		t.Fatalf("description %+v", d)
	}
	wantSettings := Settings{
		Processes: 1, TimeoutMs: 300000, MaxAttempts: 3,
		Backoff:   api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 600000, Jitter: true},
		Resources: api.Resources{CPUs: 1, MemoryMiB: 512}, MaxAnalysesPerProcess: 1000,
	}
	if info.Settings != wantSettings {
		t.Fatalf("settings %+v", info.Settings)
	}
	wantLimits := Limits{
		MaxAnalysisConfigBytes: 65536, MaxResultBytes: 1048576, MaxFileBytes: 1073741824, MaxFilesPerAnalysis: 100,
		LogTailBytes: 32768, LogTailEarlierBytes: 4096, MaxProcesses: 64,
	}
	if info.Limits != wantLimits {
		t.Fatalf("limits %+v", info.Limits)
	}
}

func TestParseRejects(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		want string
	}{
		{"not JSON", []byte(`{"v":1`), "not JSON"},
		{"trailing data", append(canonical(t), []byte(`{}`)...), "not JSON"},
		{"not an object", []byte(`[]`), "does not match"},
		{"oversize", append(canonical(t), bytes.Repeat([]byte(" "), MaxInfoBytes)...), "the limit is"},
		{"unknown top-level field", mutate(t, func(d map[string]any) { d["userId"] = "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11" }), "does not match"},
		{"unknown settings field", mutate(t, func(d map[string]any) { object(d, "settings")["workers"] = 2 }), "does not match"},
		{"privileged setting", mutate(t, func(d map[string]any) { object(d, "settings")["privileged"] = false }), "does not match"},
		{"node selector", mutate(t, func(d map[string]any) { object(d, "settings")["nodeSelector"] = map[string]any{"pool": "shared"} }), "does not match"},
		{"unknown backoff field", mutate(t, func(d map[string]any) { object(d, "settings", "backoff")["extra"] = 1 }), "does not match"},
		{"unknown limits field", mutate(t, func(d map[string]any) { object(d, "limits")["registry"] = "localhost:5000" }), "does not match"},
		{"unknown platform field", mutate(t, func(d map[string]any) { object(d, "platform")["digest"] = "sha256:00" }), "does not match"},
		{"unknown description field", mutate(t, func(d map[string]any) { object(d, "description")["secrets"] = map[string]any{} }), "does not match"},
		{"unknown connector field", mutate(t, func(d map[string]any) { object(d, "description", "connector")["url"] = "http://x" }), "does not match"},
		{"unknown schemas field", mutate(t, func(d map[string]any) { object(d, "description", "schemas")["extra"] = map[string]any{} }), "does not match"},
		{"custom schedule with a template", mutate(t, func(d map[string]any) { object(d, "description", "schedule")["kind"] = "custom" }), "does not match"},
		{"template schedule without a template", mutate(t, func(d map[string]any) { delete(object(d, "description", "schedule"), "template") }), "does not match"},
		{"null path list", mutate(t, func(d map[string]any) { object(d, "description", "secretPaths")["result"] = nil }), "does not match"},
		{"invalid pointer", mutate(t, func(d map[string]any) {
			object(d, "description", "secretPaths")["taskConfig"] = []any{"token"}
		}), "does not match"},
		{"wrong version", mutate(t, func(d map[string]any) { d["v"] = 2 }), "does not match"},
		{"other os", mutate(t, func(d map[string]any) { object(d, "platform")["os"] = "windows" }), "does not match"},
		{"missing description", mutate(t, func(d map[string]any) { delete(d, "description") }), "does not match"},
		{"missing limits", mutate(t, func(d map[string]any) { delete(d, "limits") }), "does not match"},
		{"missing jitter", mutate(t, func(d map[string]any) { delete(object(d, "settings", "backoff"), "jitter") }), "does not match"},
		{"missing max processes", mutate(t, func(d map[string]any) { delete(object(d, "limits"), "maxProcesses") }), "does not match"},
		{"zero limit", mutate(t, func(d map[string]any) { object(d, "limits")["maxResultBytes"] = 0 }), "does not match"},
		{"negative files limit", mutate(t, func(d map[string]any) { object(d, "limits")["maxFilesPerAnalysis"] = -1 }), "does not match"},
		{"processes out of bounds", mutate(t, func(d map[string]any) { object(d, "settings")["processes"] = 0 }), "does not match"},
		{"empty entry", mutate(t, func(d map[string]any) { d["entry"] = "" }), "does not match"},
		{"registry image", mutate(t, func(d map[string]any) { d["image"] = "localhost:5000/tasks/7f3b2c1a:3" }), "does not match"},
		{"invalid task", mutate(t, func(d map[string]any) { d["task"] = "Echo" }), "does not match"},
		{"image of another task", mutate(t, func(d map[string]any) { d["image"] = "localhost/scantor/other:3" }), "names the image"},
		{"image of another revision", mutate(t, func(d map[string]any) { d["image"] = "localhost/scantor/echo:4" }), "names the image"},
		{"ref of another revision", mutate(t, func(d map[string]any) { d["ref"] = "echo@4" }), "names the revision"},
		{"ref of another task", mutate(t, func(d map[string]any) { d["ref"] = "other@3" }), "names the revision"},
		{"non-integer revision", mutate(t, func(d map[string]any) { d["revision"] = 3.5 }), "does not match"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			info, err := Parse(tc.data)
			if err == nil || info != nil {
				t.Fatalf("accepted: %+v", info)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

func TestParseKeepsSchemasOpaque(t *testing.T) {
	data := mutate(t, func(d map[string]any) {
		task := object(d, "description", "schemas", "taskConfig")
		task["x-anything"] = map[string]any{"nested": []any{1, "two"}}
		object(d, "platform")["variant"] = "v8"
	})
	info, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(info.Description.Schemas.TaskConfig, []byte(`"x-anything"`)) || info.Platform.Variant != "v8" {
		t.Fatalf("info %+v", info)
	}
}

// SCANTOR_MAX_FILES_PER_ANALYSIS=0 is a valid master setting (analyses store no files), so a bundle info with it
// must parse.
func TestParseZeroFilesPerAnalysis(t *testing.T) {
	info, err := Parse(mutate(t, func(d map[string]any) { object(d, "limits")["maxFilesPerAnalysis"] = 0 }))
	if err != nil {
		t.Fatal(err)
	}
	if info.Limits.MaxFilesPerAnalysis != 0 {
		t.Fatalf("limits %+v", info.Limits)
	}
}

func TestParseWithoutWarnings(t *testing.T) {
	info, err := Parse(mutate(t, func(d map[string]any) { delete(object(d, "description"), "warnings") }))
	if err != nil {
		t.Fatal(err)
	}
	if info.Description.Warnings == nil || len(info.Description.Warnings) != 0 {
		t.Fatalf("warnings %#v", info.Description.Warnings)
	}
}

func TestParseCustomSchedule(t *testing.T) {
	info, err := Parse(mutate(t, func(d map[string]any) {
		object(d, "description")["schedule"] = map[string]any{"kind": "custom"}
	}))
	if err != nil || info.Description.Schedule != (api.Schedule{Kind: api.ScheduleKindCustom}) {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	info, err := Parse(canonical(t))
	if err != nil {
		t.Fatal(err)
	}
	info.Description.Warnings = []string{"a <b> & c"}
	data, err := info.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(data, []byte("}\n")) || bytes.Count(data, []byte("\n")) != 1 {
		t.Fatalf("not one line with a trailing newline: %q", data)
	}
	if !bytes.Contains(data, []byte(`"a <b> & c"`)) {
		t.Fatalf("HTML escaped: %s", data)
	}
	back, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	sameInfo(t, back, info)
	// The canonical file and the marshalled info are the same document.
	var want, got any
	_ = json.Unmarshal(canonical(t), &want)
	info.Description.Warnings = []string{}
	data, _ = info.Marshal()
	_ = json.Unmarshal(data, &got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("Marshal differs from testdata/bundle.json:\n%s", data)
	}
}

func TestMarshalNormalisesNilLists(t *testing.T) {
	info, err := Parse(canonical(t))
	if err != nil {
		t.Fatal(err)
	}
	built := *info
	built.Description.SecretPaths = api.SecretPaths{}
	built.Description.UploadPaths = api.UploadPaths{}
	built.Description.FileRefPaths = nil
	built.Description.Warnings = nil
	data, err := built.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("null")) {
		t.Fatalf("null in %s", data)
	}
	if built.Description.Warnings != nil || built.Description.SecretPaths.TaskConfig != nil {
		t.Fatal("Marshal changed its receiver")
	}
	back, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	sameInfo(t, back, info)
	if _, err := (*Info)(nil).Marshal(); err == nil {
		t.Fatal("a nil info was marshalled")
	}
}

func TestMarshalOfInvalidInfoFailsParse(t *testing.T) {
	info, err := Parse(canonical(t))
	if err != nil {
		t.Fatal(err)
	}
	info.Image = ImageName("echo", 4)
	data, err := info.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(data); err == nil {
		t.Fatal("an info whose image does not match its revision was accepted")
	}
}

func TestNames(t *testing.T) {
	if got := ImageName("origins-http", 12); got != "localhost/scantor/origins-http:12" {
		t.Errorf("ImageName = %q", got)
	}
	if got := RevisionRef("origins-http", 12); got != "origins-http@12" {
		t.Errorf("RevisionRef = %q", got)
	}
	if got := FileName("echo", 3, api.Platform{OS: "linux", Arch: "amd64"}); got != "echo-3-linux-amd64.bundle.tar.gz" {
		t.Errorf("FileName = %q", got)
	}
	if got := FileName("echo", 3, api.Platform{OS: "linux", Arch: "arm64", Variant: "v8"}); got != "echo-3-linux-arm64.bundle.tar.gz" {
		t.Errorf("FileName with a variant = %q", got)
	}
}
