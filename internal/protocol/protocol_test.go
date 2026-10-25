package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"reflect"
	"strings"
	"sync"
	"testing"

	scantor "github.com/lonetis/scantor"
)

var allTypes = []string{
	TypeHello, TypeWelcome, TypeReady, TypeDescribe, TypeDescription, TypeSchedule, TypeAnalysis, TypeDone,
	TypeRun, TypeResult, TypeError, TypeCancel, TypeShutdown, TypeFile, TypeFileRef, TypeLog, TypeProgress,
	TypeTemplate, TypeTemplateItem, TypeTemplateCredit, TypeTemplateCancel, TypeTemplateDone,
}

func directionOf(typ string) Direction {
	if Allowed(ConnectorToRuntime, typ) {
		return ConnectorToRuntime
	}
	return RuntimeToConnector
}

// Every schema example must validate, decode into its Go type and re-encode to an equal, still valid
// document (codec round trip against schemas/protocol/*.json).
func TestSchemaExamplesRoundTrip(t *testing.T) {
	v, err := DefaultValidator()
	if err != nil {
		t.Fatal(err)
	}
	for _, typ := range allTypes {
		examples, err := rawExamples(scantor.Schemas, typ)
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		if len(examples) == 0 {
			t.Errorf("%s: schema has no examples", typ)
		}
		for i, ex := range examples {
			if err := v.ValidateLine(directionOf(typ), ex); err != nil {
				t.Errorf("%s example %d invalid: %v", typ, i, err)
				continue
			}
			msg, err := Unmarshal(ex)
			if err != nil {
				t.Errorf("%s example %d: %v", typ, i, err)
				continue
			}
			if msg.MessageType() != typ {
				t.Errorf("%s example %d decoded as %s", typ, i, msg.MessageType())
			}
			out, err := Marshal(msg)
			if err != nil {
				t.Errorf("%s example %d: %v", typ, i, err)
				continue
			}
			var want, got any
			_ = json.Unmarshal(ex, &want)
			_ = json.Unmarshal(out, &got)
			if !reflect.DeepEqual(want, got) {
				t.Errorf("%s example %d round trip differs:\nwant %s\ngot  %s", typ, i, ex, out)
			}
			if err := v.ValidateLine(directionOf(typ), out); err != nil {
				t.Errorf("%s example %d re-encoded invalid: %v", typ, i, err)
			}
			if !strings.HasPrefix(string(out), `{"type":"`+typ+`"`) {
				t.Errorf("%s: type is not the first member: %s", typ, out)
			}
		}
	}
}

// Messages built in Go (as the runtime builds them) must validate.
func TestGoMessagesValidate(t *testing.T) {
	v, err := DefaultValidator()
	if err != nil {
		t.Fatal(err)
	}
	seq, round := int64(3), 1
	analysisID, execID, filesDir := "s-3", "b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e", "/tmp/scantor/x/files"
	deadline := int64(1761041136000)
	parent := "r1"
	half, msg := 0.5, "half"
	retry := true
	cases := []struct {
		d   Direction
		msg Message
	}{
		{RuntimeToConnector, Welcome{ID: HelloID, ProtocolVersion: 1, Mode: ModeWorker, Runtime: RuntimeInfo{Version: "dev"}, Limits: Limits{MaxLineBytes: MaxLineBytes, MaxResultBytes: 1, MaxAnalysisConfigBytes: 1, MaxFileBytes: 1}, CancelGraceMs: 5000}},
		{RuntimeToConnector, Schedule{ID: "s1", Ctx: Ctx{ScanID: "local", Attempt: 1, TmpDir: "/tmp/scantor/x/tmp"}, ScanConfig: json.RawMessage(`{}`), TaskConfig: json.RawMessage(`{}`)}},
		{RuntimeToConnector, Run{ID: "r1", Ctx: Ctx{ScanID: "s", AnalysisID: &analysisID, Seq: &seq, Round: &round, Attempt: 1, ExecutionID: &execID, DeadlineMs: &deadline, TmpDir: "/tmp/x", FilesDir: &filesDir}, AnalysisConfig: json.RawMessage(`{}`), TaskConfig: json.RawMessage(`{}`)}},
		{RuntimeToConnector, Error{ID: "c1", Error: ErrorObject{Type: ErrorPlatform, Message: "download failed", Retryable: &retry}}},
		{RuntimeToConnector, Cancel{ID: "r1", Reason: CancelDrain}},
		{RuntimeToConnector, Shutdown{ID: "x1", GraceMs: 5000}},
		{RuntimeToConnector, FileRef{ID: "c3", FileRef: FileRefObject{ID: "e0c4", Name: "a.bin", Size: 3, SHA256: strings.Repeat("a", 64), ContentType: "application/octet-stream"}}},
		{RuntimeToConnector, TemplateItem{ID: "c1", Config: json.RawMessage(`{"n":1}`)}},
		{RuntimeToConnector, TemplateDone{ID: "c1", Count: 0}},
		{RuntimeToConnector, Describe{ID: "d1"}},
		{ConnectorToRuntime, Description{ID: "d1", Schemas: Schemas{TaskConfig: json.RawMessage(`{"type":"object"}`), ScanConfig: json.RawMessage(`{"type":"object"}`), AnalysisConfig: json.RawMessage(`{"type":"object"}`), Result: json.RawMessage(`{"type":"object"}`)}, Schedule: ScheduleInfo{Kind: "custom"}}},
		{ConnectorToRuntime, Log{Parent: nil, Level: LevelInfo, Message: "importing"}},
		{ConnectorToRuntime, Log{Parent: &parent, Level: LevelInfo, Message: "x", Fields: json.RawMessage(`{"n":1}`)}},
		{ConnectorToRuntime, Progress{Parent: "r1", Fraction: &half, Message: &msg}},
		{ConnectorToRuntime, Progress{Parent: "r1"}},
		{ConnectorToRuntime, File{ID: "c3", Parent: "r1", Name: "b.txt", Path: "/tmp/scantor/x/files/b.txt"}},
		{ConnectorToRuntime, Ready{ID: HelloID}},
		{ConnectorToRuntime, TemplateCancel{ID: "c1"}},
	}
	for _, tc := range cases {
		if err := v.ValidateMessage(tc.d, tc.msg); err != nil {
			t.Errorf("%T: %v", tc.msg, err)
		}
	}
}

