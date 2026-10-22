// Package scerr is the runtime's unified error model (docs/runtime.md §9): every failure becomes one
// ScantorError with a type, retryability, phase, attempt and time. It also bounds error fields
// (§9.5), classifies connector replies (§8.6, docs/protocol.md §7.2) and implements the retry policy
// (§10): backoff, retry-or-final decisions and clamped delivery times.
package scerr

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
)

// Bounds of error fields (docs/runtime.md §9.5).
const (
	MaxMessageBytes = 4 << 10
	MaxStackBytes   = 16 << 10
	MaxDetailsBytes = 4 << 10
)

// ScantorError is the unified error (docs/data-model.md §4.6). DelayMs is the delay a connector requested
// with Retry; it is never serialised.
type ScantorError struct {
	Type      api.ErrorType
	Message   string
	Retryable bool
	Phase     api.ErrorPhase
	Attempt   int
	Stack     string
	Details   json.RawMessage
	DelayMs   *int64
	At        time.Time
}

func (e ScantorError) Error() string {
	return fmt.Sprintf("%s (%s, phase %s)", e.Message, e.Type, e.Phase)
}

// RetryableType returns the retryability a type implies (docs/runtime.md §9.2). Platform errors carry
// their own value and are not covered.
func RetryableType(t api.ErrorType) bool {
	switch t {
	case api.ErrorTaskError, api.ErrorRetry, api.ErrorTimeout, api.ErrorCrash:
		return true
	default:
		return false
	}
}

// New returns an error of type t whose retryability follows the type.
func New(t api.ErrorType, phase api.ErrorPhase, message string) ScantorError {
	return ScantorError{Type: t, Phase: phase, Message: message, Retryable: RetryableType(t)}
}

// Newf is New with a formatted message.
func Newf(t api.ErrorType, phase api.ErrorPhase, format string, args ...any) ScantorError {
	return New(t, phase, fmt.Sprintf(format, args...))
}

// WithDetails returns e with details encoded from v (nil keeps none).
func (e ScantorError) WithDetails(v any) ScantorError {
	if v == nil {
		e.Details = nil
		return e
	}
	b, err := json.Marshal(v)
	if err != nil {
		e.Details = json.RawMessage(`{"detailsError":"unencodable details"}`)
		return e
	}
	e.Details = b
	return e
}

// FromError classifies a Go error in the given phase: a ScantorError is returned as it is (its phase is
// set when empty); a *runtime.Error keeps its type, retryability and details; anything else is a
// platform error with the given retryability.
func FromError(err error, phase api.ErrorPhase, retryableDefault bool) ScantorError {
	var se ScantorError
	if errors.As(err, &se) {
		if se.Phase == "" {
			se.Phase = phase
		}
		return se
	}
	if re, ok := runtime.AsError(err); ok {
		e := ScantorError{Type: re.Type, Message: re.Message, Retryable: re.Retryable, Phase: phase}
		if len(re.Details) > 0 {
			e = e.WithDetails(re.Details)
		}
		return e
	}
	return ScantorError{Type: api.ErrorPlatform, Message: err.Error(), Retryable: retryableDefault, Phase: phase}
}

// connectorTypes are the types a connector may claim (docs/protocol.md §7.1).
var connectorTypes = map[string]api.ErrorType{
	protocol.ErrorTaskError:  api.ErrorTaskError,
	protocol.ErrorFatal:      api.ErrorFatal,
	protocol.ErrorRetry:      api.ErrorRetry,
	protocol.ErrorValidation: api.ErrorValidation,
	protocol.ErrorCancelled:  api.ErrorCancelled,
}

// Request kinds of connector replies, which select the phase.
const (
	InRun      = "run"
	InSchedule = "schedule"
)

// FromConnector maps a connector `error` reply (docs/protocol.md §7.2). The runtime never trusts
// `retryable` or `phase` from connectors: retryability follows the type, a `retry` keeps its delayMs, and
// types a connector may not claim become taskError. The phase is `run` (validation: `validate`) or
// `schedule`. A `cancelled` reply is returned as such; the caller decides whether it follows a cancel,
// a deadline or neither (ClassifyCancelled).
func FromConnector(obj protocol.ErrorObject, in string) ScantorError {
	t, ok := connectorTypes[obj.Type]
	if !ok {
		t = api.ErrorTaskError
	}
	phase := api.PhaseRun
	switch {
	case in == InSchedule:
		phase = api.PhaseSchedule
	case t == api.ErrorValidation:
		phase = api.PhaseValidate
	}
	e := ScantorError{Type: t, Message: obj.Message, Retryable: RetryableType(t), Phase: phase, Stack: obj.Stack}
	if len(obj.Details) > 0 && string(obj.Details) != "null" {
		e.Details = append(json.RawMessage(nil), obj.Details...)
	}
	if t == api.ErrorRetry && obj.DelayMs != nil {
		d := *obj.DelayMs
		e.DelayMs = &d
	}
	if e.Message == "" {
		e.Message = string(t)
	}
	return e
}

