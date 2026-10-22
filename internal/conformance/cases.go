package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/canonical"
	"github.com/lonetis/scantor/internal/runtime/describe"
	"github.com/lonetis/scantor/internal/schema"
	"github.com/lonetis/scantor/internal/templates"
)

// Case is one conformance case of docs/protocol.md §12.3.
type Case struct {
	ID string
	// Fixtures are the fixtures the case runs on ("template-*" matches every template fixture).
	Fixtures []string
	// NotFor lists languages without the case (Go has no echo-async, import-error, bad-definition).
	NotFor []string
	Run    func(h *H) error
}

// Cases is the catalogue in execution order. P1 (every fd 4 line is valid) is checked in every case.
var Cases = []Case{
	{ID: "H1", Fixtures: []string{"echo"}, Run: caseH1},
	{ID: "H2", Fixtures: []string{"echo"}, Run: caseH2},
	{ID: "H3", Fixtures: []string{"import-error"}, NotFor: []string{"go"}, Run: caseH3},
	{ID: "H4", Fixtures: []string{"bad-definition"}, NotFor: []string{"go"}, Run: caseH4},
	{ID: "H5", Fixtures: []string{"echo"}, Run: caseH5},
	{ID: "D1", Fixtures: []string{"echo"}, Run: caseD1},
	{ID: "D2", Fixtures: []string{"minimal"}, Run: caseD2},
	{ID: "D3", Fixtures: []string{"schedule"}, Run: caseD3},
	{ID: "D4", Fixtures: []string{"template-unwrapped"}, Run: caseD4},
	{ID: "D5", Fixtures: []string{"template-*"}, Run: caseD5},
	{ID: "R1", Fixtures: []string{"echo"}, Run: caseR1},
	{ID: "R2", Fixtures: []string{"echo"}, Run: caseR2},
	{ID: "R3", Fixtures: []string{"echo"}, Run: caseR3},
	{ID: "R4", Fixtures: []string{"echo"}, Run: caseR4},
	{ID: "R5", Fixtures: []string{"echo"}, Run: caseR5},
	{ID: "R6", Fixtures: []string{"echo"}, Run: caseR6},
	{ID: "R7", Fixtures: []string{"echo"}, Run: caseR7},
	{ID: "R8", Fixtures: []string{"echo"}, Run: caseR8},
	{ID: "R9", Fixtures: []string{"echo"}, Run: caseR9},
	{ID: "R10", Fixtures: []string{"echo"}, Run: caseR10},
	{ID: "R11", Fixtures: []string{"echo"}, Run: caseR11},
	{ID: "R12", Fixtures: []string{"echo"}, Run: caseR12},
	{ID: "R13", Fixtures: []string{"echo-async"}, NotFor: []string{"go"}, Run: caseR13},
	{ID: "R14", Fixtures: []string{"echo"}, Run: caseR14},
	{ID: "C1", Fixtures: []string{"echo", "echo-async"}, Run: caseC1},
	{ID: "C2", Fixtures: []string{"echo"}, Run: caseC2},
	{ID: "C3", Fixtures: []string{"echo"}, Run: caseC3},
	{ID: "C4", Fixtures: []string{"echo"}, Run: caseC4},
	{ID: "C5", Fixtures: []string{"echo", "echo-async"}, Run: caseC5},
	{ID: "S1", Fixtures: []string{"schedule", "schedule-async"}, Run: caseS1},
	{ID: "S2", Fixtures: []string{"schedule"}, Run: caseS2},
	{ID: "S3", Fixtures: []string{"schedule"}, Run: caseS3},
	{ID: "S4", Fixtures: []string{"schedule"}, Run: caseS4},
	{ID: "S5", Fixtures: []string{"schedule"}, Run: caseS5},
	{ID: "T1", Fixtures: []string{"template-wrapped"}, Run: caseT1},
	{ID: "T2", Fixtures: []string{"template-wrapped"}, Run: caseT2},
	{ID: "T3", Fixtures: []string{"template-wrapped"}, Run: caseT3},
	{ID: "T4", Fixtures: []string{"template-models"}, Run: caseT4},
	{ID: "P2", Fixtures: []string{"echo"}, Run: caseP2},
	{ID: "P3", Fixtures: []string{"echo"}, Run: caseP3},
	{ID: "P4", Fixtures: []string{"echo", "schedule"}, Run: caseP4},
}

// Lookup returns the case with id.
func Lookup(id string) (Case, bool) {
	for _, c := range Cases {
		if c.ID == id {
			return c, true
		}
	}
	return Case{}, false
}

// fixtureNotFor lists the fixtures a language does not have (docs/protocol.md §12.2): Go has no async
// variants, and an import error or an invalid definition ends a Go program before hello.
var fixtureNotFor = map[string][]string{
	"echo-async":     {"go"},
	"schedule-async": {"go"},
	"import-error":   {"go"},
	"bad-definition": {"go"},
}

// Applies reports whether the case runs on fixture for language.
func (c Case) Applies(language, fixture string) bool {
	if slices.Contains(c.NotFor, language) || slices.Contains(fixtureNotFor[fixture], language) {
		return false
	}
	for _, f := range c.Fixtures {
		if f == fixture || (f == "template-*" && IsTemplateFixture(fixture)) {
			return true
		}
	}
	return false
}

