package scantor

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
)

// handle serves one runtime request on the main goroutine.
func (c *conn) handle(cl *call) {
	switch cl.kind {
	case "describe":
		c.describe(cl)
	case "schedule":
		c.schedule(cl)
	case "run":
		c.run(cl)
	}
}

func (c *conn) describe(cl *call) {
	kind := scheduleKind{Kind: "custom"}
	if c.task.template != "" {
		kind = scheduleKind{Kind: "template", Template: c.task.template}
	}
	cl.finish(descriptionMsg{
		Type: "description",
		ID:   cl.id,
		Schemas: descriptionSchemas{
			TaskConfig:     c.models.taskConfig.schema,
			ScanConfig:     c.models.scanConfig.schema,
			AnalysisConfig: c.models.analysisConfig.schema,
			Result:         c.models.result.schema,
		},
		Schedule: kind,
		Warnings: []string{},
	})
}

// outcome is what user code returned (or the panic it raised).
type outcome struct {
	value any
	count int64
	err   error
}

func (c *conn) run(cl *call) {
	tc, err := c.models.taskConfig.decode(cl.msg.TaskConfig, "task config")
	if err != nil {
		cl.fail(err)
		return
	}
	ac, err := c.models.analysisConfig.decode(cl.msg.AnalysisConfig, "analysis config")
	if err != nil {
		cl.fail(err)
		return
	}
	o, ok := await(cl, func() outcome {
		r, err := c.task.run(cl, ac, tc)
		return outcome{value: r, err: err}
	})
	if !ok {
		return
	}
	if o.err != nil {
		cl.fail(o.err)
		return
	}
	result, err := c.models.result.encode(o.value, "result")
	if err != nil {
		cl.fail(err)
		return
	}
	cl.finish(resultMsg{Type: "result", ID: cl.id, Result: result})
}

func (c *conn) schedule(cl *call) {
	sc, err := c.models.scanConfig.decode(cl.msg.ScanConfig, "scan config")
	if err != nil {
		cl.fail(err)
		return
	}
	tc, err := c.models.taskConfig.decode(cl.msg.TaskConfig, "task config")
	if err != nil {
		cl.fail(err)
		return
	}
	o, ok := await(cl, func() outcome {
		var count int64
		for ac, err := range c.task.schedule(cl, sc, tc) {
			if err != nil {
				return outcome{count: count, err: err}
			}
			config, err := c.models.analysisConfig.encode(ac, fmt.Sprintf("analysis config %d", count))
			if err != nil {
				return outcome{count: count, err: err}
			}
			// A blocking write here is the schedule's backpressure (docs/protocol.md §6.1).
			if err := cl.emit(configMsg{Type: "analysis", ID: cl.id, Config: config}); err != nil {
				if errors.Is(err, errLineTooLong) {
					err = validationError(fmt.Sprintf("analysis config %d exceeds the protocol line limit", count), nil)
				}
				return outcome{count: count, err: err}
			}
			count++
		}
		return outcome{count: count}
	})
	if !ok {
		return
	}
	if o.err != nil {
		cl.fail(o.err)
		return
	}
	cl.finish(doneMsg{Type: "done", ID: cl.id, Count: o.count})
}

// await runs user code on its own goroutine and waits for it or for the call's cancellation (cancel
// message, deadline, shutdown). On cancellation the call is answered with "cancelled" at once, even
// when user code ignores the context; the runtime never reuses such a process. It reports false
// when the call has been answered.
func await(cl *call, userCode func() outcome) (outcome, bool) {
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				done <- outcome{err: &panicError{value: p, stack: string(debug.Stack())}}
			}
		}()
		done <- userCode()
	}()
	select {
	case o := <-done:
		if o.err != nil && cl.Err() != nil {
			cl.failCancelled()
			return o, false
		}
		return o, true
	case <-cl.Done():
		select {
		case o := <-done:
			if o.err == nil {
				return o, true
			}
		default:
		}
		cl.failCancelled()
		return outcome{}, false
	}
}

func (cl *call) failCancelled() {
	cl.finish(errorMsg{Type: "error", ID: cl.id, Error: wireError{
		Type:    "cancelled",
		Message: truncateRunes(context.Cause(cl).Error(), maxErrorMessage),
	}})
}

// toWireError classifies an error returned or raised by user code (docs/tasks.md §5.4).
func toWireError(err error) wireError {
	var (
		panicErr *panicError
		fatalErr *fatalError
		retryErr *retryError
		scErr    *Error
	)
	msg := truncateRunes(err.Error(), maxErrorMessage)
	switch {
	case errors.As(err, &panicErr):
		return wireError{Type: "taskError", Message: msg, Stack: truncateTail(panicErr.stack, maxErrorStack)}
	case errors.As(err, &fatalErr):
		return wireError{Type: "fatal", Message: msg}
	case errors.As(err, &retryErr):
		w := wireError{Type: "retry", Message: msg}
		if retryErr.delay > 0 {
			ms := max(retryErr.delay.Milliseconds(), 1)
			w.DelayMs = &ms
		}
		return w
	case errors.As(err, &scErr) && scErr.Type == "validation":
		return wireError{Type: "validation", Message: msg, Details: issueDetails(scErr.issues)}
	}
	return wireError{Type: "taskError", Message: msg}
}

// maxDetailsBytes is the protocol limit of error details.
const maxDetailsBytes = 4096

// issueDetails builds {"issues": […]}, dropping trailing issues to stay within the details limit.
func issueDetails(issues []issue) *object {
	for n := len(issues); n > 0; n-- {
		details := newObject()
		details.set("issues", issues[:n])
		if raw, err := marshalJSON(details); err == nil && len(raw) <= maxDetailsBytes {
			return details
		}
	}
	return nil
}
