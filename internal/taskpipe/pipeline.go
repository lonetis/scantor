package taskpipe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// Input is the task a command works on: a folder or a tar.gz pack, exactly one of them.
type Input struct {
	// Dir is a task folder.
	Dir string
	// Archive is a tar.gz pack (stdin, a file or an S3 snapshot).
	Archive io.Reader
}

// RuntimeResolver returns the linux scantor binary to inject into describe, check and local-mode
// containers (container.RuntimeBinary implements it).
type RuntimeResolver interface {
	Resolve(ctx context.Context) (*container.Binary, error)
}

// Pipeline runs the task-pipeline commands and reports them as events.
type Pipeline struct {
	cfg    Config
	events *Emitter
	// docker and runtime are needed by Build only.
	docker  client.APIClient
	runtime RuntimeResolver
}

// New returns a pipeline that reports to events. docker and runtime may be nil for Pack and
// CheckStatic.
func New(cfg Config, events *Emitter, docker client.APIClient, runtime RuntimeResolver) *Pipeline {
	return &Pipeline{cfg: cfg, events: events, docker: docker, runtime: runtime}
}

// BuildOptions are the flags of `scantor task build` (docs/tasks.md §9.1).
type BuildOptions struct {
	StaticOptions
	// Tag is the reference of the built image (--tag). When empty, TagFunc derives it from the manifest
	// name and the pack hash (`scantor validate`, `dev run`).
	Tag     string
	TagFunc func(name, packSHA256 string) string
	// SkipCheck skips the check phase (test runs, dev run).
	SkipCheck bool
	// ReuseExisting skips the image build when an image tagged Tag already exists locally.
	ReuseExisting bool
	// DebugBuild sets the build argument SCANTOR_GCFLAGS=all=-N -l (dev debug).
	DebugBuild bool
	// Push pushes the image after every other phase succeeded; PushGate, when set, is read for the
	// go-ahead line first (docs/tasks.md §9.7).
	Push     bool
	PushGate io.Reader
}

// run is the state of one command.
type run struct {
	p      *Pipeline
	res    *Result
	pack   *Pack
	last   api.BuildPhase
	static *StaticResult
}

func (p *Pipeline) newRun() *run { return &run{p: p, res: newResult()} }

// fail records and emits an error.
func (r *run) fail(be api.BuildError) {
	be.Message = truncateMessage(be.Message)
	r.res.Errors = append(r.res.Errors, be)
	r.p.events.Error(be)
}

func (r *run) failf(phase api.BuildPhase, format string, args ...any) {
	r.fail(api.BuildError{Phase: phase, Message: fmt.Sprintf(format, args...)})
}

func (r *run) log(phase api.BuildPhase, format string, args ...any) {
	r.p.events.Log(phase, StreamPipeline, LevelInfo, fmt.Sprintf(format, args...))
}

func (r *run) warn(phase api.BuildPhase, text string) {
	r.p.events.Log(phase, StreamPipeline, LevelWarning, text)
}

// phase runs fn as phase name, records its duration and reports whether it succeeded (no new errors).
func (r *run) phase(name api.BuildPhase, fn func() bool) bool {
	r.last = name
	start := time.Now()
	before := len(r.res.Errors)
	ok := fn()
	r.res.DurationsMs[string(name)] = time.Since(start).Milliseconds()
	return ok && len(r.res.Errors) == before
}

// finish emits the result event and returns the result. Errors without an explicit phase are
// impossible by construction; the result is ok exactly when no error was recorded.
func (r *run) finish() *Result {
	if r.pack != nil {
		if err := r.pack.Close(); err != nil {
			r.warn(r.last, fmt.Sprintf("remove the temporary pack: %v", err))
		}
	}
	r.res.OK = len(r.res.Errors) == 0
	if !r.res.OK {
		r.res.Image = nil
	}
	if r.last == "" {
		r.last = api.BuildPhasePack
	}
	r.p.events.Result(r.last, r.res)
	return r.res
}

// interrupted reports a cancelled context as a platform error.
func (r *run) interrupted(ctx context.Context) bool {
	if err := ctx.Err(); err != nil {
		r.failf(api.BuildPhasePlatform, "interrupted: %v", err)
		return true
	}
	return false
}

