package runtime

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/lonetis/scantor/internal/api"
)

// AMQP message bodies (docs/queue.md §5, schemas/messages/*.schema.json). Times are epoch milliseconds.

// MessageVersion is the `v` of every message body.
const MessageVersion = 1

// Message kinds of result-exchange bodies.
const (
	KindResult  = "result"
	KindAttempt = "attempt"
)

// Result statuses.
const (
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
)

// AMQP `type` properties.
const (
	TypeAnalysis = "analysis"
	TypeResult   = "result"
	TypeAttempt  = "attempt"
)

// HeaderDeliveryTime is the quorum-queue delayed-delivery header (AMQP long, epoch ms).
const HeaderDeliveryTime = "x-opt-delivery-time"

// ContentTypeJSON is the content type of every body.
const ContentTypeJSON = "application/json"

// EncodeMessage encodes an AMQP body without HTML escaping. encoding/json's default turns every <, > and & in
// results, configs and log tails into a 6-byte escape, so a body would outgrow the compact JSON that the size
// limits measure.
func EncodeMessage(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// AnalysisMessage is the body of an analysis message on scantor.analyses. Consumers ignore unknown
// fields.
type AnalysisMessage struct {
	V           int             `json:"v"`
	AnalysisID  string          `json:"analysisId"`
	ScanID      string          `json:"scanId"`
	Seq         int64           `json:"seq"`
	Round       int             `json:"round"`
	Attempt     int             `json:"attempt"`
	Config      json.RawMessage `json:"config"`
	ScheduledAt int64           `json:"scheduledAt"`
}

// MessageError is a ScantorError in an AMQP body: `at` is epoch milliseconds, stack and details are
// null when absent. The type is never `cancelled`.
type MessageError struct {
	Type      api.ErrorType   `json:"type"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Phase     api.ErrorPhase  `json:"phase"`
	Attempt   int             `json:"attempt"`
	Stack     *string         `json:"stack"`
	Details   json.RawMessage `json:"details"`
	At        int64           `json:"at"`
}

// MarshalJSON encodes empty details as null.
func (e MessageError) MarshalJSON() ([]byte, error) {
	type plain MessageError
	p := plain(e)
	if len(p.Details) == 0 {
		p.Details = json.RawMessage("null")
	}
	return EncodeMessage(p)
}

// Timings are the timings of one attempt (epoch ms).
type Timings struct {
	ScheduledAt int64 `json:"scheduledAt"`
	StartedAt   int64 `json:"startedAt"`
	FinishedAt  int64 `json:"finishedAt"`
	DurationMs  int64 `json:"durationMs"`
}

// ResultMessage is the body of a final outcome on scantor.results (kind "result"). Result is null and
// Files empty when the status is failed; Error is null when it succeeded.
type ResultMessage struct {
	V           int             `json:"v"`
	Kind        string          `json:"kind"`
	AnalysisID  string          `json:"analysisId"`
	ScanID      string          `json:"scanId"`
	Seq         int64           `json:"seq"`
	Round       int             `json:"round"`
	Attempt     int             `json:"attempt"`
	ExecutionID string          `json:"executionId"`
	WorkerID    string          `json:"workerId"`
	NodeID      string          `json:"nodeId"`
	Config      json.RawMessage `json:"config"`
	Status      string          `json:"status"`
	Result      json.RawMessage `json:"result"`
	Error       *MessageError   `json:"error"`
	Files       []api.FileRef   `json:"files"`
	LogTail     string          `json:"logTail"`
	Timings     Timings         `json:"timings"`
}

// MarshalJSON encodes a missing result as null and nil files as [].
func (m ResultMessage) MarshalJSON() ([]byte, error) {
	type plain ResultMessage
	p := plain(m)
	if len(p.Result) == 0 {
		p.Result = json.RawMessage("null")
	}
	if p.Files == nil {
		p.Files = []api.FileRef{}
	}
	return EncodeMessage(p)
}

// AttemptMessage is the body of an attempt event on scantor.results (kind "attempt"): a retryable
// failure that is retried; Attempt is the attempt that failed.
type AttemptMessage struct {
	V           int             `json:"v"`
	Kind        string          `json:"kind"`
	AnalysisID  string          `json:"analysisId"`
	ScanID      string          `json:"scanId"`
	Seq         int64           `json:"seq"`
	Round       int             `json:"round"`
	Attempt     int             `json:"attempt"`
	ExecutionID string          `json:"executionId"`
	WorkerID    string          `json:"workerId"`
	NodeID      string          `json:"nodeId"`
	Config      json.RawMessage `json:"config"`
	Error       MessageError    `json:"error"`
	LogTail     string          `json:"logTail"`
	Timings     Timings         `json:"timings"`
}

// AnalysisID returns "<scanId>-<seq>".
func AnalysisID(scanID string, seq int64) string {
	return scanID + "-" + strconv.FormatInt(seq, 10)
}
