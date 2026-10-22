package core

import (
	"strings"

	"github.com/lonetis/scantor/internal/runtime"
)

// Error is the error of Estimate, Resolve and Stream: the runtime's classified error with a
// ScantorError type (validation or platform) and its retryable flag (docs/templates.md §1.2, §8). The
// runtime turns it into a ScantorError with phase `schedule`; for a wrapped call it becomes the `error`
// reply of the template request.
//
// An error that concerns one scan config field carries its instance JSON pointer (for example
// "/upload") in Details[DetailPath]; `scantor templates estimate` reports such errors as issues.
type Error = runtime.Error

// Detail keys of Error.Details.
const (
	DetailPath   = "path"   // instance JSON pointer of the offending scan config field
	DetailIssues = "issues" // []Issue of a rejected scan config
)

// Validationf returns a non-retryable validation error: bad or unavailable inputs.
func Validationf(format string, args ...any) *Error {
	return runtime.Validation(format, args...)
}

// ValidationAt returns a non-retryable validation error about the scan config field at path.
func ValidationAt(path, format string, args ...any) *Error {
	e := runtime.Validation(format, args...)
	e.Details = map[string]any{DetailPath: path}
	return e
}

// Platformf returns a platform error: network, upstream, format or size failures. cause may be nil.
func Platformf(retryable bool, cause error, format string, args ...any) *Error {
	e := runtime.Platform(retryable, format, args...)
	e.Err = cause
	return e
}

// IssuesError returns the validation error of a scan config rejected with issues; its path is the
// path of the first issue, and the issues are in Details[DetailIssues].
func IssuesError(issues []Issue) *Error {
	parts := make([]string, len(issues))
	for i, is := range issues {
		parts[i] = is.String()
	}
	e := Validationf("invalid scan config: %s", strings.Join(parts, "; "))
	if len(issues) > 0 {
		e.Details = map[string]any{DetailPath: issues[0].Path, DetailIssues: issues}
	}
	return e
}

// AsError returns the *Error in err's chain.
func AsError(err error) (*Error, bool) { return runtime.AsError(err) }

// ErrorPath returns the scan config path an error concerns, or "" when it concerns none.
func ErrorPath(e *Error) string {
	if e == nil {
		return ""
	}
	path, _ := e.Details[DetailPath].(string)
	return path
}

// ErrorIssues returns the error as scan config issues: the issues of IssuesError, or one issue at the
// error's path with its message.
func ErrorIssues(e *Error) []Issue {
	if e == nil {
		return nil
	}
	if issues, ok := e.Details[DetailIssues].([]Issue); ok && len(issues) > 0 {
		return issues
	}
	return []Issue{{Path: ErrorPath(e), Message: e.Message}}
}
