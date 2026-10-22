package scerr

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
)

func ptr[T any](v T) *T { return &v }

func TestFromConnector(t *testing.T) {
	cases := []struct {
		obj       protocol.ErrorObject
		in        string
		typ       api.ErrorType
		retryable bool
		phase     api.ErrorPhase
	}{
		{protocol.ErrorObject{Type: "taskError", Message: "boom", Retryable: ptr(false)}, InRun, api.ErrorTaskError, true, api.PhaseRun},
		{protocol.ErrorObject{Type: "fatal", Message: "no"}, InRun, api.ErrorFatal, false, api.PhaseRun},
		{protocol.ErrorObject{Type: "retry", Message: "later", DelayMs: ptr[int64](1500)}, InRun, api.ErrorRetry, true, api.PhaseRun},
		{protocol.ErrorObject{Type: "validation", Message: "bad"}, InRun, api.ErrorValidation, false, api.PhaseValidate},
		{protocol.ErrorObject{Type: "validation", Message: "bad"}, InSchedule, api.ErrorValidation, false, api.PhaseSchedule},
		// Connectors cannot claim runtime-owned types.
		{protocol.ErrorObject{Type: "timeout", Message: "x"}, InRun, api.ErrorTaskError, true, api.PhaseRun},
		{protocol.ErrorObject{Type: "platform", Message: "x", Retryable: ptr(true)}, InRun, api.ErrorTaskError, true, api.PhaseRun},
		{protocol.ErrorObject{Type: "crash", Message: "x"}, InSchedule, api.ErrorTaskError, true, api.PhaseSchedule},
		{protocol.ErrorObject{Type: "cancelled", Message: "cancelled: drain"}, InRun, api.ErrorCancelled, false, api.PhaseRun},
	}
	for _, c := range cases {
		e := FromConnector(c.obj, c.in)
		if e.Type != c.typ || e.Retryable != c.retryable || e.Phase != c.phase {
			t.Errorf("%+v in %s → %s/%v/%s, want %s/%v/%s", c.obj, c.in, e.Type, e.Retryable, e.Phase, c.typ, c.retryable, c.phase)
		}
	}
	if e := FromConnector(protocol.ErrorObject{Type: "retry", Message: "x", DelayMs: ptr[int64](1500)}, InRun); e.DelayMs == nil || *e.DelayMs != 1500 {
		t.Fatalf("delayMs lost: %+v", e)
	}
}

func TestClassifyCancelled(t *testing.T) {
	deadline := time.Unix(1000, 0)
	cancelled := FromConnector(protocol.ErrorObject{Type: "cancelled", Message: "c"}, InRun)
	if e := ClassifyCancelled(cancelled, true, deadline.Add(-time.Hour), deadline, true); e.Type != api.ErrorCancelled {
		t.Fatalf("after cancel: %s", e.Type)
	}
	if e := ClassifyCancelled(cancelled, false, deadline.Add(-500*time.Millisecond), deadline, true); e.Type != api.ErrorTimeout || !e.Retryable || e.Phase != api.PhaseRun {
		t.Fatalf("near the deadline: %+v", e)
	}
	if e := ClassifyCancelled(cancelled, false, deadline.Add(-2*time.Second), deadline, true); e.Type != api.ErrorTaskError || !e.Retryable {
		t.Fatalf("early: %+v", e)
	}
	if e := ClassifyCancelled(cancelled, false, deadline, deadline, false); e.Type != api.ErrorTaskError {
		t.Fatalf("without a deadline: %+v", e)
	}
}