// IsTemplateFixture reports whether fixture is one of the template-<name> fixtures (one per template).
func IsTemplateFixture(fixture string) bool {
	name, ok := strings.CutPrefix(fixture, "template-")
	if !ok {
		return false
	}
	_, known := templates.Lookup(name)
	return known
}

// ---- hello ----

func caseH1(h *H) error {
	c, err := h.spawn(spawnOptions{})
	if err != nil {
		return err
	}
	m, err := c.recv(protocol.HelloTimeout)
	if err != nil {
		return fmt.Errorf("no hello within 30 s: %w", err)
	}
	hello, ok := m.(protocol.Hello)
	if !h.check(ok, "the first message is %s, not hello", m.MessageType()) {
		return nil
	}
	h.check(hello.ID == protocol.HelloID, "hello id %q", hello.ID)
	h.check(hello.Protocol.Min <= 1 && hello.Protocol.Max >= 1, "hello protocol %d..%d does not include 1", hello.Protocol.Min, hello.Protocol.Max)
	h.check(hello.Connector.Language == h.cfg.Language, "hello language %q, want %q", hello.Connector.Language, h.cfg.Language)
	h.check(hello.PID == c.pid(), "hello pid %d, want the child pid %d", hello.PID, c.pid())
	if err := c.send(protocol.Welcome{ID: protocol.HelloID, ProtocolVersion: 1, Mode: protocol.ModeWorker, Runtime: protocol.RuntimeInfo{Version: "conformance"}, Limits: runtime.DefaultLimits(), CancelGraceMs: 5000}); err != nil {
		return err
	}
	m, err = c.recv(protocol.ReadyTimeout)
	if err != nil {
		return fmt.Errorf("no ready within 120 s: %w", err)
	}
	h.check(m.MessageType() == protocol.TypeReady, "%s instead of ready", m.MessageType())
	time.Sleep(100 * time.Millisecond)
	h.check(strings.Contains(c.stdout.String(), "importing echo"), "the import-time print is not on stdout: %q", c.stdout.String())
	h.check(strings.Contains(c.stderr.String(), "importing echo"), "the import-time print is not on stderr: %q", c.stderr.String())
	return nil
}

func caseH2(h *H) error {
	c, err := h.spawn(spawnOptions{})
	if err != nil {
		return err
	}
	if _, err := c.recv(protocol.HelloTimeout); err != nil {
		return fmt.Errorf("no hello: %w", err)
	}
	if err := c.send(protocol.Error{ID: protocol.HelloID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "connector protocol 1..1 is not supported by runtime conformance (protocol 3..4)"}}); err != nil {
		return err
	}
	code, exited := c.waitExit(5 * time.Second)
	h.check(exited, "the process did not exit within 5 s")
	h.check(!exited || code != 0, "the process exited with code 0")
	if m, err := c.recv(500 * time.Millisecond); err == nil {
		h.failf("the connector wrote %s after the hello error", m.MessageType())
	}
	return nil
}

func handshakeError(h *H, wantType, wantMessage string, stack bool) error {
	c, err := h.spawn(spawnOptions{})
	if err != nil {
		return err
	}
	if _, err := c.recv(protocol.HelloTimeout); err != nil {
		return fmt.Errorf("no hello: %w", err)
	}
	if err := c.send(protocol.Welcome{ID: protocol.HelloID, ProtocolVersion: 1, Mode: protocol.ModeWorker, Runtime: protocol.RuntimeInfo{Version: "conformance"}, Limits: runtime.DefaultLimits(), CancelGraceMs: 5000}); err != nil {
		return err
	}
	m, err := c.recv(protocol.ReadyTimeout)
	if err != nil {
		return fmt.Errorf("no handshake error: %w", err)
	}
	e, ok := m.(protocol.Error)
	if !h.check(ok && e.ID == protocol.HelloID, "%s instead of an error with id hello", m.MessageType()) {
		return nil
	}
	h.check(e.Error.Type == wantType, "error type %q, want %q", e.Error.Type, wantType)
	h.check(containsFold(e.Error.Message, wantMessage), "error message %q does not name %q", e.Error.Message, wantMessage)
	if stack {
		h.check(strings.TrimSpace(e.Error.Stack) != "", "the error has no stack")
	}
	code, exited := c.waitExit(10 * time.Second)
	h.check(exited && code == 1, "exit code %d (exited %v), want 1", code, exited)
	return nil
}

func caseH3(h *H) error { return handshakeError(h, protocol.ErrorTaskError, "boom at import", true) }

func caseH4(h *H) error { return handshakeError(h, protocol.ErrorValidation, "task", false) }

func caseH5(h *H) error {
	c, err := h.spawn(spawnOptions{noFDs: true})
	if err != nil {
		return err
	}
	code, exited := c.waitExit(30 * time.Second)
	h.check(exited && code == 2, "exit code %d (exited %v), want 2", code, exited)
	h.check(strings.Contains(c.stderr.String(), "scantor task connector"), "stderr does not explain the start: %q", tail(c.stderr.String()))
	return nil
}

