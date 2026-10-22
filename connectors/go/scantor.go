// Package scantor is the Go connector of scantor: it defines a task with strict types and runs it as a
// connector process that speaks the connector protocol with the scantor runtime.
//
// A task binary calls [Serve] (or [ServeRun]) from main:
//
//	func run(ctx scantor.Context, ac cidr.AnalysisConfig, tc TaskConfig) (Result, error) { … }
//
//	func main() { scantor.Serve(cidr.Schedule, run) }
//
// Config and result types are plain structs. Their JSON Schemas are reflected with
// github.com/invopop/jsonschema, so constraints and defaults are struct tags
// (`jsonschema:"default=Hello,minLength=1"`). See docs/guide/authoring-go.md.
package scantor

import (
	"context"
	"fmt"
	"time"
)

// Empty is a closed config type without fields: JSON Schema
// {"type":"object","properties":{},"additionalProperties":false}, value {}.
type Empty struct{}

// Secret is a string config field whose JSON Schema carries "writeOnly": true. The platform encrypts
// secret values at rest and masks them in every API response; user code receives the real value.
type Secret string

// FileRef references a file registered with [Files]. Its JSON Schema carries "x-scantor": "file", so
// results that contain FileRefs (directly, nested or in arrays) show download links.
type FileRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// Level is the severity of a [Context.Log] line.
type Level string

// Log levels.
const (
	LevelDebug   Level = "debug"
	LevelInfo    Level = "info"
	LevelWarning Level = "warning"
	LevelError   Level = "error"
)

// Files registers output files of a run. Put and PutFile copy the content into the execution's files
// directory and return the final [FileRef] at once; the runtime uploads the files only after run
// succeeded, so files of failed attempts are discarded. Names are 1–255 characters without "/", "\"
// and NUL and unique within the attempt. An empty contentType means application/octet-stream; pass
// it explicitly (for example "image/png") for files that should be shown inline. Violations of the
// name rules or the platform limits return an [*Error] of type "validation".
type Files interface {
	Put(name string, data []byte, contentType string) (FileRef, error)
	PutFile(name, path, contentType string) (FileRef, error)
}

// Context is passed to every schedule and run call. Its context.Context part carries the call's
// deadline and is cancelled at the deadline and when the worker drains or stops; pass it to every
// blocking operation.
type Context interface {
	context.Context

	// ScanID is the scan id (in local mode: the test-run id, or "local" for scantor dev run).
	ScanID() string
	// AnalysisID is "<scanId>-<seq>"; "" in schedule.
	AnalysisID() string
	// Seq is the 0-based position of the analysis in the schedule stream; -1 in schedule.
	Seq() int64
	// Attempt is the 1-based attempt of the analysis (in schedule: the scheduler start count).
	Attempt() int
	// TmpDir is an empty scratch directory private to this call, deleted afterwards.
	TmpDir() string
	// Log writes a structured log line; kv are alternating keys and values.
	Log(level Level, msg string, kv ...any)
	// Progress reports the progress of a run (fraction 0…1, < 0 = unknown); ignored in schedule.
	Progress(fraction float64, message string)
	// Files registers output files; only available in run.
	Files() Files
}

// Error is a platform error raised by [Files] and template streams. Type is a ScantorError type such
// as "validation" or "platform". Returned uncaught from run or schedule, an error of type
// "validation" fails the analysis (or scheduling) without retry; every other type is reported as
// "taskError".
type Error struct {
	Type      string
	Message   string
	Retryable bool

	issues []issue
}

func (e *Error) Error() string { return e.Message }

// Fatal returns an error that fails the analysis (or scheduling) at once, without retries.
func Fatal(msg string) error { return &fatalError{err: plainError(msg)} }

// Fatalf is [Fatal] with fmt.Errorf formatting; %w keeps the wrapped error reachable for errors.Is
// and errors.As.
func Fatalf(format string, args ...any) error {
	return &fatalError{err: fmt.Errorf(format, args...)}
}

// Retry returns an error that ends the attempt and asks for another one after delay (0 = the scan's
// backoff). The runtime clamps the delay to [1 s, backoff.max]; the attempt counts toward
// maxAttempts.
func Retry(msg string, delay time.Duration) error {
	return &retryError{msg: msg, delay: delay}
}

type plainError string

func (e plainError) Error() string { return string(e) }

type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }
func (e *fatalError) Unwrap() error { return e.err }

type retryError struct {
	msg   string
	delay time.Duration
}

func (e *retryError) Error() string { return e.msg }

// panicError is a recovered panic of user code; it keeps the stack of the panicking goroutine.
type panicError struct {
	value any
	stack string
}

func (e *panicError) Error() string { return fmt.Sprintf("panic: %v", e.value) }
