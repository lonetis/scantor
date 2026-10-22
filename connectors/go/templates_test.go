package scantor_test

import (
	"encoding/json"
	"iter"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/cidr"
	"github.com/lonetis/scantor/connectors/go/templates/crux"
	"github.com/lonetis/scantor/connectors/go/templates/list"
	ranges "github.com/lonetis/scantor/connectors/go/templates/range"
	"github.com/lonetis/scantor/connectors/go/templates/repeat"
	"github.com/lonetis/scantor/connectors/go/templates/single"
	"github.com/lonetis/scantor/connectors/go/templates/tranco"
)

type templateModels struct {
	scanConfig, analysisConfig reflect.Type
	// unwrapped is a task that passes the template's Schedule unwrapped.
	unwrapped *scantor.Task
}

func unwrappedTask[SC, AC any](schedule func(scantor.Context, SC, scantor.Empty) iter.Seq2[AC, error]) *scantor.Task {
	return scantor.NewTask(schedule, func(scantor.Context, AC, scantor.Empty) (nResult, error) { return nResult{}, nil })
}

var templates = map[string]templateModels{
	"single": {reflect.TypeFor[single.ScanConfig](), reflect.TypeFor[single.AnalysisConfig](), unwrappedTask(single.Schedule[scantor.Empty])},
	"list":   {reflect.TypeFor[list.ScanConfig](), reflect.TypeFor[list.AnalysisConfig](), unwrappedTask(list.Schedule[scantor.Empty])},
	"range":  {reflect.TypeFor[ranges.ScanConfig](), reflect.TypeFor[ranges.AnalysisConfig](), unwrappedTask(ranges.Schedule[scantor.Empty])},
	"repeat": {reflect.TypeFor[repeat.ScanConfig](), reflect.TypeFor[repeat.AnalysisConfig](), unwrappedTask(repeat.Schedule[scantor.Empty])},
	"tranco": {reflect.TypeFor[tranco.ScanConfig](), reflect.TypeFor[tranco.AnalysisConfig](), unwrappedTask(tranco.Schedule[scantor.Empty])},
	"crux":   {reflect.TypeFor[crux.ScanConfig](), reflect.TypeFor[crux.AnalysisConfig](), unwrappedTask(crux.Schedule[scantor.Empty])},
	"cidr":   {reflect.TypeFor[cidr.ScanConfig](), reflect.TypeFor[cidr.AnalysisConfig](), unwrappedTask(cidr.Schedule[scantor.Empty])},
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

// TestEveryTemplateHasAProxy guards against a template added to schemas/templates without a Go proxy.
func TestEveryTemplateHasAProxy(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(schemasDir, "templates", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range files {
		if !strings.HasSuffix(f, ".fixtures.json") {
			names = append(names, strings.TrimSuffix(filepath.Base(f), ".json"))
		}
	}
	if len(names) == 0 {
		t.Fatalf("no templates under %s", schemasDir)
	}
	for _, n := range names {
		if _, ok := templates[n]; !ok {
			t.Errorf("template %s has no proxy package", n)
		}
	}
	if len(names) != len(templates) {
		t.Errorf("proxies %d, templates %d", len(templates), len(names))
	}
}

// TestTemplateDetection checks that an unwrapped proxy is reported as the template (D4/D5).
func TestTemplateDetection(t *testing.T) {
	for name, m := range templates {
		if got := scantor.TemplateName(m.unwrapped); got != name {
			t.Errorf("%s: detected %q", name, got)
		}
	}
	// Inference from an uninstantiated generic proxy.
	task := scantor.NewTask(cidr.Schedule, func(scantor.Context, cidr.AnalysisConfig, echoTaskConfig) (nResult, error) {
		return nResult{}, nil
	})
	if got := scantor.TemplateName(task); got != "cidr" {
		t.Errorf("inferred proxy detected as %q", got)
	}
}

// TestTemplateModelsMatchCanonical compares the exported schemas of the proxy models with
// schemas/templates/<name>.json (conformance case D5, strict).
func TestTemplateModelsMatchCanonical(t *testing.T) {
	for name, m := range templates {
		t.Run(name, func(t *testing.T) {
			var canonical struct {
				Defs map[string]map[string]any `json:"$defs"`
			}
			readJSON(t, filepath.Join(schemasDir, "templates", name+".json"), &canonical)
			for key, typ := range map[string]reflect.Type{"scanConfig": m.scanConfig, "analysisConfig": m.analysisConfig} {
				raw, err := scantor.ReflectSchema(typ, false)
				if err != nil {
					t.Fatal(err)
				}
				var got map[string]any
				if err := json.Unmarshal(raw, &got); err != nil {
					t.Fatal(err)
				}
				compareSchemas(t, name+"."+key, got, canonical.Defs[key])
			}
		})
	}
}

// compareKeywords are compared exactly; annotations (title, description) are not.
var compareKeywords = []string{
	"default", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	"minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "x-scantor", "writeOnly",
}

func compareSchemas(t *testing.T, where string, got, want map[string]any) {
	t.Helper()
	if !reflect.DeepEqual(typeSet(got), typeSet(want)) {
		t.Errorf("%s: type %v, canonical %v", where, typeSet(got), typeSet(want))
	}
	if !reflect.DeepEqual(stringSet(got["required"]), stringSet(want["required"])) {
		t.Errorf("%s: required %v, canonical %v", where, got["required"], want["required"])
	}
	if got["additionalProperties"] != want["additionalProperties"] {
		t.Errorf("%s: additionalProperties %v, canonical %v", where, got["additionalProperties"], want["additionalProperties"])
	}
	for _, k := range compareKeywords {
		g, gok := got[k]
		w, wok := want[k]
		if k == "enum" {
			g, w = withoutNull(g), withoutNull(w)
		}
		if gok != wok || !reflect.DeepEqual(g, w) {
			t.Errorf("%s: %s = %v, canonical %v", where, k, g, w)
		}
	}
	if items, ok := want["items"].(map[string]any); ok {
		gotItems, _ := got["items"].(map[string]any)
		compareSchemas(t, where+".items", gotItems, items)
	}
	gotProps, _ := got["properties"].(map[string]any)
	wantProps, _ := want["properties"].(map[string]any)
	if !reflect.DeepEqual(sortedKeys(gotProps), sortedKeys(wantProps)) {
		t.Errorf("%s: properties %v, canonical %v", where, sortedKeys(gotProps), sortedKeys(wantProps))
		return
	}
	for name, w := range wantProps {
		compareSchemas(t, where+"."+name, gotProps[name].(map[string]any), w.(map[string]any))
	}
}

func typeSet(s map[string]any) []string {
	switch t := s["type"].(type) {
	case string:
		return []string{t}
	case []any:
		return stringSet(t)
	}
	return nil
}

func stringSet(v any) []string {
	list, _ := v.([]any)
	out := []string{}
	for _, x := range list {
		out = append(out, x.(string))
	}
	sort.Strings(out)
	return out
}

func withoutNull(v any) any {
	list, ok := v.([]any)
	if !ok {
		return v
	}
	return slices.DeleteFunc(slices.Clone(list), func(x any) bool { return x == nil })
}

func sortedKeys(m map[string]any) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

type fixtureFile struct {
	ScanConfig struct {
		Valid []struct {
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			Effective map[string]any  `json:"effective"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
			Kind  string          `json:"kind"`
			Path  string          `json:"path"`
		} `json:"invalid"`
	} `json:"scanConfig"`
	AnalysisConfig struct {
		Valid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
			Path  string          `json:"path"`
		} `json:"invalid"`
	} `json:"analysisConfig"`
}

// TestTemplateFixtures runs the native models over schemas/templates/<name>.fixtures.json: valid
// inputs decode, invalid ones are rejected at the fixture's path, and the scan config a wrapped call
// sends equals the fixture's effective config after the canonical defaults (conformance case T4).
func TestTemplateFixtures(t *testing.T) {
	for name, m := range templates {
		t.Run(name, func(t *testing.T) {
			var fx fixtureFile
			readJSON(t, filepath.Join(schemasDir, "templates", name+".fixtures.json"), &fx)
			var canonical struct {
				Defs map[string]map[string]any `json:"$defs"`
			}
			readJSON(t, filepath.Join(schemasDir, "templates", name+".json"), &canonical)
			for _, c := range fx.ScanConfig.Valid {
				v, err := scantor.DecodeConfig(m.scanConfig, c.Input)
				if err != nil {
					t.Errorf("scanConfig %s: %v", c.Name, err)
					continue
				}
				sent, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				var got map[string]any
				if err := json.Unmarshal(sent, &got); err != nil {
					t.Fatal(err)
				}
				for prop, schema := range canonical.Defs["scanConfig"]["properties"].(map[string]any) {
					if _, ok := got[prop]; !ok {
						if def, has := schema.(map[string]any)["default"]; has {
							got[prop] = def
						}
					}
				}
				if !reflect.DeepEqual(got, c.Effective) {
					t.Errorf("scanConfig %s: sends %s, effective %v, want %v", c.Name, sent, got, c.Effective)
				}
			}
			for _, c := range fx.ScanConfig.Invalid {
				if c.Kind != "schema" {
					continue // semantic issues are found by the runtime's Validate
				}
				_, err := scantor.DecodeConfig(m.scanConfig, c.Input)
				if err == nil {
					t.Errorf("scanConfig %s: accepted %s", c.Name, c.Input)
					continue
				}
				if paths := scantor.ErrorIssues(err); !slices.Contains(paths, c.Path) {
					t.Errorf("scanConfig %s: issues at %v, want %q", c.Name, paths, c.Path)
				}
			}
			for _, c := range fx.AnalysisConfig.Valid {
				v, err := scantor.DecodeConfig(m.analysisConfig, c.Input)
				if err != nil {
					t.Errorf("analysisConfig %s: %v", c.Name, err)
					continue
				}
				back, _ := json.Marshal(v)
				var got, want any
				json.Unmarshal(back, &got)
				json.Unmarshal(c.Input, &want)
				if !reflect.DeepEqual(got, want) {
					t.Errorf("analysisConfig %s: round trip %s, want %s", c.Name, back, c.Input)
				}
			}
			for _, c := range fx.AnalysisConfig.Invalid {
				_, err := scantor.DecodeConfig(m.analysisConfig, c.Input)
				if err == nil {
					t.Errorf("analysisConfig %s: accepted %s", c.Name, c.Input)
					continue
				}
				if paths := scantor.ErrorIssues(err); !slices.Contains(paths, c.Path) {
					t.Errorf("analysisConfig %s: issues at %v, want %q", c.Name, paths, c.Path)
				}
			}
		})
	}
}

// Wrapped template calls (template-wrapped fixture of docs/protocol.md §12.2).

type wrappedScanConfig struct {
	Start     int64  `json:"start" jsonschema:"default=0"`
	End       int64  `json:"end" jsonschema:"default=10"`
	StopAfter *int64 `json:"stopAfter" jsonschema:"default=null"`
}

func wrappedSchedule(ctx scantor.Context, sc wrappedScanConfig, tc scantor.Empty) iter.Seq2[nAnalysisConfig, error] {
	return func(yield func(nAnalysisConfig, error) bool) {
		var n int64
		for item, err := range ranges.Schedule(ctx, ranges.ScanConfig{Start: sc.Start, End: sc.End, Step: 1}, tc) {
			if err != nil {
				yield(nAnalysisConfig{}, err)
				return
			}
			if sc.StopAfter != nil && n >= *sc.StopAfter {
				return
			}
			if !yield(nAnalysisConfig{N: int(item.Value * 2)}, nil) {
				return
			}
			n++
		}
	}
}

func wrappedTask() *scantor.Task { return scantor.NewTask(wrappedSchedule, runN) }

// serveTemplate answers a template request with total items, never exceeding the allowance, until
// the stream is done or cancelled. It returns the analysis messages seen and the final message.
func serveTemplate(t *testing.T, rt *fakeRuntime, tmpl msg, total int) (analyses []msg, final msg, cancelled bool) {
	t.Helper()
	id := tmpl.str("id")
	allowance := int(tmpl.num("credit"))
	sent := 0
	for {
		for sent < allowance && sent < total && !cancelled {
			rt.send(map[string]any{"type": "templateItem", "id": id, "config": map[string]any{"value": sent}})
			sent++
		}
		if sent == total && !cancelled {
			rt.send(map[string]any{"type": "templateDone", "id": id, "count": sent})
			sent++ // done is sent once
		}
		m, ok := rt.next(10 * time.Second)
		if !ok {
			t.Fatal("output closed")
		}
		switch m.str("type") {
		case "templateCredit":
			if m.str("id") != id {
				t.Fatalf("credit for %v", m)
			}
			allowance += int(m.num("credit"))
		case "templateCancel":
			cancelled = true
			rt.send(map[string]any{"type": "templateItem", "id": id, "config": map[string]any{"value": -1}}) // in flight; must be ignored
			rt.send(map[string]any{"type": "templateDone", "id": id, "count": sent})
		case "analysis":
			analyses = append(analyses, m)
		default:
			return analyses, m, cancelled
		}
	}
}

func TestWrappedTemplateFlowControl(t *testing.T) {
	rt := start(t, wrappedTask())
	rt.handshake()
	schedule(rt, "s1", map[string]any{"end": 1000}, t.TempDir())
	tmpl := rt.expect("template")
	if tmpl.str("parent") != "s1" || tmpl.str("template") != "range" || tmpl.num("credit") < 1 {
		t.Fatalf("template %v", tmpl)
	}
	if sc := tmpl.obj("scanConfig"); len(sc) != 3 || sc.num("start") != 0 || sc.num("end") != 1000 || sc.num("step") != 1 {
		t.Fatalf("scanConfig %v", sc)
	}
	analyses, final, _ := serveTemplate(t, rt, tmpl, 1000)
	if len(analyses) != 1000 || analyses[999].obj("config").num("n") != 1998 {
		t.Fatalf("got %d analyses", len(analyses))
	}
	if final.str("type") != "done" || final.num("count") != 1000 {
		t.Fatalf("final %v", final)
	}
}

func TestWrappedTemplateStopsEarly(t *testing.T) {
	rt := start(t, wrappedTask())
	rt.handshake()
	schedule(rt, "s1", map[string]any{"end": 1000, "stopAfter": 5}, t.TempDir())
	analyses, final, cancelled := serveTemplate(t, rt, rt.expect("template"), 1000)
	if len(analyses) != 5 || !cancelled || final.str("type") != "done" || final.num("count") != 5 {
		t.Fatalf("analyses %d cancelled %v final %v", len(analyses), cancelled, final)
	}
	// The process keeps serving.
	schedule(rt, "s2", map[string]any{"end": 3}, t.TempDir())
	if _, final, _ := serveTemplate(t, rt, rt.expect("template"), 3); final.num("count") != 3 {
		t.Fatalf("second schedule %v", final)
	}
}

func TestWrappedTemplateErrors(t *testing.T) {
	cases := []struct {
		err      map[string]any
		wantType string
		wantMsg  string
	}{
		{map[string]any{"type": "platform", "message": "download failed", "retryable": true}, "taskError", "download failed"},
		{map[string]any{"type": "validation", "message": "bad config", "retryable": false}, "validation", "bad config"},
	}
	for _, c := range cases {
		rt := start(t, wrappedTask())
		rt.handshake()
		schedule(rt, "s1", map[string]any{}, t.TempDir())
		tmpl := rt.expect("template")
		rt.send(map[string]any{"type": "error", "id": tmpl.str("id"), "error": c.err})
		e := rt.expect("error").obj("error")
		if e.str("type") != c.wantType || !strings.Contains(e.str("message"), c.wantMsg) {
			t.Errorf("%v: got %v", c.err, e)
		}
	}
	// An item the native model rejects fails scheduling with validation.
	rt := start(t, wrappedTask())
	rt.handshake()
	schedule(rt, "s1", map[string]any{}, t.TempDir())
	tmpl := rt.expect("template")
	rt.send(map[string]any{"type": "templateItem", "id": tmpl.str("id"), "config": map[string]any{"value": "x"}})
	rt.expect("templateCancel")
	rt.send(map[string]any{"type": "templateDone", "id": tmpl.str("id"), "count": 1})
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "template item") {
		t.Fatalf("got %v", e)
	}
}

func TestTemplateOutsideSchedule(t *testing.T) {
	runFn := func(ctx scantor.Context, _ scantor.Empty, tc scantor.Empty) (nResult, error) {
		for _, err := range repeat.Schedule(ctx, repeat.ScanConfig{Times: 2}, tc) {
			return nResult{}, err
		}
		return nResult{}, nil
	}
	rt := start(t, scantor.NewTask[scantor.Empty, scantor.Empty](nil, runFn))
	rt.handshake()
	run(rt, "r1", runCtx(execDir(t), 0, nil), map[string]any{}, map[string]any{})
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "only be iterated in schedule") {
		t.Fatalf("got %v", e)
	}
}

// TestUnwrappedProxyWhenScheduled covers a schedule request for an unwrapped template (the runtime
// normally runs it natively): the proxy streams it through the runtime.
func TestUnwrappedProxyWhenScheduled(t *testing.T) {
	rt := start(t, templates["repeat"].unwrapped)
	rt.handshake()
	rt.send(map[string]any{"type": "describe", "id": "d1"})
	if d := rt.expect("description"); d.obj("schedule").str("template") != "repeat" {
		t.Fatalf("description %v", d.obj("schedule"))
	}
	schedule(rt, "s1", map[string]any{"times": 2}, t.TempDir())
	tmpl := rt.expect("template")
	if tmpl.obj("scanConfig").num("times") != 2 {
		t.Fatalf("template %v", tmpl)
	}
	id := tmpl.str("id")
	for i := range 2 {
		rt.send(map[string]any{"type": "templateItem", "id": id, "config": map[string]any{"iteration": i}})
	}
	rt.send(map[string]any{"type": "templateDone", "id": id, "count": 2})
	for i := range 2 {
		if a := rt.expect("analysis"); a.obj("config").num("iteration") != float64(i) {
			t.Fatalf("analysis %v", a)
		}
	}
	if d := rt.expect("done"); d.num("count") != 2 {
		t.Fatalf("done %v", d)
	}
}