// ---- describe ----

func describeSchemas(h *H) (protocol.Description, map[string]map[string]any, error) {
	c, err := h.ready()
	if err != nil {
		return protocol.Description{}, nil, err
	}
	d, err := c.describeTask()
	if err != nil {
		return d, nil, err
	}
	schemas := map[string]map[string]any{}
	for name, raw := range map[string]json.RawMessage{"taskConfig": d.Schemas.TaskConfig, "scanConfig": d.Schemas.ScanConfig, "analysisConfig": d.Schemas.AnalysisConfig, "result": d.Schemas.Result} {
		v, err := schema.ParseJSON(raw)
		if err != nil {
			return d, nil, fmt.Errorf("the %s schema is not JSON: %w", name, err)
		}
		m, _ := v.(map[string]any)
		schemas[name] = m
	}
	return d, schemas, nil
}

func props(s map[string]any) map[string]any {
	p, _ := s["properties"].(map[string]any)
	return p
}

func closedRoot(s map[string]any) bool {
	return s["type"] == "object" && s["additionalProperties"] == false
}

// hasWriteOnly reports writeOnly at the property or in a nullable union branch.
func hasWriteOnly(p any) bool {
	m, _ := p.(map[string]any)
	if m["writeOnly"] == true {
		return true
	}
	for _, k := range []string{"anyOf", "oneOf"} {
		branches, _ := m[k].([]any)
		for _, b := range branches {
			if bm, _ := b.(map[string]any); bm["writeOnly"] == true {
				return true
			}
		}
	}
	return false
}

func caseD1(h *H) error {
	d, s, err := describeSchemas(h)
	if err != nil {
		return err
	}
	task := s["taskConfig"]
	h.check(closedRoot(task), "taskConfig root is not closed: %v", task)
	greeting, _ := props(task)["greeting"].(map[string]any)
	h.check(greeting["default"] == "Hello", "greeting default %v", greeting["default"])
	required, _ := task["required"].([]any)
	h.check(!slices.Contains(required, any("greeting")), "greeting is required")
	h.check(hasWriteOnly(props(task)["apiToken"]), "apiToken is not writeOnly: %v", props(task)["apiToken"])
	analysis := s["analysisConfig"]
	h.check(closedRoot(analysis), "analysisConfig root is not closed")
	for _, f := range []string{"name", "mode", "sleepMs", "bytes"} {
		h.check(props(analysis)[f] != nil, "analysisConfig lacks %s", f)
	}
	result := s["result"]
	h.check(result["type"] == "object", "result is not an object schema")
	files, _ := props(result)["files"].(map[string]any)
	items := resolveRef(result, files["items"])
	h.check(items["x-scantor"] == "file", "result files items do not carry x-scantor: file: %v", files)
	h.check(d.Schedule.Kind == "template" && d.Schedule.Template == "single", "schedule %+v, want template single", d.Schedule)
	return nil
}

func resolveRef(root map[string]any, s any) map[string]any {
	m, _ := s.(map[string]any)
	ref, ok := m["$ref"].(string)
	if !ok {
		return m
	}
	cur := any(root)
	for _, seg := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		cm, _ := cur.(map[string]any)
		cur = cm[seg]
	}
	out, _ := cur.(map[string]any)
	return out
}

func caseD2(h *H) error {
	d, s, err := describeSchemas(h)
	if err != nil {
		return err
	}
	for _, name := range []string{"taskConfig", "scanConfig", "analysisConfig"} {
		m := s[name]
		h.check(closedRoot(m) && len(props(m)) == 0 && m["properties"] != nil, "%s is not {type: object, properties: {}, additionalProperties: false}: %v", name, m)
	}
	h.check(d.Schedule.Kind == "template" && d.Schedule.Template == "single", "schedule %+v", d.Schedule)
	return nil
}

func caseD3(h *H) error {
	d, _, err := describeSchemas(h)
	if err != nil {
		return err
	}
	h.check(d.Schedule.Kind == "custom" && d.Schedule.Template == "", "schedule %+v, want custom", d.Schedule)
	return nil
}

func caseD4(h *H) error {
	d, _, err := describeSchemas(h)
	if err != nil {
		return err
	}
	h.check(d.Schedule.Kind == "template" && d.Schedule.Template == "range", "schedule %+v, want template range", d.Schedule)
	return nil
}

func caseD5(h *H) error {
	name := strings.TrimPrefix(h.cfg.Fixture, "template-")
	d, s, err := describeSchemas(h)
	if err != nil {
		return err
	}
	h.check(d.Schedule.Kind == "template" && d.Schedule.Template == name, "schedule %+v, want template %s", d.Schedule, name)
	def, ok := templates.Lookup(name)
	if !ok {
		return fmt.Errorf("unknown template %s", name)
	}
	info := def.Info()
	canonScan, _ := schema.ParseJSON(info.ScanConfigSchema)
	canonAnalysis, _ := schema.ParseJSON(info.AnalysisConfigSchema)
	diffs := describe.CompareTemplate(name, "scanConfig", s["scanConfig"], canonScan)
	if name != templates.Single {
		diffs = append(diffs, describe.CompareTemplate(name, "analysisConfig", s["analysisConfig"], canonAnalysis)...)
	}
	h.check(len(diffs) == 0, "the exported schemas differ from the canonical ones: %s", strings.Join(diffs, "; "))
	return nil
}

