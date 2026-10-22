package taskpipe

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/schema"
)

// LocalSpecVersion is the version of the local-mode spec.
const LocalSpecVersion = 1

// LocalRunID is the run id of `scantor dev run` (ctx scanId "local").
const LocalRunID = "local"

// LocalOutDir is the out directory of the local-mode spec inside the container.
const LocalOutDir = container.OutDir

// LocalSpec is the local-mode spec of docs/runtime.md §15.1, written to /scantor/in/spec.json.
type LocalSpec struct {
	V                     int                        `json:"v"`
	RunID                 string                     `json:"runId"`
	Entry                 string                     `json:"entry"`
	TaskConfig            json.RawMessage            `json:"taskConfig"`
	ScanConfig            json.RawMessage            `json:"scanConfig"`
	AnalysisConfig        json.RawMessage            `json:"analysisConfig"`
	Limit                 int                        `json:"limit"`
	Processes             int                        `json:"processes"`
	TimeoutMs             int64                      `json:"timeoutMs"`
	MaxAttempts           int                        `json:"maxAttempts"`
	Backoff               api.Backoff                `json:"backoff"`
	MaxAnalysesPerProcess int                        `json:"maxAnalysesPerProcess"`
	TotalTimeoutMs        *int64                     `json:"totalTimeoutMs,omitempty"`
	Debug                 bool                       `json:"debug"`
	DataSources           api.DataSources            `json:"dataSources"`
	Uploads               map[string]LocalUpload     `json:"uploads"`
	Resolved              map[string]json.RawMessage `json:"resolved"`
	Limits                LocalLimits                `json:"limits"`
	OutDir                string                     `json:"outDir"`
}

// LocalUpload is a referenced upload copied into a local-mode container.
type LocalUpload struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// LocalLimits are the limits of a local run (the bootstrap limits of worker mode).
type LocalLimits struct {
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxFileBytes           int64 `json:"maxFileBytes"`
	MaxFilesPerAnalysis    int   `json:"maxFilesPerAnalysis"`
	LogTailBytes           int   `json:"logTailBytes"`
	LogTailEarlierBytes    int   `json:"logTailEarlierBytes"`
}

// DefaultLocalLimits are the compiled-in limits of `scantor dev run`, equal to the .env.example defaults
// of SCANTOR_MAX_ANALYSIS_CONFIG_BYTES, SCANTOR_MAX_RESULT_BYTES, SCANTOR_MAX_FILE_BYTES and
// SCANTOR_MAX_FILES_PER_ANALYSIS, and the fixed log tail sizes.
func DefaultLocalLimits() LocalLimits {
	return LocalLimits{
		MaxAnalysisConfigBytes: 64 << 10,
		MaxResultBytes:         1 << 20,
		MaxFileBytes:           1 << 30,
		MaxFilesPerAnalysis:    100,
		LogTailBytes:           32 << 10,
		LogTailEarlierBytes:    4 << 10,
	}
}

// DebugPortEnv is the base image variable naming the debugger port.
const DebugPortEnv = "SCANTOR_DEBUG_PORT"

// LocalRun runs a built image in the runtime's local mode on the local Docker daemon (`scantor dev
// run`, `dev debug`, docs/tasks.md §11.4): the spec is copied in with the runtime, nothing is
// bind-mounted, stdout carries the local-mode events and /scantor/out is copied out after the
// container exited.
type LocalRun struct {
	Docker  client.APIClient
	Runtime RuntimeResolver
	// Image is the image id of the build.
	Image string
	Spec  LocalSpec
	// Resources are the per-process resources of the manifest.
	Resources api.Resources
	// Network is the container's network; empty means Docker's default bridge.
	Network string
	// OutDir receives /scantor/out (files land in OutDir/files/<seq>/<fileId>/<name>); it is created
	// when the run produced files.
	OutDir string
	// StopGrace is the time the runtime gets to end an interrupted run (in-flight analyses are reported
	// as cancelled) before it is killed; 0 means DefaultLocalStopGrace.
	StopGrace time.Duration
	// OnStart, when set, is called right before the container is created and started, with the published
	// debugger port (0 when not debugging).
	OnStart func(debugPort int)
	// OnEvent receives every stdout line (one local-mode event); OnStderr every stderr line of the
	// runtime. Neither may retain the slice.
	OnEvent  func(line []byte)
	OnStderr func(line []byte)
}

