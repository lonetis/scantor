package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// maxSeq is the exclusive upper bound of seq (2^53).
const maxSeq = int64(1) << 53

// maxAttemptLimit is the schema maximum of `attempt` in messages.
const maxAttemptLimit = 20

// parsedDelivery is a validated analysis message (docs/runtime.md §8.1).
type parsedDelivery struct {
	msg runtime.AnalysisMessage
	// malformed is the reason the message cannot be attributed reliably; empty when it is valid.
	malformed string
	// attributable: seq and round are usable integers, so a failed result can be published for them.
	attributable bool
}

// parseAnalysis validates a delivery body for the worker's scan.
func parseAnalysis(body []byte, scanID string, maxAttempts int) parsedDelivery {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return parsedDelivery{malformed: "not a JSON object"}
	}
	var p parsedDelivery
	seq, seqOK := intField(fields, "seq")
	round, roundOK := intField(fields, "round")
	p.attributable = seqOK && roundOK && seq >= 0 && seq < maxSeq && round >= 1
	p.msg.Seq, p.msg.Round = seq, int(min(max(round, 0), math.MaxInt32))
	p.msg.ScanID = scanID
	p.msg.AnalysisID = runtime.AnalysisID(scanID, seq)
	p.msg.Attempt = 1
	if attempt, ok := intField(fields, "attempt"); ok && attempt >= 1 && attempt <= maxAttemptLimit {
		p.msg.Attempt = int(attempt)
	}
	p.msg.Config = json.RawMessage("{}")
	if cfg, ok := fields["config"]; ok && isObject(cfg) {
		p.msg.Config = cfg
	}
	if at, ok := intField(fields, "scheduledAt"); ok && at >= 0 {
		p.msg.ScheduledAt = at
	}
	reason := func() string {
		v, ok := intField(fields, "v")
		switch {
		case !ok || v != runtime.MessageVersion:
			return "v must be 1"
		case !seqOK || seq < 0 || seq >= maxSeq:
			return "seq must be an integer 0 ≤ seq < 2^53"
		case !roundOK || round < 1:
			return "round must be an integer ≥ 1"
		}
		attempt, ok := intField(fields, "attempt")
		if !ok || attempt < 1 || attempt > int64(maxAttempts) {
			return fmt.Sprintf("attempt must be an integer between 1 and %d", maxAttempts)
		}
		if cfg, ok := fields["config"]; !ok || !isObject(cfg) {
			return "config must be an object"
		}
		if _, ok := intField(fields, "scheduledAt"); !ok {
			return "scheduledAt must be an integer"
		}
		var sid, aid string
		if json.Unmarshal(fields["scanId"], &sid) != nil || sid != scanID {
			return "scanId does not match the worker's scan"
		}
		if json.Unmarshal(fields["analysisId"], &aid) != nil || aid != runtime.AnalysisID(scanID, seq) {
			return "analysisId must be <scanId>-<seq>"
		}
		return ""
	}()
	p.malformed = reason
	return p
}

func intField(fields map[string]json.RawMessage, name string) (int64, bool) {
	raw, ok := fields[name]
	if !ok {
		return 0, false
	}
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&n); err != nil {
		return 0, false
	}
	v, err := n.Int64()
	if err != nil {
		return 0, false
	}
	return v, true
}

// compactSize is the serialized size of a JSON value without insignificant whitespace.
func compactSize(raw json.RawMessage) int64 {
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		return int64(len(raw))
	}
	return int64(b.Len())
}

func isObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

// identity is the part of result and attempt messages that comes from the worker and the delivery.
type identity struct {
	ScanID, WorkerID, NodeID string
	Seq                      int64
	Round, Attempt           int
	ExecutionID              string
	Config                   json.RawMessage
	ScheduledAt              int64
}