// ---- run ----

func echoRun(c *conn, ac, tc map[string]any) (*runOutcome, error) {
	return c.run(runOpts{analysisConfig: ac, taskConfig: tc})
}

func checkText(h *H, o *runOutcome, want string) {
	r := o.result()
	h.check(r != nil && r["text"] == want, "text %v, want %q (%s)", r["text"], want, o.describe())
}

func caseR1(h *H) error { return withConn(h, checksR1) }

func withConn(h *H, fn func(h *H, c *conn) error) error {
	c, err := h.ready()
	if err != nil {
		return err
	}
	return fn(h, c)
}

func checksR1(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{}, map[string]any{})
	if err != nil {
		return err
	}
	checkText(h, o, "Hello, world!")
	o, err = echoRun(c, map[string]any{}, map[string]any{"greeting": "Hi"})
	if err != nil {
		return err
	}
	checkText(h, o, "Hi, world!")
	return nil
}

func caseR2(h *H) error { return withConn(h, checksR2) }

func checksR2(h *H, c *conn) error {
	o, err := echoRun(c, nil, nil)
	if err != nil {
		return err
	}
	r := o.result()
	ctx, _ := r["ctx"].(map[string]any)
	h.check(ctx["scanId"] == o.ctx.ScanID && ctx["analysisId"] == *o.ctx.AnalysisID && ctx["seq"] == float64(*o.ctx.Seq) && ctx["attempt"] == float64(o.ctx.Attempt),
		"result ctx %v does not match the request ctx", ctx)
	h.check(ctx["hasDeadline"] == true, "hasDeadline %v", ctx["hasDeadline"])
	h.check(ctx["tmpDirWritable"] == true, "tmpDirWritable %v", ctx["tmpDirWritable"])
	return nil
}

func caseR3(h *H) error { return withConn(h, checksR3) }

func checksR3(h *H, c *conn) error {
	for _, ac := range []map[string]any{{"name": 5}, {"nmae": "x"}} { //nolint:misspell // the misspelt key is the case (docs/protocol.md §12.3 R3)
		o, err := echoRun(c, ac, nil)
		if err != nil {
			return err
		}
		e := o.errorObject()
		if !h.check(e != nil && e.Type == protocol.ErrorValidation, "analysisConfig %v: %s, want a validation error", ac, o.describe()) {
			continue
		}
		var details struct {
			Issues []any `json:"issues"`
		}
		_ = json.Unmarshal(e.Details, &details)
		h.check(len(details.Issues) > 0, "analysisConfig %v: no details.issues: %s", ac, e.Details)
	}
	return nil
}

func caseR4(h *H) error { return withConn(h, checksR4) }

func checksR4(h *H, c *conn) error {
	cases := []struct {
		mode    string
		typ     string
		delayMs *int64
	}{{"fatal", protocol.ErrorFatal, nil}, {"retry", protocol.ErrorRetry, nil}, {"retryAfter", protocol.ErrorRetry, ptr(int64(1500))}, {"throw", protocol.ErrorTaskError, nil}}
	for _, tc := range cases {
		o, err := echoRun(c, map[string]any{"mode": tc.mode}, nil)
		if err != nil {
			return err
		}
		e := o.errorObject()
		if !h.check(e != nil && e.Type == tc.typ, "mode %s: %s, want %s", tc.mode, o.describe(), tc.typ) {
			continue
		}
		switch {
		case tc.delayMs != nil:
			h.check(e.DelayMs != nil && *e.DelayMs == *tc.delayMs, "mode %s: delayMs %v, want %d", tc.mode, e.DelayMs, *tc.delayMs)
		case tc.typ == protocol.ErrorRetry:
			h.check(e.DelayMs == nil, "mode %s: unexpected delayMs %d", tc.mode, deref(e.DelayMs))
		}
		if tc.mode == "throw" {
			want := entryFile(h)
			h.check(strings.Contains(e.Stack, want), "mode throw: the stack does not mention %s: %q", want, e.Stack)
		}
	}
	return nil
}

// entryFile is what a taskError stack must mention: the entry file, or main.go for the Go binary.
func entryFile(h *H) string {
	if h.cfg.Language == "go" {
		return "main.go"
	}
	return filepath.Base(h.cfg.Entry)
}

func ptr[T any](v T) *T { return &v }

func str(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func caseR5(h *H) error { return withConn(h, checksR5) }

func checksR5(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "invalidResult"}, nil)
	if err != nil {
		return err
	}
	e := o.errorObject()
	h.check(e != nil && e.Type == protocol.ErrorValidation, "invalidResult: %s, want validation", o.describe())
	return nil
}

func caseR6(h *H) error { return withConn(h, checksR6) }

func checksR6(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "oversized", "bytes": 2097152}, nil)
	if err != nil {
		return err
	}
	r, ok := o.reply.(protocol.Result)
	h.check(ok && len(r.Result) > 2<<20, "oversized: %s, want a single result line over 2 MiB", o.describe())
	return nil
}

