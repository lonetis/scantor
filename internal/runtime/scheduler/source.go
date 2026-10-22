// Package scheduler is the schedule path of the runtime (docs/runtime.md §11): item sources (a native
// template from internal/templates, or a connector `schedule` stream that may call wrapped templates),
// template resolution with provenance, resume verification with tailHash, the publish window with
// confirms, backpressure and the contiguous confirmed prefix, checkpoints, epoch fencing, restarts,
// `done`, drain and stop.
//
// Sources, the template server and resolutions are shared with local mode (internal/runtime/local),
// which schedules the same way without AMQP.
package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/templates"
)

// Source yields the analysis configs of one schedule run in order.
type Source interface {
	// Next returns the next item, or ok=false at the end of the stream. Failures are scerr.ScantorError
	// values in phase schedule; a cancelled ctx returns ctx.Err().
	Next(ctx context.Context) (item json.RawMessage, ok bool, err error)
	// Close ends the stream early and releases its resources.
	Close()
}

// native streams an unwrapped template (no connector process).
type native struct {
	next   func() (json.RawMessage, error, bool)
	stop   func()
	cancel context.CancelFunc
}

// NewNative returns the source of a resolved native template.
func NewNative(ctx context.Context, def *templates.Definition, res templates.Resolution, env templates.Env) Source {
	ctx, cancel := context.WithCancel(ctx)
	next, stop := iter.Pull2(def.Stream(ctx, env, res))
	return &native{next: next, stop: stop, cancel: cancel}
}

func (n *native) Next(ctx context.Context) (json.RawMessage, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	item, err, ok := n.next()
	switch {
	case !ok:
		return nil, false, nil
	case err != nil:
		if cerr := ctx.Err(); cerr != nil && errors.Is(err, cerr) {
			return nil, false, cerr
		}
		return nil, false, scerr.FromError(err, api.PhaseSchedule, true)
	}
	return item, true, nil
}

func (n *native) Close() {
	n.cancel()
	n.stop()
}

// ConnectorSource is a connector `schedule` request (docs/protocol.md §5.4): it reads `analysis` items
// only when Next is called, so a scheduler that cannot publish blocks the connector through pipe
// backpressure, and it serves the wrapped template calls of the request.
type ConnectorSource struct {
	call      *pool.Call
	templates *TemplateServer
	timeout   time.Duration
	count     int64
	ended     bool
	cancelled bool
	log       func(msg string, args ...any)
}

// StartConnector sends a schedule request to p. timeout is the item timeout (settings.timeoutMs; 0
// disables it, debug mode). Wrapped template calls are resolved with res.
func StartConnector(p *pool.Process, ctx protocol.Ctx, scanConfig, taskConfig json.RawMessage, timeout time.Duration, server *TemplateServer) (*ConnectorSource, error) {
	call, err := p.Schedule(ctx, scanConfig, taskConfig)
	if err != nil {
		return nil, err
	}
	server.attach(call)
	return &ConnectorSource{call: call, templates: server, timeout: timeout}, nil
}

// Call returns the schedule request.
func (c *ConnectorSource) Call() *pool.Call { return c.call }

// Cancel sends `cancel` for the schedule (drain or stop); a later `cancelled` reply is not an error.
func (c *ConnectorSource) Cancel(reason string) error {
	c.cancelled = true
	return c.call.Cancel(reason)
}

