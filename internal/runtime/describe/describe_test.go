package describe

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
	"github.com/lonetis/scantor/internal/schema"
	"github.com/lonetis/scantor/internal/templates"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

const closed = `{"type":"object","properties":{},"additionalProperties":false}`

func input(task, scan, analysis, result string, sched protocol.ScheduleInfo) Input {
	return Input{
		ProtocolVersion: 1, Connector: protocol.ConnectorInfo{Language: "python", Version: "1.4.0"},
		Description: protocol.Description{
			Schemas:  protocol.Schemas{TaskConfig: json.RawMessage(task), ScanConfig: json.RawMessage(scan), AnalysisConfig: json.RawMessage(analysis), Result: json.RawMessage(result)},
			Schedule: sched, Warnings: []string{"connector warning"},
		},
	}
}

var single = protocol.ScheduleInfo{Kind: "template", Template: "single"}

func validateOutput(t *testing.T, v any) {
	t.Helper()
	raw, err := scantor.Schemas.ReadFile("schemas/describe.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := schema.Compile(raw)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v)
	instance, _ := schema.ParseJSON(b)
	if issues := s.Validate(instance); len(issues) > 0 {
		t.Fatalf("the output does not match describe.schema.json: %v\n%s", issues, b)
	}
}

func TestDeriveEcho(t *testing.T) {
	task := `{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"apiToken":{"type":["string","null"],"writeOnly":true,"default":"**********","format":"password"}},"additionalProperties":false,"$id":"x"}`
	analysis := `{"type":"object","properties":{"name":{"type":"string","default":"world"}},"additionalProperties":false}`
	result := `{"type":"object","properties":{"text":{"type":"string"},"files":{"type":"array","items":{"$ref":"#/$defs/FileRef"}},"nested":{"type":"object","properties":{"shot":{"$ref":"#/$defs/FileRef"}}}},"required":["text"],"$defs":{"FileRef":{"type":"object","x-scantor":"file","properties":{"id":{"type":"string"}},"additionalProperties":false}}}`
	out, errs := Derive(input(task, closed, analysis, result, single))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	validateOutput(t, out)
	var ts map[string]any
	_ = json.Unmarshal(out.Schemas.TaskConfig, &ts)
	tok := ts["properties"].(map[string]any)["apiToken"].(map[string]any)
	if _, ok := tok["default"]; ok || ts["$schema"] != SchemaURL || ts["$id"] != nil {
		t.Fatalf("normalised task config %v", ts)
	}
	if !slices.Equal(out.SecretPaths.TaskConfig, []string{"/apiToken"}) || !slices.Equal(out.FileRefPaths, []string{"/files/*", "/nested/shot"}) {
		t.Fatalf("paths %+v %v", out.SecretPaths, out.FileRefPaths)
	}
	if out.Schedule.Kind != "template" || out.Schedule.Template != "single" || out.Warnings[0] != "connector warning" {
		t.Fatalf("schedule/warnings %+v %v", out.Schedule, out.Warnings)
	}
	if !slices.ContainsFunc(out.Warnings, func(w string) bool {
		return strings.Contains(w, "/properties/nested: the nested object allows unknown keys")
	}) {
		t.Fatalf("no closure warning for the open nested result object: %v", out.Warnings)
	}
	// single keeps the task's own analysis config and substitutes the canonical scan config.
	if !strings.Contains(string(out.Schemas.AnalysisConfig), `"name"`) {
		t.Fatalf("analysis config %s", out.Schemas.AnalysisConfig)
	}
}

func TestDeriveErrors(t *testing.T) {
	cases := map[string]Input{
		"cannot declare a scan config": input(closed, `{"type":"object","properties":{"count":{"type":"integer","default":1}},"additionalProperties":false}`, closed, `{"type":"object"}`, single),
		"root allows unknown keys":     input(`{"type":"object","properties":{}}`, closed, closed, `{"type":"object"}`, single),
		"does not validate":            input(`{"type":"object","properties":{"n":{"type":"integer","minimum":1,"default":0}},"additionalProperties":false}`, closed, closed, `{"type":"object"}`, single),
		"root must be type object":     input(closed, closed, closed, `{"type":"array"}`, single),
		"does not implement":           input(closed, closed, closed, `{"type":"object"}`, protocol.ScheduleInfo{Kind: "template", Template: "nosuch"}),
		"cannot be resolved":           input(`{"type":"object","properties":{"a":{"$ref":"#/$defs/Missing"}},"additionalProperties":false}`, closed, closed, `{"type":"object"}`, single),
	}
	for want, in := range cases {
		_, errs := Derive(in)
		if !slices.ContainsFunc(errs, func(e string) bool { return strings.Contains(e, want) }) {
			t.Errorf("%s: errors %v", want, errs)
		}
	}
	upload := input(`{"type":"object","properties":{"list":{"type":["string","null"],"x-scantor":"upload","default":null}},"additionalProperties":false}`, closed, closed, `{"type":"object"}`, single)
	out, errs := Derive(upload)
	if len(errs) > 0 || !slices.Equal(out.UploadPaths.TaskConfig, []string{"/list"}) {
		t.Fatalf("upload paths %v %v", out, errs)
	}
}

func TestDeriveTemplateComparison(t *testing.T) {
	scan := `{"type":"object","properties":{"start":{"type":"integer","default":0},"end":{"type":"integer","default":10},"step":{"type":"integer","default":1}},"additionalProperties":false}`
	analysis := `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}`
	out, errs := Derive(input(closed, scan, analysis, `{"type":"object"}`, protocol.ScheduleInfo{Kind: "template", Template: "range"}))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	validateOutput(t, out)
	for _, w := range out.Warnings {
		if strings.Contains(w, "template range") {
			t.Errorf("unexpected comparison warning %q", w)
		}
	}
	wrong := strings.Replace(scan, `"default":10`, `"default":20`, 1)
	out, errs = Derive(input(closed, wrong, analysis, `{"type":"object"}`, protocol.ScheduleInfo{Kind: "template", Template: "range"}))
	if len(errs) > 0 || !slices.ContainsFunc(out.Warnings, func(w string) bool { return strings.Contains(w, `field "end" has a different default`) }) {
		t.Fatalf("warnings %v %v", out.Warnings, errs)
	}
}

func TestDeriveSubsetWarnings(t *testing.T) {
	task := `{"type":"object","properties":{"a":{"allOf":[{"type":"string"}]},"b":{"type":"array","prefixItems":[{"type":"string"}]},"c":{"type":"string","pattern":"(?=x)"},"d":{"anyOf":[{"type":"string"},{"type":"integer"}]},"e":{"type":"integer","maximum":18014398509481984},"f":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}},"additionalProperties":false}`
	out, errs := Derive(input(task, closed, closed, `{"type":"object"}`, single))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	for _, want := range []string{"allOf is outside", "prefixItems is outside", "is not valid in RE2", "anyOf with these branches", "not portable"} {
		if !slices.ContainsFunc(out.Warnings, func(w string) bool { return strings.Contains(w, want) }) {
			t.Errorf("no %q warning in %v", want, out.Warnings)
		}
	}
	if slices.ContainsFunc(out.Warnings, func(w string) bool { return strings.Contains(w, "/properties/f") }) {
		t.Errorf("a nullable union was flagged: %v", out.Warnings)
	}
}

func runDescribe(t *testing.T, mode, schedule string) (int, []map[string]any) {
	t.Helper()
	argv, extra := fakeconn.Command(mode)
	environ := append(os.Environ(), extra...)
	if schedule != "" {
		environ = append(environ, fakeconn.EnvSchedule+"="+schedule)
	}
	cfg := runtime.Config{ConnectorCmd: strconv.Quote(argv[0]) + " " + argv[1], WorkRoot: filepath.Join(t.TempDir(), "scantor"), Environ: environ}
	var out bytes.Buffer
	code := Run(context.Background(), Options{Entry: "main.py", Config: cfg, Stdout: &out, TaskDir: t.TempDir()})
	var events []map[string]any
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var e map[string]any
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatal(err)
		}
		if e["phase"] != "describe" {
			t.Fatalf("event phase %v", e)
		}
		events = append(events, e)
	}
	return code, events
}