func caseR7(h *H) error { return withConn(h, checksR7) }

func checksR7(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "stdout"}, nil)
	if err != nil {
		return err
	}
	h.check(o.result() != nil, "stdout: %s, want a result", o.describe())
	time.Sleep(200 * time.Millisecond)
	h.check(strings.Contains(c.stdout.String(), `{"type":"result","id":"r0","result":{}}`), "the protocol-like line is not on stdout")
	h.check(strings.Contains(c.stderr.String(), "noise"), "noise is not on stderr")
	return nil
}

func caseR8(h *H) error { return withConn(h, checksR8) }

func checksR8(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "log"}, nil)
	if err != nil {
		return err
	}
	var found bool
	for _, l := range o.logs {
		if l.Parent != nil && *l.Parent == o.id && l.Level == protocol.LevelInfo && l.Message == "hello" {
			var fields map[string]any
			_ = json.Unmarshal(l.Fields, &fields)
			found = len(fields) == 1 && fields["n"] == float64(1)
		}
	}
	h.check(found, "no log {parent: %s, level: info, message: hello, fields: {n: 1}} before the result: %+v", o.id, o.logs)
	h.check(o.result() != nil, "log: %s", o.describe())
	return nil
}

func caseR9(h *H) error { return withConn(h, checksR9) }

func checksR9(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "progress"}, nil)
	if err != nil {
		return err
	}
	var found bool
	for _, p := range o.progress {
		found = found || (p.Parent == o.id && p.Fraction != nil && *p.Fraction == 0.5 && p.Message != nil && *p.Message == "half")
	}
	h.check(found, "no progress {parent: %s, fraction: 0.5, message: half}: %+v", o.id, o.progress)
	return nil
}

func caseR10(h *H) error { return withConn(h, checksR10) }

func checksR10(h *H, c *conn) error {
	o, err := echoRun(c, map[string]any{"mode": "file"}, nil)
	if err != nil {
		return err
	}
	if !h.check(len(o.files) == 3, "%d file messages, want 3 (%s)", len(o.files), o.describe()) {
		return nil
	}
	names := map[string]bool{}
	wantTypes := []*string{ptr("application/octet-stream"), nil, nil}
	for i, f := range o.files {
		names[f.Name] = true
		h.check(strings.HasPrefix(f.Path, *o.ctx.FilesDir+"/"), "file %s path %s is outside ctx.filesDir", f.Name, f.Path)
		if wantTypes[i] == nil {
			h.check(f.ContentType == nil, "file %s content type %s, want null", f.Name, str(f.ContentType))
		} else {
			h.check(f.ContentType != nil && *f.ContentType == *wantTypes[i], "file %s content type %s, want %s", f.Name, str(f.ContentType), *wantTypes[i])
		}
	}
	h.check(len(names) == 3, "file names are not distinct: %v", names)
	contents := []string{}
	for _, f := range o.files {
		b, err := os.ReadFile(f.Path)
		if err != nil {
			h.failf("cannot read registered file %s: %v", f.Name, err)
			continue
		}
		contents = append(contents, string(b))
	}
	if len(contents) == 3 {
		h.check(contents[0] == "abc" && contents[1] == "hello", "file contents %q", contents)
		var parsed map[string]any
		h.check(json.Unmarshal([]byte(contents[2]), &parsed) == nil && parsed["c"] == true, "the path-based file is not a copy of the JSON file: %q", contents[2])
	}
	r := o.result()
	files, _ := r["files"].([]any)
	if h.check(len(files) == 3, "result.files has %d entries", len(files)) {
		for i, f := range files {
			b, _ := json.Marshal(f)
			want, _ := json.Marshal(o.refs[i])
			h.check(sameJSON(b, want), "result.files[%d] %s, want the replied ref %s", i, b, want)
		}
	}
	return nil
}

func sameJSON(a, b []byte) bool {
	ca, err1 := canonical.Transform(a)
	cb, err2 := canonical.Transform(b)
	return err1 == nil && err2 == nil && string(ca) == string(cb)
}

func caseR11(h *H) error { return withConn(h, checksR11) }

const harnessFileError = "the conformance harness rejects bad.bin"

func checksR11(h *H, c *conn) error {
	o, err := c.run(runOpts{analysisConfig: map[string]any{"mode": "fileError"}, onFile: func(f protocol.File, _ *runOutcome) protocol.Message {
		r := false
		return protocol.Error{ID: f.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: harnessFileError, Retryable: &r}}
	}})
	if err != nil {
		return err
	}
	h.check(len(o.files) == 1 && o.files[0].Name == "bad.bin", "file messages %+v, want one for bad.bin", o.files)
	e := o.errorObject()
	h.check(e != nil && e.Type == protocol.ErrorValidation && strings.Contains(e.Message, harnessFileError), "fileError: %s, want validation with the harness's message", o.describe())
	return nil
}

func caseR12(h *H) error { return withConn(h, checksR12) }

