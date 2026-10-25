package taskpipe

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/moby/moby/client"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/schema"
)

// Limits of describe and check output (docs/tasks.md §9.10).
const (
	// MaxDescriptionBytes bounds the describe output.
	MaxDescriptionBytes = 1 << 20
	// MaxContainerErrors bounds the error events of one describe or check container that are reported.
	// The container's output is untrusted, so the cap applies in both phases.
	MaxContainerErrors = 200
	// MaxDescriptionWarnings bounds description.warnings.
	MaxDescriptionWarnings = 100
	// maxContainerLine bounds one stdout line of a describe or check container.
	maxContainerLine = MaxDescriptionBytes + 64<<10
	// stderrTailBytes is the stderr kept for failure messages.
	stderrTailBytes = 4 << 10
)

// DescribeSchemaPath is the path of the describe output schema inside scantor.Schemas.
const DescribeSchemaPath = "schemas/describe.schema.json"

// containerEvent is one stdout line of a describe or check container ([runtime] §16). Lines are
// untrusted: user code shares the container, so only known fields are read and every value is bounded.
type containerEvent struct {
	Type        string          `json:"type"`
	Stream      string          `json:"stream"`
	Level       string          `json:"level"`
	Text        *string         `json:"text"`
	Error       *api.BuildError `json:"error"`
	Description json.RawMessage `json:"description"`
	OK          *bool           `json:"ok"`
	ExitCode    *int            `json:"exitCode"`
	Skipped     *bool           `json:"skipped"`
}

// PipelineContainerOptions returns the ContainerCreate options of a describe or check container
// (docs/tasks.md §9.5): name scantor-b-<uuid>, managed labels of kind build, entrypoint
// `/scantor/scantor runtime <mode> --entry <entry>`, the worker hardening profile without added
// capabilities, network none, memory max(1 GiB, per-process memory + 256 MiB), CPUs max(1, per-process
// cpus), PIDs limit 256 and only the image environment.
func PipelineContainerOptions(mode, imageID, entry string, perProcess api.Resources) (client.ContainerCreateOptions, error) {
	labels, err := container.ManagedLabels(container.KindBuild, container.Identity{})
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	return container.RuntimeContainer{
		Name:    container.Name(container.KindBuild, uuid.NewString()),
		Image:   imageID,
		Mode:    mode,
		Args:    []string{"--entry", entry},
		Labels:  labels,
		Profile: container.BuildProfile(perProcess),
	}.CreateOptions()
}

// binary resolves the runtime binary once per pipeline run.
func (b *builder) binary(ctx context.Context) (*container.Binary, bool) {
	if b.bin != nil {
		return b.bin, true
	}
	bin, err := b.p.runtime.Resolve(ctx)
	if err != nil {
		b.failf(api.BuildPhasePlatform, "resolve the scantor runtime: %v", err)
		return nil, false
	}
	b.bin = bin
	return bin, true
}

// containerOutcome collects the outcome of a describe or check container.
type containerOutcome struct {
	exit       containerExit
	result     *containerEvent
	errors     int
	dropped    int
	stderrTail []byte
}

