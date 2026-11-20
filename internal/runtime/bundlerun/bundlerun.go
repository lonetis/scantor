// Package bundlerun is bundle mode (`scantor runtime bundle`, docs/runtime.md §15.7), the entrypoint of a
// bundle image: it runs one revision outside the platform with only Docker. It reads the bundle info
// /scantor/bundle.json, fills and checks the recipient's configs and settings against the baked describe
// output and settings defaults, and runs the schedule and every analysis in this container on local mode's
// streaming run path. The results are plain files in a run directory of the mounted folder /work:
// results.jsonl, files/ and run.json (§15.8).
//
// Bundle mode is the documented exception to "users never call runtime commands": its flags are the
// recipient's interface. It has no API client, never starts a dockerd and masks secrets in everything it
// writes (docs/security.md BDL-5, BDL-7).
package bundlerun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/local"
)

// RunID is the run id of every bundle run: the ctx scanId and the prefix of the analysis ids.
const RunID = "bundle"

// Options configure Run.
type Options struct {
	// Info is the parsed bundle info (bundle.Parse of bundle.InfoPath).
	Info  *bundle.Info
	Flags Flags
	// Config is the runtime environment (connector command, data-source URLs, CA bundle).
	Config runtime.Config
	// JSON selects -o json: the masked local-mode events as NDJSON on stdout.
	JSON   bool
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// Signals delivers SIGTERM and SIGINT.
	Signals <-chan os.Signal
	// WorkDir is the mounted folder (bundle.WorkDir when empty; tests use a temporary directory).
	WorkDir string
	// TaskDir is the working directory of connector processes (runtime.TaskDir when empty; tests).
	TaskDir string
	// Now returns the current time (time.Now when nil).
	Now func() time.Time
	// RootDevice returns the device of the root file system, against which the run directory must lie on
	// a mount (the device of / when nil).
	RootDevice func() (uint64, error)
	// MountPoints returns the mount points other than / of the container that are no virtual file systems,
	// the second test of a mount (those of /proc/self/mountinfo when nil).
	MountPoints func() ([]string, error)
}

func (o Options) withDefaults() Options {
	if o.WorkDir == "" {
		o.WorkDir = bundle.WorkDir
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.RootDevice == nil {
		o.RootDevice = rootDevice
	}
	if o.MountPoints == nil {
		o.MountPoints = mountPoints
	}
	if o.Stdin == nil {
		o.Stdin = strings.NewReader("")
	}
	if o.Stdout == nil {
		o.Stdout = os.Stdout
	}
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
	return o
}

// Run runs bundle mode and returns its exit code (docs/runtime.md §15.9): 0 every analysis succeeded
// (also none), 1 analysis or schedule failures, 2 invalid flags, configs or run directory, a run directory
// that cannot be created or that another run filled meanwhile, or a connector that does not start, 3
// platform failure, total timeout, interrupt or a run directory that cannot be written. --describe prints
// and returns 2 when there are issues, else 0.
func Run(ctx context.Context, opts Options) int {
	o := opts.withDefaults()
	p, issues := o.prepare()
	if o.Flags.Describe {
		return o.describe(p, issues)
	}
	if len(issues) > 0 {
		o.reportIssues(issues)
		return local.ExitValidation
	}
	return o.run(ctx, p)
}

// run creates the run directory of a prepared run (claims the default one), opens its sink and runs it.
func (o *Options) run(ctx context.Context, p *prepared) int {
	var err error
	if p.defaultOut {
		var dir string
		if dir, err = claimOutDir(p.outDir, p.owner); err == nil {
			p.outDir = dir
		}
	} else {
		err = createOutDir(p.outDir, p.owner)
	}
	if err != nil {
		o.reportIssues([]api.Issue{{Path: "--" + FlagOut, Message: fmt.Sprintf("cannot create %s: %v", p.outDir, err)}})
		return local.ExitValidation
	}
	console := newConsole(o, p)
	s, err := newSink(o, p, console)
	if errors.Is(err, fs.ErrExist) {
		// Another run started in the same --out directory after the checks.
		o.reportIssues([]api.Issue{notEmpty(p.outDir)})
		return local.ExitValidation
	}
	if err != nil {
		fmt.Fprintf(o.Stderr, "error: cannot write the run directory %s: %v\n", p.outDir, err)
		return local.ExitPlatform
	}
	code := local.Run(ctx, local.Options{
		Spec: o.spec(p), Config: o.Config, Stdout: o.Stdout, Stderr: o.Stderr, Signals: o.Signals, TaskDir: o.TaskDir,
		Events: s, Stream: true, UncappedRetryDelay: true, FileOwner: p.owner, Stop: s.Failed(),
	})
	return s.close(code)
}

// reportIssues reports the issues of a run that does not start: `path: message` lines on stderr, or with
// -o json an error event (details.issues) and the end event with reason startFailed and exit code 2.
func (o *Options) reportIssues(issues []api.Issue) {
	if o.JSON {
		now := api.NewTime(o.Now())
		details, _ := json.Marshal(api.IssueDetails{Issues: issues})
		msg := issues[0].Path + ": " + issues[0].Message
		if len(issues) > 1 {
			msg += fmt.Sprintf(" (and %d more)", len(issues)-1)
		}
		e := local.NewEmitter(o.Stdout)
		e.Emit(local.ErrorEvent{Type: local.EventError, At: now, Error: api.ScantorError{
			Type: api.ErrorValidation, Phase: api.PhaseBootstrap, Message: msg, Details: details, At: now,
		}})
		e.Emit(local.EndEvent{Type: local.EventEnd, At: now, Reason: local.ReasonStartFailed, ExitCode: local.ExitValidation})
		return
	}
	var b strings.Builder
	for _, is := range issues {
		b.WriteString(terminalSafe(is.Path+": "+is.Message) + "\n")
	}
	fmt.Fprintf(&b, "nothing was run; docker run --rm %s --help shows the flags\n", o.Info.Image)
	_, _ = io.WriteString(o.Stderr, b.String())
}