func checksR12(h *H, c *conn) error {
	o, err := echoRun(c, nil, map[string]any{"apiToken": "s3cret"})
	if err != nil {
		return err
	}
	r := o.result()
	h.check(r != nil && r["secretLength"] == float64(6), "secretLength %v (%s)", r["secretLength"], o.describe())
	return nil
}

func caseR13(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		for _, fn := range []func(*H, *conn) error{checksR1, checksR2, checksR3, checksR4, checksR5, checksR6, checksR7, checksR8, checksR9, checksR10, checksR11, checksR12} {
			if err := fn(h, c); err != nil {
				return err
			}
		}
		return nil
	})
}

func caseR14(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		for i := range 50 {
			o, err := echoRun(c, nil, nil)
			if err != nil {
				return fmt.Errorf("run %d: %w", i+1, err)
			}
			r := o.result()
			ctx, _ := r["ctx"].(map[string]any)
			if !h.check(r != nil && ctx["tmpDirWritable"] == true, "run %d: %s", i+1, o.describe()) {
				break
			}
		}
		return nil
	})
}

// ---- cancellation and lifecycle ----

func caseC1(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.run(runOpts{analysisConfig: map[string]any{"mode": "sleep", "sleepMs": 60000}, cancelAfter: 200 * time.Millisecond, cancelReason: protocol.CancelDrain})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(e != nil && e.Type == protocol.ErrorCancelled, "cancel{drain}: %s, want cancelled", o.describe())
		h.check(o.replied.Sub(o.sent) < 200*time.Millisecond+protocol.CancelGrace, "the cancelled reply took %s", o.replied.Sub(o.sent))
		return nil
	})
}

func caseC5(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.run(runOpts{analysisConfig: map[string]any{"mode": "sleep", "sleepMs": 60000}, deadline: 300 * time.Millisecond})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(e != nil && e.Type == protocol.ErrorCancelled, "deadline: %s, want cancelled", o.describe())
		h.check(o.replied.Sub(o.sent) < 5*time.Second, "the deadline reply took %s", o.replied.Sub(o.sent))
		return nil
	})
}

func caseC2(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		_, err := c.run(runOpts{analysisConfig: map[string]any{"mode": "sleepUncooperative", "sleepMs": 60000}, cancelAfter: 200 * time.Millisecond, cancelReason: protocol.CancelStop, timeout: 200*time.Millisecond + protocol.CancelGrace})
		if err != nil && err != errTimeout {
			return err
		}
		c.kill()
		time.Sleep(200 * time.Millisecond)
		h.check(c.groupGone(), "processes of the connector's group survived the kill")
		return nil
	})
}

func caseC3(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		if err := c.send(protocol.Shutdown{ID: c.nextID("x"), GraceMs: 5000}); err != nil {
			return err
		}
		code, exited := c.waitExit(5 * time.Second)
		h.check(exited && code == 0, "shutdown: exit code %d (exited %v), want 0 within 5 s", code, exited)
		return nil
	})
}

func caseC4(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.run(runOpts{analysisConfig: map[string]any{"mode": "exit"}, timeout: 30 * time.Second})
		h.check(err == errClosed && o.reply == nil, "mode exit: %v %s, want the process to end without a reply", err, o.describe())
		code, exited := c.waitExit(5 * time.Second)
		h.check(exited && code == 3, "exit code %d (exited %v), want 3", code, exited)
		return nil
	})
}

// ---- schedule ----

func scheduleItems(o *scheduleOutcome) []int64 {
	out := make([]int64, 0, len(o.items))
	for _, it := range o.items {
		var v struct {
			N *int64 `json:"n"`
		}
		_ = json.Unmarshal(it, &v)
		if v.N == nil {
			out = append(out, -1)
			continue
		}
		out = append(out, *v.N)
	}
	return out
}

func sequence(n int, f func(i int) int64) []int64 {
	out := make([]int64, n)
	for i := range n {
		out[i] = f(i)
	}
	return out
}

func caseS1(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 3}})
		if err != nil {
			return err
		}
		count, done := o.done()
		h.check(slices.Equal(scheduleItems(o), []int64{0, 1, 2}) && done && count == 3, "count 3: %s, items %v", o.describe(), scheduleItems(o))
		return nil
	})
}

func caseS2(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 0}})
		if err != nil {
			return err
		}
		count, done := o.done()
		h.check(done && count == 0 && len(o.items) == 0, "count 0: %s", o.describe())
		return nil
	})
}

func caseS3(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 5, "failAt": 2}})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(len(o.items) == 2 && e != nil && e.Type == protocol.ErrorTaskError, "failAt 2: %s", o.describe())
		return nil
	})
}

func caseS4(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 5, "fatalAt": 0}})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(len(o.items) == 0 && e != nil && e.Type == protocol.ErrorFatal, "fatalAt 0: %s", o.describe())
		return nil
	})
}