// runPipelineContainer runs the runtime in mode in the built image and merges its events into the
// pipeline's stream under phase.
func (b *builder) runPipelineContainer(ctx context.Context, phase api.BuildPhase, mode string) (*containerOutcome, bool) {
	bin, ok := b.binary(ctx)
	if !ok {
		return nil, false
	}
	opts, err := PipelineContainerOptions(mode, b.image.ID, b.res.Manifest.Entry, b.res.SettingsDefaults.Resources)
	if err != nil {
		b.failf(api.BuildPhasePlatform, "%s container: %v", mode, err)
		return nil, false
	}
	out := &containerOutcome{}
	var mu sync.Mutex
	exit, err := containerRun{
		docker:  b.p.docker,
		create:  opts,
		bin:     bin,
		timeout: b.p.cfg.DescribeTimeout,
		maxLine: maxContainerLine,
		stdout: func(line []byte) {
			mu.Lock()
			defer mu.Unlock()
			b.containerLine(phase, line, out)
		},
		stderr: func(line []byte) {
			mu.Lock()
			defer mu.Unlock()
			out.stderrTail = appendTail(out.stderrTail, line, stderrTailBytes)
			b.p.events.Log(phase, StreamStderr, LevelInfo, string(line))
		},
	}.run(ctx)
	out.exit = exit
	if err != nil {
		if ctx.Err() != nil {
			b.interrupted(ctx)
		} else {
			b.failf(api.BuildPhasePlatform, "%s container: %v", mode, err)
		}
		return out, false
	}
	if exit.TimedOut {
		b.failf(phase, "%s exceeded %s (SCANTOR_DESCRIBE_TIMEOUT)", mode, formatDuration(b.p.cfg.DescribeTimeout))
		return out, false
	}
	if exit.Interrupted {
		b.interrupted(ctx)
		return out, false
	}
	if out.dropped > 0 {
		b.log(phase, "%d more diagnostics are not shown", out.dropped)
	}
	return out, true
}

// containerLine handles one stdout line of a describe or check container.
func (b *builder) containerLine(phase api.BuildPhase, line []byte, out *containerOutcome) {
	var ev containerEvent
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		b.p.events.Log(phase, StreamStdout, LevelInfo, string(line))
		return
	}
	switch ev.Type {
	case EventLog:
		if ev.Text == nil {
			return
		}
		level := LevelInfo
		if ev.Level == LevelWarning {
			level = LevelWarning
		}
		b.p.events.Log(phase, logStream(ev.Stream), level, *ev.Text)
	case EventError:
		if ev.Error == nil {
			return
		}
		if out.errors >= MaxContainerErrors {
			out.dropped++
			return
		}
		out.errors++
		b.fail(sanitizeBuildError(phase, *ev.Error))
	case EventResult:
		if out.result == nil {
			out.result = &ev
		}
	default:
		b.p.events.Log(phase, StreamStdout, LevelInfo, string(line))
	}
}

func logStream(s string) string {
	switch s {
	case StreamStdout, StreamStderr, StreamCheck, StreamPipeline, StreamBuild:
		return s
	default:
		return StreamStdout
	}
}

// sanitizeBuildError forces the phase of a container's error and drops an invalid location.
func sanitizeBuildError(phase api.BuildPhase, be api.BuildError) api.BuildError {
	be.Phase = phase
	be.File = strings.TrimPrefix(be.File, "/task/")
	if be.File != "" && checkPath(be.File) != "" {
		be.File, be.Line, be.Column = "", 0, 0
	}
	if be.File == "" || be.Line < 0 {
		be.Line, be.Column = 0, 0
	}
	if be.Column < 0 {
		be.Column = 0
	}
	if be.Message == "" {
		be.Message = "error"
	}
	return be
}

func appendTail(tail, line []byte, limit int) []byte {
	tail = append(tail, line...)
	tail = append(tail, '\n')
	if len(tail) > limit {
		tail = tail[len(tail)-limit:]
	}
	return tail
}

// describe is the describe phase: the runtime describes the task in a describe container; the
// pipeline validates the output, checks the language and merges the static warnings.
func (b *builder) describe(ctx context.Context) bool {
	out, ok := b.runPipelineContainer(ctx, api.BuildPhaseDescribe, container.ModeDescribe)
	if !ok {
		return false
	}
	if out.exit.Code != 0 {
		if out.errors == 0 {
			b.failf(api.BuildPhaseDescribe, "describe failed with exit code %d%s", out.exit.Code, tailSuffix(out.stderrTail))
		}
		return false
	}
	if out.result == nil || len(out.result.Description) == 0 {
		b.failf(api.BuildPhaseDescribe, "describe produced no description%s", tailSuffix(out.stderrTail))
		return false
	}
	desc, err := parseDescription(out.result.Description)
	if err != nil {
		b.failf(api.BuildPhaseDescribe, "invalid describe output: %v", err)
		return false
	}
	if lang := *b.res.Language; desc.Connector.Language != lang {
		b.failf(api.BuildPhaseDescribe, "the connector loaded the task as %s, but the manifest language is %s", desc.Connector.Language, lang)
		return false
	}
	desc.Warnings = mergeWarnings(b.static.Warnings, desc.Warnings)
	b.res.Description = desc
	for _, w := range desc.Warnings {
		if !containsString(b.res.Warnings, w) {
			b.res.Warnings = append(b.res.Warnings, w)
		}
	}
	b.log(api.BuildPhaseDescribe, "described: %s connector %s, schedule %s", desc.Connector.Language, desc.Connector.Version, describeSchedule(desc.Schedule))
	return true
}

