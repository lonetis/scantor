package workspace

import (
	"errors"
	"fmt"
)

// Code is the error code a helper reports in its final stderr event (docs/editor.md §9.3). The
// orchestrator maps each code to an API error.
type Code string

// Helper error codes and their API mapping (docs/editor.md §9.3).
const (
	// CodeInvalidPath → 422 invalidPath (details.path).
	CodeInvalidPath Code = "invalidPath"
	// CodeInvalidArgument → 400 badRequest.
	CodeInvalidArgument Code = "invalidArgument"
	// CodeTooManyFiles, CodeTooLarge and CodeWorkspaceFull → 413 payloadTooLarge (details: {limit, actual?}).
	CodeTooManyFiles  Code = "tooManyFiles"
	CodeTooLarge      Code = "tooLarge"
	CodeWorkspaceFull Code = "workspaceFull"
	// CodeNotFound → 404 notFound.
	CodeNotFound Code = "notFound"
	// CodeExists → 409 alreadyExists.
	CodeExists Code = "exists"
	// CodeManifestInvalid → 422 manifestInvalid (details.errors: BuildError[]).
	CodeManifestInvalid Code = "manifestInvalid"
	// CodeWorkspaceDirty → 409 workspaceDirty (details: {current, expected}).
	CodeWorkspaceDirty Code = "workspaceDirty"
	// CodeGitFailed → 422 gitFailed (credentials redacted).
	CodeGitFailed Code = "gitFailed"
	// CodeGitDiverged → 409 gitDiverged. The orchestrator decides divergence from the git-pull output;
	// helpers never report it themselves today.
	CodeGitDiverged Code = "gitDiverged"
	// CodeInternal → 500 internal.
	CodeInternal Code = "internal"
)

// Exit codes of a helper run (docs/editor.md §9.3).
const (
	ExitOK       = 0
	ExitUser     = 1
	ExitInternal = 2
)

// Error is a helper failure with its code. Path is the offending path relative to the task folder (or
// the archive root), when there is one.
type Error struct {
	Code    Code
	Message string
	Path    string
	Details map[string]any
	Err     error
}

func (e *Error) Error() string {
	if e.Err != nil && e.Message == "" {
		return e.Err.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// ExitCode returns 2 for internal errors and 1 for every user error.
func (e *Error) ExitCode() int {
	if e.Code == CodeInternal {
		return ExitInternal
	}
	return ExitUser
}

func newError(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func pathError(p string, format string, args ...any) *Error {
	e := newError(CodeInvalidPath, format, args...)
	e.Path = p
	e.Details = map[string]any{"path": p}
	return e
}

func notFound(p string, format string, args ...any) *Error {
	e := newError(CodeNotFound, format, args...)
	e.Path = p
	return e
}

func invalidArgument(format string, args ...any) *Error {
	return newError(CodeInvalidArgument, format, args...)
}

// limitError reports an exceeded cap; actual < 0 means unknown (counted while streaming).
func limitError(code Code, limit, actual int64, format string, args ...any) *Error {
	e := newError(code, format, args...)
	e.Details = map[string]any{"limit": limit}
	if actual >= 0 {
		e.Details["actual"] = actual
	}
	return e
}

// internalError wraps an unexpected failure (I/O errors, missing tools).
func internalError(err error, format string, args ...any) *Error {
	e := newError(CodeInternal, format, args...)
	e.Message = fmt.Sprintf("%s: %v", e.Message, err)
	e.Err = err
	return e
}

// AsError converts any error into a helper Error: helper errors keep their code, everything else is
// internal.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: CodeInternal, Message: err.Error(), Err: err}
}