func caseS5(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		stall := func(_ string, n int) {
			if n == 1000 || n == 50000 {
				c.pause()
				time.Sleep(time.Second)
				c.resume()
			}
		}
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 100000}, onItem: stall, timeout: 3 * time.Minute})
		if err != nil {
			return err
		}
		count, done := o.done()
		items := scheduleItems(o)
		h.check(done && count == 100000 && len(items) == 100000, "count 100000: %s", o.describe())
		inOrder := true
		for i, n := range items {
			if n != int64(i) {
				inOrder = false
				break
			}
		}
		h.check(inOrder, "the items are not in order")

		// A cancel sent while the harness does not read fd 4 is still received and answered.
		stalled := func(id string, n int) {
			if n == 10 {
				c.pause()
				_ = c.send(protocol.Cancel{ID: id, Reason: protocol.CancelDrain})
				time.Sleep(time.Second)
				c.resume()
			}
		}
		o, err = c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 100000}, onItem: stalled, timeout: 3 * time.Minute})
		if err != nil {
			return err
		}
		e := o.errorObject()
		count, done = o.done()
		h.check((e != nil && e.Type == protocol.ErrorCancelled) || (done && count == 100000), "cancel during a stall: %s", o.describe())
		h.check(e != nil, "the cancel sent during a stall was not answered (the schedule finished all items)")
		return nil
	})
}

// ---- template streams ----

// nativeItems streams a template natively (no network: only templates that need none).
func nativeItems(t protocol.Template) ([]json.RawMessage, *protocol.ErrorObject) {
	def, ok := templates.Lookup(t.Template)
	if !ok {
		return nil, validationError("unknown template " + t.Template)
	}
	effective, issues, err := def.Effective(t.ScanConfig)
	if err != nil || len(issues) > 0 {
		return nil, validationError(fmt.Sprintf("invalid scan config: %v %v", err, issues))
	}
	env := templates.Env{TmpDir: os.TempDir()}
	res, err := def.Resolve(context.Background(), env, effective)
	if err != nil {
		return nil, &protocol.ErrorObject{Type: protocol.ErrorPlatform, Message: err.Error(), Retryable: ptr(true)}
	}
	var items []json.RawMessage
	for item, err := range def.Stream(context.Background(), env, res) {
		if err != nil {
			return nil, &protocol.ErrorObject{Type: protocol.ErrorPlatform, Message: err.Error(), Retryable: ptr(true)}
		}
		items = append(items, item)
	}
	return items, nil
}

func validationError(msg string) *protocol.ErrorObject {
	return &protocol.ErrorObject{Type: protocol.ErrorValidation, Message: msg, Retryable: ptr(false)}
}

func caseT1(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"end": 1000}, templates: &templateServer{items: nativeItems}})
		if err != nil {
			return err
		}
		if h.check(len(o.requests) == 1, "%d template requests, want 1", len(o.requests)) {
			t := o.requests[0]
			h.check(t.Template == "range" && t.Credit >= 1, "template %q credit %d", t.Template, t.Credit)
			def, _ := templates.Lookup("range")
			effective, _, _ := def.Effective(t.ScanConfig)
			h.check(sameJSON(effective, []byte(`{"start":0,"end":1000,"step":1}`)), "template scanConfig %s (effective %s)", t.ScanConfig, effective)
			h.check(o.sentItems[t.ID] == 1000, "the harness sent %d items within the allowance, want 1000 (allowance %d)", o.sentItems[t.ID], o.allowances[t.ID])
		}
		count, done := o.done()
		h.check(done && count == 1000 && slices.Equal(scheduleItems(o), sequence(1000, func(i int) int64 { return int64(2 * i) })), "end 1000: %s", o.describe())
		return nil
	})
}

func caseT2(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"end": 1000, "stopAfter": 5}, templates: &templateServer{items: nativeItems}})
		if err != nil {
			return err
		}
		count, done := o.done()
		h.check(len(o.items) == 5 && len(o.cancels) == 1 && done && count == 5, "stopAfter 5: %s, %d templateCancel", o.describe(), len(o.cancels))
		return nil
	})
}

func caseT3(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		for _, tc := range []struct {
			answer   protocol.ErrorObject
			wantType string
		}{
			{protocol.ErrorObject{Type: protocol.ErrorPlatform, Message: "download failed", Retryable: ptr(true)}, protocol.ErrorTaskError},
			{protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "bad config", Retryable: ptr(false)}, protocol.ErrorValidation},
		} {
			answer := tc.answer
			o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{}, templates: &templateServer{items: func(protocol.Template) ([]json.RawMessage, *protocol.ErrorObject) { return nil, &answer }}})
			if err != nil {
				return err
			}
			e := o.errorObject()
			h.check(e != nil && e.Type == tc.wantType && strings.Contains(e.Message, answer.Message), "template error %s: %s, want %s containing %q", answer.Type, o.describe(), tc.wantType, answer.Message)
		}
		return nil
	})
}