// packPhase packs the input and records the summary.
func (r *run) packPhase(ctx context.Context, in Input) bool {
	return r.phase(api.BuildPhasePack, func() bool {
		var (
			pack *Pack
			err  error
		)
		switch {
		case in.Archive != nil && in.Dir == "":
			pack, err = ReadPack(ctx, in.Archive, r.p.cfg.Pack)
		case in.Dir != "" && in.Archive == nil:
			pack, err = PackDir(ctx, in.Dir, r.p.cfg.Pack)
		default:
			err = errors.New("the input must be either a folder or a pack")
		}
		if err != nil {
			r.packError(ctx, err)
			return false
		}
		r.pack = pack
		s := pack.Summary
		r.res.Pack = &s
		r.log(api.BuildPhasePack, "packed %d files, %d bytes, sha256 %s", s.FileCount, s.Bytes, s.PackSHA256)
		return true
	})
}

func (r *run) packError(ctx context.Context, err error) {
	var perrs PackErrors
	switch {
	case errors.As(err, &perrs):
		for _, pe := range perrs {
			r.fail(api.BuildError{Phase: api.BuildPhasePack, File: pe.Path, Message: pe.Message})
		}
	case ctx.Err() != nil:
		r.interrupted(ctx)
	default:
		r.failf(api.BuildPhasePlatform, "pack: %v", err)
	}
}

// staticPhase runs check-static and records the normalised manifest.
func (r *run) staticPhase(opts StaticOptions) bool {
	return r.phase(api.BuildPhaseStatic, func() bool {
		st := CheckStatic(r.pack, opts, r.p.cfg)
		r.static = st
		for _, w := range st.Warnings {
			r.warn(api.BuildPhaseStatic, w)
		}
		r.res.Warnings = append(r.res.Warnings, st.Warnings...)
		for _, be := range st.Errors {
			r.fail(be)
		}
		if st.Manifest != nil {
			m := st.Manifest.Manifest
			settings := st.Manifest.SettingsDefaults
			lang := st.Manifest.Language.Name
			privileged := st.Manifest.Privileged
			r.res.Manifest, r.res.SettingsDefaults = &m, &settings
			r.res.Language, r.res.Privileged = &lang, &privileged
		}
		return st.OK()
	})
}

// Pack runs `scantor task pack`: it packs the input and, when out is not nil, writes the tar.gz to it.
func (p *Pipeline) Pack(ctx context.Context, in Input, out io.Writer) *Result {
	r := p.newRun()
	if !r.packPhase(ctx, in) || out == nil {
		return r.finish()
	}
	if err := r.pack.WriteGzip(out); err != nil {
		r.failf(api.BuildPhasePlatform, "write the pack: %v", err)
	}
	return r.finish()
}

// CheckStatic runs `scantor task check-static`.
func (p *Pipeline) CheckStatic(ctx context.Context, in Input, opts StaticOptions) *Result {
	r := p.newRun()
	if r.packPhase(ctx, in) {
		r.staticPhase(opts)
	}
	return r.finish()
}

// Build runs `scantor task build`: pack → static → build → describe → check → push. A failing phase
// stops the pipeline; the last event is always the result.
func (p *Pipeline) Build(ctx context.Context, in Input, opts BuildOptions) *Result {
	r := p.newRun()
	if opts.Push {
		if err := checkPushTarget(opts.Tag, p.cfg.RegistryPushPassword); err != nil {
			r.last = api.BuildPhasePlatform
			r.failf(api.BuildPhasePlatform, "%v", err)
			return r.finish()
		}
	}
	if p.docker == nil || p.runtime == nil {
		r.last = api.BuildPhasePlatform
		r.failf(api.BuildPhasePlatform, "build needs a Docker daemon")
		return r.finish()
	}
	if !r.packPhase(ctx, in) || !r.staticPhase(opts.StaticOptions) {
		return r.finish()
	}
	tag := opts.Tag
	if tag == "" && opts.TagFunc != nil {
		tag = opts.TagFunc(r.res.Manifest.Name, r.res.Pack.PackSHA256)
	}
	if tag == "" {
		r.failf(api.BuildPhasePlatform, "build needs an image tag")
		return r.finish()
	}
	b := &builder{run: r, opts: opts, tag: tag}
	if !r.phase(api.BuildPhaseBuild, func() bool { return b.build(ctx) }) || r.interrupted(ctx) {
		return r.finish()
	}
	if !r.phase(api.BuildPhaseDescribe, func() bool { return b.describe(ctx) }) || r.interrupted(ctx) {
		return r.finish()
	}
	if !opts.SkipCheck {
		if !r.phase(api.BuildPhaseCheck, func() bool { return b.check(ctx) }) || r.interrupted(ctx) {
			return r.finish()
		}
	}
	if opts.Push {
		r.phase(api.BuildPhasePush, func() bool { return b.push(ctx) })
	}
	return r.finish()
}

// formatDuration renders a duration compactly ("30m", "1h30m", "45s").
func formatDuration(d time.Duration) string {
	s := d.Round(time.Second).String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}
