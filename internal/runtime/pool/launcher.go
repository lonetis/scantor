package pool

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/lonetis/scantor/internal/protocol"
)

// Launcher starts connector processes of one task: the command template with {entry}, the runtime's
// environment, the work root for per-process directories, and the welcome parameters.
type Launcher struct {
	// Command is SCANTOR_CONNECTOR_CMD (or SCANTOR_DEBUG_CMD in debug mode).
	Command string
	// Entry replaces {entry}.
	Entry string
	// Environ is the runtime's environment; ConnectorEnv derives each process's environment from it.
	Environ []string
	// Dir is the working directory (/task).
	Dir string
	// WorkRoot is /tmp/scantor; process directories are WorkRoot/proc-<slot>-<gen>.
	WorkRoot       string
	Mode           string
	RuntimeVersion string
	Limits         protocol.Limits
	Debug          bool
	Logger         *slog.Logger
	Validator      *protocol.Validator
}

// Spawn starts the process of slot (generation gen) and performs the handshake. Output not attributed
// to a request goes to output.
func (l Launcher) Spawn(ctx context.Context, slot, gen int, output Sink) (*Process, error) {
	argv, err := ParseCommand(l.Command, l.Entry)
	if err != nil {
		return nil, &SpawnError{Reason: "invalid connector command: " + err.Error()}
	}
	exe, err := ResolveExecutable(argv[0], l.Dir, l.Environ)
	if err != nil {
		return nil, &SpawnError{Reason: fmt.Sprintf("connector command %q: %v", argv[0], err)}
	}
	tmp := filepath.Join(l.WorkRoot, fmt.Sprintf("proc-%d-%d", slot, gen))
	logger := l.Logger
	if logger != nil {
		logger = logger.With("slot", slot)
	}
	return Spawn(ctx, Options{
		Argv: argv, Path: exe, Env: ConnectorEnv(l.Environ, tmp, slot), Dir: l.Dir, TmpDir: tmp, Mode: l.Mode,
		RuntimeVersion: l.RuntimeVersion, Limits: l.Limits, Debug: l.Debug, Output: output, Logger: logger,
		Validator: l.Validator,
	})
}