func describeSchedule(s api.Schedule) string {
	if s.Kind == api.ScheduleKindTemplate {
		return "template " + s.Template
	}
	return s.Kind
}

func tailSuffix(tail []byte) string {
	t := strings.TrimSpace(string(tail))
	if t == "" {
		return ""
	}
	return ":\n" + t
}

var (
	describeSchemaOnce sync.Once
	describeSchema     *schema.Schema
	describeSchemaErr  error
)

// parseDescription validates the describe output against schemas/describe.schema.json and its size
// limit.
func parseDescription(raw json.RawMessage) (*api.Description, error) {
	if len(raw) > MaxDescriptionBytes {
		return nil, fmt.Errorf("the description is %d bytes; the limit is %d", len(raw), MaxDescriptionBytes)
	}
	describeSchemaOnce.Do(func() {
		data, err := scantor.Schemas.ReadFile(DescribeSchemaPath)
		if err != nil {
			describeSchemaErr = err
			return
		}
		describeSchema, describeSchemaErr = schema.Compile(data)
	})
	if describeSchemaErr != nil {
		return nil, fmt.Errorf("load %s: %w", DescribeSchemaPath, describeSchemaErr)
	}
	instance, err := schema.ParseJSON(raw)
	if err != nil {
		return nil, err
	}
	if issues := describeSchema.Validate(instance); len(issues) > 0 {
		msgs := make([]string, 0, min(len(issues), 5))
		for i, is := range issues {
			if i == 5 {
				break
			}
			msgs = append(msgs, is.String())
		}
		return nil, fmt.Errorf("%s", strings.Join(msgs, "; "))
	}
	var d api.Description
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// mergeWarnings puts the static warnings before the describe warnings, without duplicates and with at
// most MaxDescriptionWarnings entries.
func mergeWarnings(static, described []string) []string {
	out := make([]string, 0, len(static)+len(described))
	for _, w := range append(append([]string{}, static...), described...) {
		if len(out) == MaxDescriptionWarnings {
			break
		}
		if !containsString(out, w) {
			out = append(out, w)
		}
	}
	return out
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// check is the check phase: the runtime runs SCANTOR_CHECK_CMD in a check container; error lines are
// BuildErrors (at most MaxContainerErrors are reported).
func (b *builder) check(ctx context.Context) bool {
	out, ok := b.runPipelineContainer(ctx, api.BuildPhaseCheck, container.ModeCheck)
	if !ok {
		return false
	}
	res := out.result
	if res != nil && res.Skipped != nil && *res.Skipped {
		b.log(api.BuildPhaseCheck, "type check skipped: the image sets no SCANTOR_CHECK_CMD")
	}
	switch {
	case res == nil && out.exit.Code == 0:
		b.failf(api.BuildPhaseCheck, "check produced no result%s", tailSuffix(out.stderrTail))
		return false
	case out.errors > 0:
		return false
	case out.exit.Code != 0 || res == nil || res.OK == nil || !*res.OK:
		code := out.exit.Code
		if res != nil && res.ExitCode != nil {
			code = int64(*res.ExitCode)
		}
		b.failf(api.BuildPhaseCheck, "the type check failed with exit code %d%s", code, tailSuffix(out.stderrTail))
		return false
	}
	return true
}