func TestRunDescribe(t *testing.T) {
	code, events := runDescribe(t, "ok", "")
	if code != ExitOK {
		t.Fatalf("exit %d: %v", code, events)
	}
	last := events[len(events)-1]
	if last["type"] != "result" {
		t.Fatalf("last event %v", last)
	}
	validateOutput(t, last["description"])
	var sawImport bool
	for _, e := range events {
		if e["type"] == "log" && e["text"] == "importing fake" {
			sawImport = true
		}
	}
	if !sawImport {
		t.Fatalf("connector output was not reported: %v", events)
	}

	code, events = runDescribe(t, "importerror", "")
	if code != ExitFailed || events[len(events)-1]["type"] != "error" {
		t.Fatalf("import error: exit %d %v", code, events)
	}
	msg := events[len(events)-1]["error"].(map[string]any)["message"].(string)
	if !strings.Contains(msg, "boom at import") || !strings.Contains(msg, "Traceback") {
		t.Fatalf("message %q", msg)
	}
	code, events = runDescribe(t, "exitbeforeready", "")
	if msg := events[len(events)-1]["error"].(map[string]any)["message"].(string); code != ExitFailed || !strings.Contains(msg, "Traceback: cannot import") {
		t.Fatalf("stderr tail: exit %d %q", code, msg)
	}
}