func TestValidatorRejects(t *testing.T) {
	v, err := DefaultValidator()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		d    Direction
		line string
	}{
		{ConnectorToRuntime, `{"type":"result","id":"r1"}`},                        // missing result
		{ConnectorToRuntime, `{"type":"result","id":"r1","result":{},"extra":1}`},  // closed schema
		{ConnectorToRuntime, `{"type":"run","id":"r1"}`},                           // wrong direction
		{ConnectorToRuntime, `{"type":"frobnicate","id":"z1"}`},                    // unknown type
		{ConnectorToRuntime, `{"type":"done","id":"bad id!","count":1}`},           // id pattern
		{ConnectorToRuntime, `{"type":"templateCredit","id":"c1","credit":70000}`}, // credit bound
		{RuntimeToConnector, `{"type":"cancel","id":"r1","reason":"later"}`},       // reason enum
		{ConnectorToRuntime, `not json`},                                           // syntax
	} {
		if err := v.ValidateLine(tc.d, []byte(tc.line)); err == nil {
			t.Errorf("accepted %s", tc.line)
		}
	}
	var unknown *UnknownTypeError
	if err := v.ValidateLine(ConnectorToRuntime, []byte(`{"type":"frobnicate","id":"z1"}`)); !errors.As(err, &unknown) {
		t.Errorf("unknown type error = %v", err)
	}
}

