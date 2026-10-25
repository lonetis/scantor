package runner

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// Message bodies are not HTML-escaped: a result within maxResultBytes stays within the message limit even when
// it is full of <, > and & (each would grow to 6 bytes).
func TestMessageBodiesAreNotHTMLEscaped(t *testing.T) {
	result := json.RawMessage(`{"html":"` + strings.Repeat("<a>&", 300<<10) + `"}`) // 1.2 MiB
	id := identity{
		ScanID: testScan, WorkerID: testWorker, NodeID: testNode, Seq: 1, Round: 1, Attempt: 1,
		ExecutionID: "0b6f7e2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b", Config: json.RawMessage(`{"q":"<b>&"}`),
	}
	body, tooLarge := resultBody(id, runtime.Timings{}, result, nil, nil, "<tail>", 2<<20)
	if tooLarge != nil {
		t.Fatalf("a %d-byte result does not fit into a 2 MiB message: %s", len(result), tooLarge.Message)
	}
	for _, want := range []string{`"html":"<a>&<a>&`, `"config":{"q":"<b>&"}`, `"logTail":"<tail>"`} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("result message lacks %s", want)
		}
	}
	if len(body) > len(result)+1024 {
		t.Fatalf("a %d-byte result made a %d-byte message", len(result), len(body))
	}

	failed := scerr.New(api.ErrorValidation, api.PhaseValidate, "<boom>")
	body, tooLarge = resultBody(id, runtime.Timings{}, nil, &failed, nil, "", 2<<20)
	if tooLarge != nil || !bytes.Contains(body, []byte(`"message":"<boom>"`)) {
		t.Fatalf("failed result %s", body)
	}
	attempt, err := attemptBody(id, runtime.Timings{}, failed, "<tail>")
	if err != nil || !bytes.Contains(attempt, []byte(`"message":"<boom>"`)) || !bytes.Contains(attempt, []byte(`"logTail":"<tail>"`)) {
		t.Fatalf("attempt event %s (%v)", attempt, err)
	}
	retry, err := retryBody(id)
	if err != nil || !bytes.Contains(retry, []byte(`"config":{"q":"<b>&"}`)) {
		t.Fatalf("retry message %s (%v)", retry, err)
	}
}