// TestSingleWithAnalysisConfigRejectingEmpty: a task without a schedule runs one analysis with {}; an
// analysis config that rejects {} after defaults is reported once (docs/tasks.md §5.1).
func TestSingleWithAnalysisConfigRejectingEmpty(t *testing.T) {
	single := protocol.ScheduleInfo{Kind: "template", Template: "single"}
	required := `{"type":"object","properties":{"host":{"type":"string"}},"required":["host"],"additionalProperties":false}`
	defaulted := `{"type":"object","properties":{"host":{"type":"string","default":"example.org"}},"additionalProperties":false}`
	isEmptyWarning := func(w string) bool { return strings.Contains(w, "analysis config {}") }

	out, errs := Derive(input(closed, closed, required, `{"type":"object"}`, single))
	if len(errs) > 0 || slices.IndexFunc(out.Warnings, isEmptyWarning) < 0 {
		t.Fatalf("required field: warnings %v, errors %v", out.Warnings, errs)
	}
	out, errs = Derive(input(closed, closed, defaulted, `{"type":"object"}`, single))
	if len(errs) > 0 || slices.IndexFunc(out.Warnings, isEmptyWarning) >= 0 {
		t.Fatalf("defaulted field: warnings %v, errors %v", out.Warnings, errs)
	}
	in := input(closed, closed, required, `{"type":"object"}`, single)
	in.Description.Warnings = []string{"the task has no schedule, so every analysis gets the analysis config {}, which AnalysisConfig rejects"}
	out, errs = Derive(in)
	if n := len(slices.DeleteFunc(slices.Clone(out.Warnings), func(w string) bool { return !isEmptyWarning(w) })); len(errs) > 0 || n != 1 {
		t.Fatalf("connector warning: %d warnings about {} in %v", n, out.Warnings)
	}
}

func TestDeriveKeepsPropertyOrder(t *testing.T) {
	// Forms render properties in schema order, so the output keeps the connector's key order at every level
	// ($schema, which normalisation adds, comes first).
	task := `{"type":"object","properties":{"zeta":{"type":"string","default":"z"},"alpha":{"type":"object","properties":{"y":{"type":"integer","default":1},"b":{"type":"integer","default":2}},"additionalProperties":false,"default":{}}},"additionalProperties":false}`
	scan := `{"type":"object","properties":{"start":{"type":"integer","default":1},"end":{"type":"integer","default":11},"onlyOdd":{"type":"boolean","default":false}},"additionalProperties":false}`
	out, errs := Derive(input(task, scan, closed, closed, protocol.ScheduleInfo{Kind: "custom"}))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	wantTask := `{"$schema":"` + SchemaURL + `","type":"object","properties":{"zeta":{"type":"string","default":"z"},"alpha":{"type":"object","properties":{"y":{"type":"integer","default":1},"b":{"type":"integer","default":2}},"additionalProperties":false,"default":{}}},"additionalProperties":false}`
	if string(out.Schemas.TaskConfig) != wantTask {
		t.Fatalf("task config\n got %s\nwant %s", out.Schemas.TaskConfig, wantTask)
	}
	if !strings.Contains(string(out.Schemas.ScanConfig), `"properties":{"start":{"type":"integer","default":1},"end":`) {
		t.Fatalf("scan config order %s", out.Schemas.ScanConfig)
	}
	// The canonical template schemas keep the order of their source files.
	out, errs = Derive(input(closed, scan, `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}`, closed, protocol.ScheduleInfo{Kind: "template", Template: "range"}))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	canonical, _ := templates.Lookup("range")
	want := readKeyOrder(canonical.Info().ScanConfigSchema)["/properties"]
	if got := readKeyOrder(out.Schemas.ScanConfig)["/properties"]; slices.IsSorted(want) || !slices.Equal(got, want) {
		t.Fatalf("range scan config properties %v, canonical %v", got, want)
	}
}

func TestMarshalOrdered(t *testing.T) {
	raw := []byte(`{"b":1,"a/x":{"d":[{"z":1,"y":2}],"c":true},"b":3}`)
	v, err := schema.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	v.(map[string]any)["0added"] = "x"
	got, err := marshalOrdered(v, readKeyOrder(raw))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"0added":"x","b":3,"a/x":{"d":[{"z":1,"y":2}],"c":true}}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if got, _ := marshalOrdered(v, readKeyOrder([]byte("{"))); string(got) != `{"0added":"x","a/x":{"c":true,"d":[{"y":2,"z":1}]},"b":3}` {
		t.Fatalf("unreadable source: %s", got)
	}
}