// Next implements Source.
func (c *ConnectorSource) Next(ctx context.Context) (json.RawMessage, bool, error) {
	if c.ended {
		return nil, false, nil
	}
	var timer *time.Timer
	var timeoutC <-chan time.Time
	reset := func() {
		if c.timeout <= 0 {
			return
		}
		if timer == nil {
			timer = time.NewTimer(c.timeout)
			timeoutC = timer.C
			return
		}
		timer.Reset(c.timeout)
	}
	reset()
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		select {
		case ev := <-c.call.Events():
			switch {
			case ev.Violation != nil:
				c.end()
				return nil, false, scerr.New(api.ErrorCrash, api.PhaseSchedule, "connector protocol violation: "+ev.Violation.Error()).
					WithDetails(map[string]any{"protocolError": ev.Violation.Error()})
			case ev.Exit != nil:
				c.end()
				return nil, false, crashError(*ev.Exit)
			}
			switch m := ev.Msg.(type) {
			case protocol.Analysis:
				c.count++
				return m.Config, true, nil
			case protocol.Done:
				c.end()
				if m.Count != c.count {
					msg := fmt.Sprintf("done.count is %d, but the connector sent %d analysis messages", m.Count, c.count)
					c.call.Process().Kill()
					return nil, false, scerr.New(api.ErrorCrash, api.PhaseSchedule, "connector protocol violation: "+msg).
						WithDetails(map[string]any{"protocolError": msg})
				}
				return nil, false, nil
			case protocol.Error:
				c.end()
				e := scerr.FromConnector(m.Error, scerr.InSchedule)
				if e.Type == api.ErrorCancelled && !c.cancelled {
					e.Type, e.Retryable = api.ErrorTaskError, true // no deadline in schedule (docs/protocol.md §7.2)
				}
				return nil, false, e
			case protocol.Template:
				c.templates.Start(m)
				reset()
			case protocol.TemplateCredit:
				c.templates.Credit(m.ID, m.Credit)
				reset()
			case protocol.TemplateCancel:
				c.templates.Cancel(m.ID)
			case protocol.File:
				f := false
				if err := c.call.Send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "files are only available in run", Retryable: &f}}); err != nil && c.log != nil {
					c.log("cannot answer a file request", "err", err)
				}
			}
		case <-timeoutC:
			c.end()
			c.call.Process().Kill()
			return nil, false, scerr.Newf(api.ErrorTimeout, api.PhaseSchedule, "schedule() produced no item within %d ms", c.timeout.Milliseconds())
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}
}

func (c *ConnectorSource) end() {
	if !c.ended {
		c.ended = true
		c.templates.Close()
	}
}

// Close implements Source: open template streams end and the request is finished. The caller recycles
// the process when the request did not end on its own.
func (c *ConnectorSource) Close() {
	c.end()
	c.call.End()
}

// Ended reports whether the request ended with done or an error.
func (c *ConnectorSource) Ended() bool { return c.ended }

// Drain discards the connector's remaining output for the request until it replies, the process ends or
// timeout passes; it reports whether the request ended.
func (c *ConnectorSource) Drain(timeout time.Duration) bool {
	if c.ended {
		return true
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	for {
		select {
		case ev := <-c.call.Events():
			if ev.Violation != nil || ev.Exit != nil {
				c.end()
				return true
			}
			switch m := ev.Msg.(type) {
			case protocol.Done, protocol.Error:
				c.end()
				return true
			case protocol.Template:
				c.templates.Refuse(m.ID)
			}
		case <-t.C:
			return false
		}
	}
}

// crashError classifies the end of the connector process during a schedule.
func crashError(st pool.ExitStatus) scerr.ScantorError {
	var exitCode, signal any
	if st.Signal == "" {
		exitCode = st.Code
	} else {
		signal = st.Signal
	}
	return scerr.New(api.ErrorCrash, api.PhaseSchedule, "connector process ended during the schedule ("+st.String()+")").
		WithDetails(map[string]any{"exitCode": exitCode, "signal": signal, "oomKilled": false})
}

// Limits are the per-item checks of the scheduler (docs/runtime.md §11.6).
type Limits struct {
	MaxAnalysesPerScan     int64
	MaxAnalysisConfigBytes int64
}

// CheckItem validates item seq; the returned config is compact JSON.
func (l Limits) CheckItem(seq int64, item json.RawMessage) (json.RawMessage, error) {
	if l.MaxAnalysesPerScan > 0 && seq >= l.MaxAnalysesPerScan {
		return nil, scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "schedule() produced more than %d analyses (SCANTOR_MAX_ANALYSES_PER_SCAN)", l.MaxAnalysesPerScan)
	}
	trimmed := bytes.TrimSpace(item)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "analysis config %d is not an object", seq)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, trimmed); err != nil {
		return nil, scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "analysis config %d is not valid JSON: %v", seq, err)
	}
	if l.MaxAnalysisConfigBytes > 0 && int64(compact.Len()) > l.MaxAnalysisConfigBytes {
		return nil, scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "analysis config %d is %d bytes; the maximum is %d", seq, compact.Len(), l.MaxAnalysisConfigBytes)
	}
	return compact.Bytes(), nil
}