// LocalResult is the outcome of a local run.
type LocalResult struct {
	// ExitCode is the runtime's exit code (docs/runtime.md §15.4).
	ExitCode    int64
	Interrupted bool
	// DebugPort is the published debugger port of a debug run.
	DebugPort int
	// Files counts the files written below OutDir.
	Files int
}

// DefaultLocalStopGrace is the default LocalRun.StopGrace.
const DefaultLocalStopGrace = 15 * time.Second

// maxLocalLine bounds one stdout line of a local run (results are at most 1 MiB plus their envelope).
const maxLocalLine = 8 << 20

// Run runs the container and returns its outcome.
func (l LocalRun) Run(ctx context.Context) (LocalResult, error) {
	var res LocalResult
	spec, err := json.Marshal(l.Spec)
	if err != nil {
		return res, fmt.Errorf("encode the local spec: %w", err)
	}
	opts, err := l.createOptions(ctx, &res)
	if err != nil {
		return res, err
	}
	bin, err := l.Runtime.Resolve(ctx)
	if err != nil {
		return res, fmt.Errorf("resolve the scantor runtime: %w", err)
	}
	if l.OnStart != nil {
		l.OnStart(res.DebugPort)
	}
	exit, err := containerRun{
		docker:    l.Docker,
		create:    opts,
		bin:       bin,
		extra:     container.LocalModeFiles(spec, nil),
		stopGrace: l.stopGrace(),
		maxLine:   maxLocalLine,
		stdout:    l.OnEvent,
		stderr:    l.OnStderr,
		afterExit: func(ctx context.Context, id string) error {
			n, err := copyOut(ctx, l.Docker, id, l.OutDir)
			res.Files = n
			return err
		},
	}.run(ctx)
	res.ExitCode, res.Interrupted = exit.Code, exit.Interrupted
	return res, err
}

func (l LocalRun) stopGrace() time.Duration {
	if l.StopGrace > 0 {
		return l.StopGrace
	}
	return DefaultLocalStopGrace
}

func (l LocalRun) createOptions(ctx context.Context, res *LocalResult) (client.ContainerCreateOptions, error) {
	labels, err := container.ManagedLabels(container.KindTestRun, container.Identity{User: LocalRunID})
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	netName := l.Network
	if netName == "" {
		netName = "bridge"
	}
	opts, err := container.RuntimeContainer{
		Name:               container.Name(container.KindTestRun, LocalRunID+"-"+uuid.NewString()),
		Image:              l.Image,
		Mode:               container.ModeLocal,
		Args:               []string{"--spec", container.SpecPath},
		Labels:             labels,
		Profile:            container.TestRunProfile(l.Resources, netName, nil),
		StopTimeoutSeconds: int(max(l.stopGrace(), time.Second) / time.Second),
	}.CreateOptions()
	if err != nil || !l.Spec.Debug {
		return opts, err
	}
	port, err := l.debugPort(ctx)
	if err != nil {
		return opts, err
	}
	p, err := network.ParsePort(strconv.Itoa(port) + "/tcp")
	if err != nil {
		return opts, fmt.Errorf("%s: %w", DebugPortEnv, err)
	}
	opts.Config.ExposedPorts = network.PortSet{p: {}}
	opts.HostConfig.PortBindings = network.PortMap{p: {{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: strconv.Itoa(port)}}}
	res.DebugPort = port
	return opts, nil
}

// debugPort reads SCANTOR_DEBUG_PORT from the image environment.
func (l LocalRun) debugPort(ctx context.Context) (int, error) {
	inspect, err := l.Docker.ImageInspect(ctx, l.Image)
	if err != nil {
		return 0, fmt.Errorf("inspect %s: %w", l.Image, err)
	}
	if inspect.Config != nil {
		for _, kv := range inspect.Config.Env {
			if v, ok := strings.CutPrefix(kv, DebugPortEnv+"="); ok {
				port, err := strconv.Atoi(v)
				if err != nil || port < 1 || port > 65535 {
					return 0, fmt.Errorf("the image sets an invalid %s %q", DebugPortEnv, v)
				}
				return port, nil
			}
		}
	}
	return 0, fmt.Errorf("the image sets no %s; its base image does not support debugging", DebugPortEnv)
}

