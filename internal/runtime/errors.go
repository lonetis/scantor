package runtime

import (
	"errors"
	"fmt"

	"github.com/lonetis/scantor/internal/api"
)

// Error is a classified failure: a ScantorError type, whether retrying can help, and an optional cause.
// Components that know the classification of a failure return it (internal/templates returns it from
// Resolve and Stream, docs/templates.md §1.2, §8); the runtime turns it into a ScantorError with phase,
// attempt and time (internal/runtime/scerr).
type Error struct {
	Type      api.ErrorType
	Message   string
	Retryable bool
	// Details is optional structured context (≤ 4 KiB as JSON after truncation).
	Details map[string]any
	// Err is the underlying cause; it is not part of the message.
	Err error
}

func (e *Error) Error() string { return e.Message }

// Unwrap returns the cause.
func (e *Error) Unwrap() error { return e.Err }

// NewError returns an Error with a formatted message.
func NewError(typ api.ErrorType, retryable bool, format string, args ...any) *Error {
	return &Error{Type: typ, Retryable: retryable, Message: fmt.Sprintf(format, args...)}
}

// Validation returns a non-retryable validation error: input or output is invalid and retrying cannot
// help.
func Validation(format string, args ...any) *Error {
	return NewError(api.ErrorValidation, false, format, args...)
}

// Platform returns a platform (infrastructure) error.
func Platform(retryable bool, format string, args ...any) *Error {
	return NewError(api.ErrorPlatform, retryable, format, args...)
}

// AsError returns the first *Error in err's chain.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}
