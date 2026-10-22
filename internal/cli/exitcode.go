package cli

import (
	"errors"
	"fmt"
)

// Exit classes of the scantor CLI (docs/development.md §6): every command ends with one of them.
const (
	// ExitOK: the command succeeded.
	ExitOK = 0
	// ExitAnalysisFailures: the command ran, but analyses failed (`dev run`).
	ExitAnalysisFailures = 1
	// ExitValidation: the input is invalid (usage, flags, task content, configs, API 4xx).
	ExitValidation = 2
	// ExitPlatform: the platform failed (Docker, network, API 5xx, internal errors, interrupts).
	ExitPlatform = 3
)

// ExitError carries an exit class. Silent errors are not printed (the command already reported the
// outcome, for example `dev run` with failed analyses).
type ExitError struct {
	Code   int
	Err    error
	Silent bool
}

func (e *ExitError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("exit status %d", e.Code)
	}
	return e.Err.Error()
}

func (e *ExitError) Unwrap() error { return e.Err }

// ExitClass returns the exit code.
func (e *ExitError) ExitClass() int { return e.Code }

// WithExit wraps err with an exit class.
func WithExit(code int, err error) error {
	if err == nil {
		return nil
	}
	return &ExitError{Code: code, Err: err}
}

// SilentExit returns an error that ends the command with code without printing anything.
func SilentExit(code int) error { return &ExitError{Code: code, Silent: true} }

// UsageError marks err as a usage problem (exit 2).
func UsageError(err error) error { return WithExit(ExitValidation, err) }

// ValidationError marks err as invalid input or task content (exit 2).
func ValidationError(err error) error { return WithExit(ExitValidation, err) }

// PlatformError marks err as a platform failure (exit 3).
func PlatformError(err error) error { return WithExit(ExitPlatform, err) }

// exitClasser is implemented by every error type that knows its exit class (ExitError, api.Error,
// api.NetworkError and domain errors of other packages).
type exitClasser interface{ ExitClass() int }

// ExitCode maps the error returned by the root command to the process exit code: nil → 0; the first
// ExitClass in the error chain; anything else (including an interrupt) → 3.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	var ec exitClasser
	if errors.As(err, &ec) {
		if code := ec.ExitClass(); code >= ExitOK && code <= ExitPlatform {
			return code
		}
	}
	return ExitPlatform
}

func isSilent(err error) bool {
	var e *ExitError
	return errors.As(err, &e) && e.Silent
}