// DeadlineSlack is how early before its deadline a `cancelled` reply without a preceding cancel still
// counts as the connector's own deadline timer firing (docs/runtime.md §8.6).
const DeadlineSlack = time.Second

// ClassifyCancelled resolves a connector `cancelled` reply: after a cancel the runtime sent it stays
// `cancelled` (not retried, not an attempt); without one it is a `timeout` when it arrived at most 1 s
// before the deadline or later, otherwise a `taskError` (docs/runtime.md §8.6).
func ClassifyCancelled(e ScantorError, cancelSent bool, arrived, deadline time.Time, hasDeadline bool) ScantorError {
	if e.Type != api.ErrorCancelled || cancelSent {
		return e
	}
	if hasDeadline && !arrived.Before(deadline.Add(-DeadlineSlack)) {
		out := New(api.ErrorTimeout, e.Phase, e.Message)
		if out.Phase == api.PhaseValidate {
			out.Phase = api.PhaseRun
		}
		return out
	}
	out := e
	out.Type, out.Retryable = api.ErrorTaskError, true
	return out
}

// Truncate bounds the message (4 KiB, cut at a rune boundary with suffix "…"), the stack (stackBytes,
// keeping its first and last halves) and the details (4 KiB as compact JSON, else {"truncated": true}).
func (e ScantorError) Truncate(stackBytes int) ScantorError {
	if stackBytes <= 0 {
		stackBytes = MaxStackBytes
	}
	e.Message = TruncateMessage(e.Message, MaxMessageBytes)
	e.Stack = TruncateStack(e.Stack, stackBytes)
	e.Details = TruncateDetails(e.Details, MaxDetailsBytes)
	return e
}

// TruncateMessage cuts s to at most limit bytes at a rune boundary; a cut string ends with "…".
func TruncateMessage(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	const ellipsis = "…"
	return cutRunes(s, limit-len(ellipsis)) + ellipsis
}

// TruncateStack keeps the first and last halves of an over-long stack, joined by
// "\n…[<n> bytes truncated]…\n", so the whole value stays within limit bytes.
func TruncateStack(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	marker := func(n int) string { return fmt.Sprintf("\n…[%d bytes truncated]…\n", n) }
	room := limit - len(marker(len(s)))
	head := cutRunes(s, room/2)
	tail := tailRunes(s, room-len(head))
	return head + marker(len(s)-len(head)-len(tail)) + tail
}

// TruncateDetails returns details unchanged when its compact form fits in limit bytes and is an object;
// otherwise {"truncated": true}. Empty and null details stay empty.
func TruncateDetails(d json.RawMessage, limit int) json.RawMessage {
	if len(d) == 0 || string(d) == "null" {
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal(d, &obj); err != nil || obj == nil {
		return json.RawMessage(`{"truncated":true}`)
	}
	compact, err := json.Marshal(obj)
	if err != nil || len(compact) > limit {
		return json.RawMessage(`{"truncated":true}`)
	}
	return compact
}

// cutRunes returns the longest prefix of s with at most n bytes that ends at a rune boundary.
func cutRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// tailRunes returns the longest suffix of s with at most n bytes that starts at a rune boundary.
func tailRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && !utf8.RuneStart(s[i]) {
		i++
	}
	return s[i:]
}

// AMQP converts e to the AMQP body form (epoch ms; stack and details null when empty).
func (e ScantorError) AMQP() runtime.MessageError {
	m := runtime.MessageError{
		Type: e.Type, Message: e.Message, Retryable: e.Retryable, Phase: e.Phase, Attempt: e.Attempt,
		Details: e.Details, At: e.At.UnixMilli(),
	}
	if e.Stack != "" {
		s := e.Stack
		m.Stack = &s
	}
	return m
}

// API converts e to the REST form (ISO time), used by /api/runtime/* requests and local-mode events.
func (e ScantorError) API() api.ScantorError {
	return api.ScantorError{
		Type: e.Type, Message: e.Message, Retryable: e.Retryable, Phase: e.Phase, Attempt: e.Attempt,
		Stack: e.Stack, Details: e.Details, At: api.NewTime(e.At),
	}
}