// copyOut copies /scantor/out of the container into outDir. Only regular files and directories with
// valid relative paths are written, through an os.Root, so nothing outside outDir can be touched.
func copyOut(ctx context.Context, docker client.APIClient, id, outDir string) (int, error) {
	res, err := docker.CopyFromContainer(ctx, id, client.CopyFromContainerOptions{SourcePath: container.OutDir})
	if err != nil {
		if container.IsNotFound(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("copy %s: %w", container.OutDir, err)
	}
	defer res.Content.Close()
	var root *os.Root
	defer func() {
		if root != nil {
			_ = root.Close()
		}
	}()
	files := 0
	tr := tar.NewReader(res.Content)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return files, nil
		}
		if err != nil {
			return files, fmt.Errorf("read %s: %w", container.OutDir, err)
		}
		// The archive's root is the base name of the copied directory ("out/…"); anything else, and any
		// entry that is not a regular file with a valid relative path, is skipped.
		top, rel, _ := strings.Cut(path.Clean(hdr.Name), "/")
		if top != path.Base(container.OutDir) || rel == "" || hdr.Typeflag != tar.TypeReg || checkPath(rel) != "" {
			continue
		}
		if root == nil {
			if err := os.MkdirAll(outDir, 0o750); err != nil {
				return files, fmt.Errorf("create %s: %w", outDir, err)
			}
			if root, err = os.OpenRoot(outDir); err != nil {
				return files, fmt.Errorf("open %s: %w", outDir, err)
			}
		}
		if err := writeOutFile(root, rel, tr); err != nil {
			return files, err
		}
		files++
	}
}

func writeOutFile(root *os.Root, rel string, r io.Reader) error {
	if dir := parentDir(rel); dir != "." {
		if err := root.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	f, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("write %s: %w", rel, err)
	}
	if _, err := io.Copy(f, r); err != nil {
		_ = f.Close()
		return fmt.Errorf("write %s: %w", rel, err)
	}
	return f.Close()
}

// EffectiveConfig validates a config (nil means {}) against a described schema with defaults filled
// (docs/tasks.md §6.3) and returns it. Validation failures are BuildErrors of phase config, for example
// "taskConfig /greeting: must be string".
func EffectiveConfig(name string, schemaDoc, raw json.RawMessage) (json.RawMessage, []api.BuildError, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	s, err := schema.Compile(schemaDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("%s schema: %w", name, err)
	}
	filled, issues, err := s.Fill(raw)
	if err != nil {
		return nil, []api.BuildError{{Phase: api.BuildPhaseConfig, Message: fmt.Sprintf("%s: %v", name, err)}}, nil
	}
	errs := make([]api.BuildError, 0, len(issues))
	for _, is := range issues {
		p := is.Path
		if p == "" {
			p = "/"
		}
		errs = append(errs, api.BuildError{Phase: api.BuildPhaseConfig, Message: fmt.Sprintf("%s %s: %s", name, p, is.Message)})
	}
	return filled, errs, nil
}

// ReferencedUploads returns the instance paths of uploadPaths ("*" matches every array item or map
// value) that hold a non-null value in config.
func ReferencedUploads(uploadPaths []string, config json.RawMessage) []string {
	if len(uploadPaths) == 0 || len(config) == 0 {
		return nil
	}
	var doc any
	if err := json.Unmarshal(config, &doc); err != nil {
		return nil
	}
	var out []string
	for _, p := range uploadPaths {
		walkPointer(doc, splitPointer(p), "", func(at string, v any) {
			if v != nil {
				out = append(out, at)
			}
		})
	}
	return out
}

func splitPointer(p string) []string {
	if p == "" {
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	for i, s := range parts {
		parts[i] = strings.NewReplacer("~1", "/", "~0", "~").Replace(s)
	}
	return parts
}

func walkPointer(v any, segs []string, at string, fn func(at string, v any)) {
	if len(segs) == 0 {
		fn(at, v)
		return
	}
	seg, rest := segs[0], segs[1:]
	switch node := v.(type) {
	case map[string]any:
		if seg == "*" {
			for k, child := range node {
				walkPointer(child, rest, at+"/"+escapePointer(k), fn)
			}
			return
		}
		if child, ok := node[seg]; ok {
			walkPointer(child, rest, at+"/"+escapePointer(seg), fn)
		}
	case []any:
		if seg == "*" {
			for i, child := range node {
				walkPointer(child, rest, at+"/"+strconv.Itoa(i), fn)
			}
			return
		}
		if i, err := strconv.Atoi(seg); err == nil && i >= 0 && i < len(node) {
			walkPointer(node[i], rest, at+"/"+seg, fn)
		}
	}
}

func escapePointer(s string) string { return strings.NewReplacer("~", "~0", "/", "~1").Replace(s) }