func TestFromError(t *testing.T) {
	e := FromError(runtime.Validation("bad %s", "list"), api.PhaseSchedule, true)
	if e.Type != api.ErrorValidation || e.Retryable || e.Phase != api.PhaseSchedule || e.Message != "bad list" {
		t.Fatalf("%+v", e)
	}
	e = FromError(&runtime.Error{Type: api.ErrorPlatform, Retryable: true, Message: "503", Details: map[string]any{"status": 503}}, api.PhaseSchedule, false)
	if e.Type != api.ErrorPlatform || !e.Retryable || string(e.Details) != `{"status":503}` {
		t.Fatalf("%+v", e)
	}
	if e := FromError(errTest("x"), api.PhaseUpload, true); e.Type != api.ErrorPlatform || !e.Retryable {
		t.Fatalf("%+v", e)
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }

func TestTruncation(t *testing.T) {
	msg := strings.Repeat("é", 3000) // 6000 bytes
	got := TruncateMessage(msg, MaxMessageBytes)
	if len(got) > MaxMessageBytes || !utf8.ValidString(got) || !strings.HasSuffix(got, "…") {
		t.Fatalf("message: %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if TruncateMessage("short", MaxMessageBytes) != "short" {
		t.Fatal("short message changed")
	}

	stack := "HEAD" + strings.Repeat("ü", 20000) + "TAIL"
	got = TruncateStack(stack, MaxStackBytes)
	if len(got) > MaxStackBytes || !utf8.ValidString(got) || !strings.HasPrefix(got, "HEAD") || !strings.HasSuffix(got, "TAIL") || !strings.Contains(got, " bytes truncated]…\n") {
		t.Fatalf("stack: %d bytes", len(got))
	}

	big := json.RawMessage(`{"x":"` + strings.Repeat("a", 5000) + `"}`)
	if string(TruncateDetails(big, MaxDetailsBytes)) != `{"truncated":true}` {
		t.Fatal("details not truncated")
	}
	if string(TruncateDetails(json.RawMessage(`{ "a" : 1 }`), MaxDetailsBytes)) != `{"a":1}` {
		t.Fatal("details not compacted")
	}
	if string(TruncateDetails(json.RawMessage(`[1]`), MaxDetailsBytes)) != `{"truncated":true}` {
		t.Fatal("non-object details kept")
	}
	if TruncateDetails(json.RawMessage(`null`), MaxDetailsBytes) != nil {
		t.Fatal("null details kept")
	}
}

func TestAMQPAndAPIForms(t *testing.T) {
	at := time.UnixMilli(1761040890000)
	e := New(api.ErrorTimeout, api.PhaseRun, "run exceeded 30000 ms")
	e.Attempt, e.At = 1, at
	b, err := json.Marshal(e.AMQP())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"timeout","message":"run exceeded 30000 ms","retryable":true,"phase":"run","attempt":1,"stack":null,"details":null,"at":1761040890000}`
	if string(b) != want {
		t.Fatalf("AMQP form\n got %s\nwant %s", b, want)
	}
	b, err = json.Marshal(e.API())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"at":"2025-10-21T10:01:30.000Z"`) {
		t.Fatalf("API form %s", b)
	}
}

func TestPolicy(t *testing.T) {
	p := Policy{Backoff: api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 600000, Jitter: false}, MaxAttempts: 3}
	task := New(api.ErrorTaskError, api.PhaseRun, "x")
	for n, want := range map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 3: 20 * time.Second, 20: 10 * time.Minute} {
		if got := p.Delay(task, n); got != want {
			t.Errorf("delay after attempt %d = %v, want %v", n, got, want)
		}
	}
	if !p.Retry(task, 2) || p.Retry(task, 3) {
		t.Fatal("attempt accounting")
	}
	if p.Retry(New(api.ErrorFatal, api.PhaseRun, "x"), 1) || p.Retry(New(api.ErrorCancelled, api.PhaseRun, "x"), 1) {
		t.Fatal("non-retryable types retried")
	}

	// Jitter is uniform in [delay/2, delay].
	p.Backoff.Jitter = true
	p.Rand = func() float64 { return 0 }
	if got := p.Delay(task, 2); got != 5*time.Second {
		t.Fatalf("jitter low end %v", got)
	}
	p.Rand = func() float64 { return 0.999999 }
	if got := p.Delay(task, 2); got < 9999*time.Millisecond || got > 10*time.Second {
		t.Fatalf("jitter high end %v", got)
	}

	// Retry delays are clamped to [1 s, maxMs] without jitter.
	retry := New(api.ErrorRetry, api.PhaseRun, "x")
	for delay, want := range map[int64]time.Duration{10: time.Second, 1500: 1500 * time.Millisecond, 10_000_000: 10 * time.Minute} {
		retry.DelayMs = ptr(delay)
		if got := p.Delay(retry, 1); got != want {
			t.Errorf("retry delayMs %d → %v, want %v", delay, got, want)
		}
	}

	// Local mode caps every delay.
	p.MaxDelay = 2 * time.Second
	p.Backoff.Jitter = false
	if got := p.Delay(task, 5); got != 2*time.Second {
		t.Fatalf("local cap %v", got)
	}
}

func TestDeliveryTime(t *testing.T) {
	p := Policy{Backoff: api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 60000}}
	now := time.UnixMilli(1_000_000)
	if got := p.DeliveryTime(now, 200*time.Millisecond); got != now.Add(time.Second) {
		t.Fatalf("floor: %v", got.Sub(now))
	}
	if got := p.DeliveryTime(now, time.Hour); got != now.Add(time.Minute) {
		t.Fatalf("ceiling: %v", got.Sub(now))
	}
	if got := p.DeliveryTime(now, 7*time.Second); got != now.Add(7*time.Second) {
		t.Fatalf("plain: %v", got.Sub(now))
	}
	p.Backoff.MaxMs = 500
	if got := p.DeliveryTime(now, 7*time.Second); got != now.Add(time.Second) {
		t.Fatalf("floor beats a smaller maximum: %v", got.Sub(now))
	}
}