func timings(id identity, x *Execution) runtime.Timings {
	return runtime.Timings{
		ScheduledAt: id.ScheduledAt, StartedAt: x.StartedAt.UnixMilli(), FinishedAt: x.FinishedAt.UnixMilli(),
		DurationMs: max(x.Duration.Milliseconds(), 0),
	}
}

// resultBody builds a result message within maxBytes (docs/runtime.md §8.9): when it is too large, the
// log tail is shortened (keeping its end), then the error details, then the stack; if it still does not
// fit, the outcome becomes a failed `validation` result.
func resultBody(id identity, t runtime.Timings, result json.RawMessage, e *scerr.ScantorError, files []api.FileRef, logTail string, maxBytes int64) ([]byte, *scerr.ScantorError) {
	msg := runtime.ResultMessage{
		V: runtime.MessageVersion, Kind: runtime.KindResult, AnalysisID: runtime.AnalysisID(id.ScanID, id.Seq),
		ScanID: id.ScanID, Seq: id.Seq, Round: id.Round, Attempt: id.Attempt, ExecutionID: id.ExecutionID,
		WorkerID: id.WorkerID, NodeID: id.NodeID, Config: id.Config, LogTail: logTail, Timings: t,
	}
	if e == nil {
		msg.Status, msg.Result, msg.Files = runtime.StatusSucceeded, result, files
	} else {
		msg.Status = runtime.StatusFailed
		me := e.AMQP()
		msg.Error = &me
	}
	b, err := runtime.EncodeMessage(msg)
	if err != nil {
		v := scerr.New(api.ErrorValidation, api.PhaseValidate, "result message cannot be encoded: "+err.Error())
		return nil, &v
	}
	if maxBytes <= 0 || int64(len(b)) <= maxBytes {
		return b, nil
	}
	shrink := func() []byte {
		excess := int64(len(b)) - maxBytes
		if msg.LogTail != "" {
			limit := max(len(msg.LogTail)-int(excess)-64, 0)
			msg.LogTail = logtail.Render([]byte(msg.LogTail), int64(len(msg.LogTail)), limit)
		} else if msg.Error != nil && len(msg.Error.Details) > 0 && string(msg.Error.Details) != `{"truncated":true}` {
			msg.Error.Details = json.RawMessage(`{"truncated":true}`)
		} else if msg.Error != nil && msg.Error.Stack != nil {
			msg.Error.Stack = nil
		} else {
			return nil
		}
		out, err := runtime.EncodeMessage(msg)
		if err != nil {
			return nil
		}
		return out
	}
	for int64(len(b)) > maxBytes {
		next := shrink()
		if next == nil {
			v := scerr.Newf(api.ErrorValidation, api.PhaseValidate, "result message exceeds %d bytes", maxBytes)
			return nil, &v
		}
		b = next
	}
	return b, nil
}

// attemptBody builds the attempt event of a retried failure.
func attemptBody(id identity, t runtime.Timings, e scerr.ScantorError, logTail string) ([]byte, error) {
	return runtime.EncodeMessage(runtime.AttemptMessage{
		V: runtime.MessageVersion, Kind: runtime.KindAttempt, AnalysisID: runtime.AnalysisID(id.ScanID, id.Seq),
		ScanID: id.ScanID, Seq: id.Seq, Round: id.Round, Attempt: id.Attempt, ExecutionID: id.ExecutionID,
		WorkerID: id.WorkerID, NodeID: id.NodeID, Config: id.Config, Error: e.AMQP(), LogTail: logTail, Timings: t,
	})
}

// retryBody builds the republished analysis message (attempt + 1, same seq, round, config, scheduledAt).
func retryBody(id identity) ([]byte, error) {
	return runtime.EncodeMessage(runtime.AnalysisMessage{
		V: runtime.MessageVersion, AnalysisID: runtime.AnalysisID(id.ScanID, id.Seq), ScanID: id.ScanID, Seq: id.Seq,
		Round: id.Round, Attempt: id.Attempt + 1, Config: id.Config, ScheduledAt: id.ScheduledAt,
	})
}