// Connectors truncate error messages and stacks themselves; longer ones fail the schema (a protocol violation).
// Details have no schema bound: the runtime replaces oversized details (docs/protocol.md §7.1, §9).
func TestErrorFieldBounds(t *testing.T) {
	v, err := DefaultValidator()
	if err != nil {
		t.Fatal(err)
	}
	line := func(field string, value any) []byte {
		e := map[string]any{"type": "taskError", "message": "boom"}
		e[field] = value
		b, err := json.Marshal(map[string]any{"type": "error", "id": "r1", "error": e})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, tc := range []struct {
		field string
		value any
		ok    bool
	}{
		{"message", strings.Repeat("é", 4096), true},
		{"message", strings.Repeat("x", 4097), false},
		{"stack", strings.Repeat("x", 16384), true},
		{"stack", strings.Repeat("x", 16385), false},
		{"details", map[string]any{"blob": strings.Repeat("x", 8192)}, true},
	} {
		err := v.ValidateLine(ConnectorToRuntime, line(tc.field, tc.value))
		if (err == nil) != tc.ok {
			t.Errorf("%s of %d: err = %v", tc.field, len(fmt.Sprint(tc.value)), err)
		}
	}
}

func TestDecoderFraming(t *testing.T) {
	input := `{"type":"ready","id":"hello"}` + "\n" +
		`{"type":"frobnicate","id":"z1"}` + "\n" +
		`not json` + "\n" +
		`{"type":"log","parent":null,"level":"info","message":"m","xFuture":1}` + "\n" +
		`{"type":"done","id":"s1","count":2}`
	d := NewDecoder(strings.NewReader(input))
	msg, _, err := d.Decode()
	if _, ok := msg.(Ready); err != nil || !ok {
		t.Fatalf("ready: %v %v", msg, err)
	}
	var unknown *UnknownTypeError
	if _, _, err := d.Decode(); !errors.As(err, &unknown) || unknown.Type != "frobnicate" {
		t.Fatalf("unknown: %v", err)
	}
	var syntax *SyntaxError
	if _, _, err := d.Decode(); !errors.As(err, &syntax) {
		t.Fatalf("syntax: %v", err)
	}
	msg, _, err = d.Decode()
	if l, ok := msg.(Log); err != nil || !ok || l.Parent != nil {
		t.Fatalf("log with unknown field: %v %v", msg, err)
	}
	if _, _, err := d.Decode(); !errors.Is(err, ErrUnterminatedLine) {
		t.Fatalf("unterminated: %v", err)
	}
	if _, _, err := d.Decode(); !errors.Is(err, io.EOF) {
		t.Fatalf("eof: %v", err)
	}
}

func TestDecoderLineLimit(t *testing.T) {
	long := `{"type":"result","id":"r1","result":{"text":"` + strings.Repeat("x", 300) + `"}}` + "\n"
	input := long + `{"type":"ready","id":"hello"}` + "\n"
	d := NewDecoder(strings.NewReader(input))
	d.maxLineBytes = 100
	if _, err := d.ReadLine(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("long line: %v", err)
	}
	msg, _, err := d.Decode()
	if _, ok := msg.(Ready); err != nil || !ok {
		t.Fatalf("decoder not usable after a long line: %v %v", msg, err)
	}

	// A line longer than the bufio buffer but within the limit is returned whole.
	big := `{"type":"result","id":"r1","result":{"text":"` + strings.Repeat("y", 200<<10) + `"}}` + "\n"
	d = NewDecoder(strings.NewReader(big))
	line, err := d.ReadLine()
	if err != nil || len(line) != len(big) {
		t.Fatalf("big line: %d %v", len(line), err)
	}
}

func TestEncoderConcurrentLines(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	enc := NewEncoder(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return buf.Write(p)
	}))
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = enc.Encode(Log{Level: LevelInfo, Message: strings.Repeat("z", 1000)})
		}()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 50 {
		t.Fatalf("lines = %d", len(lines))
	}
	for _, l := range lines {
		if err := CheckFraming([]byte(l+"\n"), MaxLineBytes); err != nil {
			t.Fatal(err)
		}
		if _, err := Unmarshal([]byte(l)); err != nil {
			t.Fatal(err)
		}
	}
	small := &Encoder{w: io.Discard, maxLineBytes: 10}
	if err := small.Encode(Ready{ID: HelloID}); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("encoder line limit: %v", err)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestCheckFraming(t *testing.T) {
	good := []byte(`{"type":"ready","id":"hello"}` + "\n")
	if err := CheckFraming(good, MaxLineBytes); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{
		[]byte(`{"type":"ready","id":"hello"}`),
		[]byte(`{"type":"ready","id":"hello"}` + "\r\n"),
		[]byte("{\"a\":\n1}\n"),
		{0xff, '\n'},
		[]byte("\n"),
	} {
		if err := CheckFraming(bad, MaxLineBytes); err == nil {
			t.Errorf("CheckFraming accepted %q", bad)
		}
	}
}

func TestNegotiate(t *testing.T) {
	if v, ok := Negotiate(ProtocolRange{Min: 1, Max: 1}); !ok || v != 1 {
		t.Fatalf("1..1 = %d %v", v, ok)
	}
	if v, ok := Negotiate(ProtocolRange{Min: 1, Max: 5}); !ok || v != Version {
		t.Fatalf("1..5 = %d %v", v, ok)
	}
	if _, ok := Negotiate(ProtocolRange{Min: 2, Max: 3}); ok {
		t.Fatal("future-only connector accepted")
	}
	if SupportedVersions() != "1" {
		t.Fatalf("SupportedVersions = %s", SupportedVersions())
	}
	for id, want := range map[string]bool{"r7": true, "call:0": true, "hello": true, "": false, "a b": false, strings.Repeat("x", 65): false} {
		if ValidID(id) != want {
			t.Errorf("ValidID(%q) != %v", id, want)
		}
	}
}

// rawExamples returns the `examples` of a type's schema.
func rawExamples(fsys fs.FS, typ string) ([]json.RawMessage, error) {
	data, err := fs.ReadFile(fsys, path.Join(SchemaDir, typ+".schema.json"))
	if err != nil {
		return nil, err
	}
	var s struct {
		Examples []json.RawMessage `json:"examples"`
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return s.Examples, nil
}
