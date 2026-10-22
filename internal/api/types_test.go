package api

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Every JSON example of docs/api.md must decode into its wire type and re-encode to the same document,
// so no field name drifts from the spec.
func TestDocExamplesRoundTrip(t *testing.T) {
	data, err := os.ReadFile("testdata/examples.json")
	if err != nil {
		t.Fatal(err)
	}
	var examples map[string]json.RawMessage
	if err := json.Unmarshal(data, &examples); err != nil {
		t.Fatal(err)
	}
	types := map[string]func() any{
		"Task":                        func() any { return &Task{} },
		"Revision":                    func() any { return &Revision{} },
		"TestRun":                     func() any { return &TestRun{} },
		"Scan":                        func() any { return &Scan{} },
		"RegistryTokenClaims":         func() any { return &RegistryTokenClaims{} },
		"RegistryTokenResponseGET":    func() any { return &RegistryTokenResponse{} },
		"RegistryTokenResponsePOST":   func() any { return &RegistryTokenResponse{} },
		"NodeHelloRequest":            func() any { return &NodeHelloRequest{} },
		"NodeHelloResponse":           func() any { return &NodeHelloResponse{} },
		"NodeAssignments":             func() any { return &NodeAssignments{} },
		"NodeStatusRequest":           func() any { return &NodeStatusRequest{} },
		"NodeStatusResponse":          func() any { return &NodeStatusResponse{} },
		"WorkerLogsUpload":            func() any { return &WorkerLogsUpload{} },
		"Bootstrap":                   func() any { return &Bootstrap{} },
		"RuntimeStateRequest":         func() any { return &RuntimeStateRequest{} },
		"RuntimeStateResponse":        func() any { return &RuntimeStateResponse{} },
		"PresignRequest":              func() any { return &PresignRequest{} },
		"PresignResponse":             func() any { return &PresignResponse{} },
		"AnalysesStatusRequest":       func() any { return &AnalysesStatusRequest{} },
		"AnalysesStatusResponse":      func() any { return &AnalysesStatusResponse{} },
		"SchedulerResolvedRequest":    func() any { return &SchedulerResolvedRequest{} },
		"SchedulerResolvedResponse":   func() any { return &SchedulerResolvedResponse{} },
		"SchedulerCheckpointRequest":  func() any { return &SchedulerCheckpointRequest{} },
		"SchedulerCheckpointResponse": func() any { return &SchedulerCheckpointResponse{} },
		"SchedulerDoneRequest":        func() any { return &SchedulerDoneRequest{} },
		"SchedulerDoneRequestFailed":  func() any { return &SchedulerDoneRequest{} },
		"SchedulerDoneResponse":       func() any { return &SchedulerDoneResponse{} },
		"RuntimeErrorReport":          func() any { return &RuntimeErrorReport{} },
		"RuntimeErrorResponse":        func() any { return &RuntimeErrorResponse{} },
	}
	for name, raw := range examples {
		if strings.HasPrefix(name, "$") {
			continue
		}
		newValue, ok := types[name]
		if !ok {
			t.Errorf("example %s has no wire type in the test table", name)
			continue
		}
		t.Run(name, func(t *testing.T) {
			v := newValue()
			dec := json.NewDecoder(strings.NewReader(string(raw)))
			dec.DisallowUnknownFields()
			if err := dec.Decode(v); err != nil {
				t.Fatalf("decode: %v", err)
			}
			encoded, err := json.Marshal(v)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var want, got any
			_ = json.Unmarshal(raw, &want)
			_ = json.Unmarshal(encoded, &got)
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("round trip differs\nwant %s\ngot  %s", raw, encoded)
			}
		})
	}
}

func TestTimeFormat(t *testing.T) {
	ts := NewTime(time.Date(2026, 10, 21, 9, 1, 0, 0, time.FixedZone("CEST", 2*3600)))
	b, err := json.Marshal(ts)
	if err != nil || string(b) != `"2026-10-21T07:01:00.000Z"` {
		t.Fatalf("Marshal = %s, %v", b, err)
	}
	var back Time
	if err := json.Unmarshal([]byte(`"2026-10-21T07:01:00.123456Z"`), &back); err != nil || back.Nanosecond() != 123456000 {
		t.Fatalf("Unmarshal: %v %v", back, err)
	}
	var null struct {
		At *Time `json:"at"`
	}
	if err := json.Unmarshal([]byte(`{"at": null}`), &null); err != nil || null.At != nil {
		t.Fatalf("null: %v %v", null.At, err)
	}
	if err := json.Unmarshal([]byte(`"yesterday"`), &back); err == nil {
		t.Fatal("invalid timestamp accepted")
	}
}

func TestClockOffset(t *testing.T) {
	sent := time.UnixMilli(1_000_000)
	received := sent.Add(100 * time.Millisecond)
	// server clock 1050 ms at the midpoint = local 1050 → offset 0
	if got := ClockOffset(1_000_050, sent, received); got != -50*time.Millisecond+50*time.Millisecond {
		t.Fatalf("ClockOffset = %v", got)
	}
	if got := ClockOffset(1_002_050, sent, received); got != 2*time.Second {
		t.Fatalf("ClockOffset = %v", got)
	}
}

func TestMarshalHelpers(t *testing.T) {
	b, err := json.Marshal(RuntimeStateRequest{})
	if err != nil || !strings.Contains(string(b), `"busy":[]`) || !strings.Contains(string(b), `"scheduler":null`) {
		t.Fatalf("RuntimeStateRequest = %s, %v", b, err)
	}
	n := 3
	b, _ = json.Marshal(UpdateNode{MaxWorkers: &n})
	if !strings.Contains(string(b), `"maxWorkers":3`) {
		t.Fatalf("UpdateNode = %s", b)
	}
	b, _ = json.Marshal(UpdateNode{ClearMaxWorkers: true})
	if !strings.Contains(string(b), `"maxWorkers":null`) {
		t.Fatalf("UpdateNode clear = %s", b)
	}
	b, _ = json.Marshal(UpdateNode{})
	if string(b) != `{}` {
		t.Fatalf("UpdateNode empty = %s", b)
	}
	b, _ = json.Marshal(UpdateNode{Labels: map[string]string{"region": "eu"}})
	if string(b) != `{"labels":{"region":"eu"}}` {
		t.Fatalf("UpdateNode labels = %s", b)
	}
	b, _ = json.Marshal(UpdateNode{Labels: map[string]string{}})
	if string(b) != `{}` {
		t.Fatalf("UpdateNode empty labels = %s", b)
	}
	b, _ = json.Marshal(UpdateNode{ClearLabels: true, Labels: map[string]string{"region": "eu"}})
	if string(b) != `{"labels":{}}` {
		t.Fatalf("UpdateNode clear labels = %s", b)
	}
}