// templateFixture is schemas/templates/<name>.fixtures.json (the parts T4 uses).
type templateFixture struct {
	ScanConfig struct {
		Valid []struct {
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			Effective json.RawMessage `json:"effective"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
			Kind  string          `json:"kind"`
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
		} `json:"invalid"`
	} `json:"analysisConfig"`
}

func caseT4(h *H) error {
	var shared *conn
	for _, name := range templates.Names() {
		raw, err := scantor.Schemas.ReadFile("schemas/templates/" + name + ".fixtures.json")
		if err != nil {
			return err
		}
		var fx templateFixture
		if err := json.Unmarshal(raw, &fx); err != nil {
			return fmt.Errorf("%s fixtures: %w", name, err)
		}
		// Go types are static: the Go fixture image has one binary per template (/task/models-<name>).
		c := shared
		if h.cfg.Language == "go" {
			if c, err = h.readyEntry("/task/models-" + name); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		} else if c == nil {
			if c, err = h.ready(); err != nil {
				return err
			}
			shared = c
		}
		if err := checkTemplateModels(h, c, name, fx); err != nil {
			return err
		}
		if h.cfg.Language == "go" {
			c.kill()
		}
	}
	return nil
}

// checkTemplateModels runs the T4 checks of one template.
func checkTemplateModels(h *H, c *conn, name string, fx templateFixture) error {
	def, _ := templates.Lookup(name)
	// Answer like the runtime: canonical defaults and checks, then no items (only the request matters
	// here; data sources are not reachable from the container).
	runtimeLike := &templateServer{items: func(t protocol.Template) ([]json.RawMessage, *protocol.ErrorObject) {
		if _, issues, err := def.Effective(t.ScanConfig); err != nil || len(issues) > 0 {
			return nil, validationError(fmt.Sprintf("invalid scan config: %v %v", err, issues))
		}
		return nil, nil
	}}
	// Semantic violations need data or uploads to detect; the harness rejects them (§12.3 T4).
	rejecting := &templateServer{items: func(protocol.Template) ([]json.RawMessage, *protocol.ErrorObject) {
		return nil, validationError("the conformance harness rejects this scan config")
	}}
	for _, v := range fx.ScanConfig.Valid {
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"template": name, "config": v.Input}, templates: runtimeLike})
		if err != nil {
			return err
		}
		if !h.check(len(o.requests) == 1, "%s scanConfig %q: %s, want one template request", name, v.Name, o.describe()) {
			continue
		}
		effective, issues, _ := def.Effective(o.requests[0].ScanConfig)
		h.check(len(issues) == 0 && sameJSON(effective, v.Effective), "%s scanConfig %q: the request's scanConfig %s gives %s, want %s", name, v.Name, o.requests[0].ScanConfig, effective, v.Effective)
	}
	for _, v := range fx.ScanConfig.Invalid {
		server := runtimeLike
		if v.Kind == "semantic" {
			server = rejecting
		}
		o, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"template": name, "config": v.Input}, templates: server})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(e != nil && e.Type == protocol.ErrorValidation, "%s invalid scanConfig %q (%s): %s, want validation", name, v.Name, v.Kind, o.describe())
	}
	for _, v := range fx.AnalysisConfig.Valid {
		o, err := c.run(runOpts{analysisConfig: map[string]any{"template": name, "config": v.Input}})
		if err != nil {
			return err
		}
		r := o.result()
		got, _ := json.Marshal(r["config"])
		h.check(r != nil && sameJSON(got, v.Input), "%s analysisConfig %q: %s, want the input %s back", name, v.Name, o.describe(), v.Input)
	}
	for _, v := range fx.AnalysisConfig.Invalid {
		o, err := c.run(runOpts{analysisConfig: map[string]any{"template": name, "config": v.Input}})
		if err != nil {
			return err
		}
		e := o.errorObject()
		h.check(e != nil && e.Type == protocol.ErrorValidation, "%s invalid analysisConfig %q: %s, want validation", name, v.Name, o.describe())
	}
	return nil
}

// ---- protocol robustness ----

func caseP2(h *H) error {
	c, err := h.spawn(spawnOptions{})
	if err != nil {
		return err
	}
	if _, err := c.handshake(map[string]any{"xFuture": 1}); err != nil {
		return err
	}
	o, err := c.run(runOpts{analysisConfig: map[string]any{}, extra: map[string]any{"xFuture": 1}})
	if err != nil {
		return err
	}
	checkText(h, o, "Hello, world!")
	return nil
}

func caseP3(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		if err := c.sendRaw(map[string]any{"type": "frobnicate", "id": "z1"}); err != nil {
			return err
		}
		m, err := c.recv(10 * time.Second)
		if err != nil {
			return fmt.Errorf("no answer to an unknown request: %w", err)
		}
		e, ok := m.(protocol.Error)
		h.check(ok && e.ID == "z1" && e.Error.Type == protocol.ErrorValidation, "unknown request: %s, want error id z1 type validation", excerptMsg(m))
		o, err := echoRun(c, nil, nil)
		if err != nil {
			return err
		}
		checkText(h, o, "Hello, world!")
		return nil
	})
}

func excerptMsg(m protocol.Message) string {
	b, _ := protocol.Marshal(m)
	return excerpt(b)
}

// caseP4 checks reply ids (the request helpers check every reply's id; this case exercises them).
func caseP4(h *H) error {
	return withConn(h, func(h *H, c *conn) error {
		if _, err := c.describeTask(); err != nil {
			return err
		}
		if h.cfg.Fixture == "schedule" {
			_, err := c.schedule(scheduleOpts{scanConfig: map[string]any{"count": 2}})
			return err
		}
		for range 3 {
			if _, err := echoRun(c, nil, nil); err != nil {
				return err
			}
		}
		return nil
	})
}
