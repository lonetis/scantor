package taskpipe

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/build"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/version"
)

const (
	baseRef   = "scantor-base-python:dev"
	baseID    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	builtID   = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	testTag   = "localhost:5000/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
	pushedDig = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
)

// testDescription is the describe output example of docs/tasks.md §7.
const testDescription = `{"protocolVersion":1,"connector":{"language":"python","version":"1.4.0"},` +
	`"schemas":{"taskConfig":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"greeting":{"type":"string","default":"Hello"}},"additionalProperties":false},` +
	`"scanConfig":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false},` +
	`"analysisConfig":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false},` +
	`"result":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"text":{"type":"string"}},"required":["text"]}},` +
	`"schedule":{"kind":"template","template":"single"},` +
	`"secretPaths":{"taskConfig":[],"scanConfig":[],"analysisConfig":[],"result":[]},` +
	`"uploadPaths":{"taskConfig":[],"scanConfig":[]},"fileRefPaths":[],"warnings":["connector warning"]}`

// pipelineEnv is a fake engine with the base image and a build that succeeds, plus describe and check
// containers that succeed.
type pipelineEnv struct {
	docker *fakeDocker
	cfg    Config
	events syncBuffer
	// describe and check script the runtime containers by mode.
	describe, check fakeRun
}

func newPipelineEnv() *pipelineEnv {
	env := &pipelineEnv{docker: newFakeDocker(), cfg: testConfig()}
	env.cfg.BuildTimeout = time.Minute
	env.cfg.DescribeTimeout = time.Minute
	env.cfg.MaxImageBytes = 1 << 30
	env.cfg.BuildCacheMaxBytes = 20 << 30
	env.docker.addImage(image.InspectResponse{ID: baseID, RepoDigests: []string{"scantor-base-python@" + baseID}, RootFS: image.RootFS{Layers: baseLayers}}, baseRef)
	env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
		return []jsonstream.Message{{Stream: "Step 1/3\n"}}, builtImage(nil), false
	}
	env.describe = fakeRun{
		stdout: []string{
			`{"phase":"describe","type":"log","stream":"stderr","text":"importing main.py"}`,
			`not json from user code`,
			`{"phase":"describe","type":"result","description":` + testDescription + `}`,
		},
	}
	env.check = fakeRun{stdout: []string{`{"phase":"check","type":"result","ok":true,"exitCode":0,"skipped":false}`}}
	env.docker.run = func(c *fakeContainer) fakeRun {
		if slices.Contains(c.opts.Config.Entrypoint, container.ModeDescribe) {
			return env.describe
		}
		return env.check
	}
	return env
}

// baseLayers are the layers of the test base image; images built on it start with them.
var baseLayers = []string{"sha256:b1", "sha256:b2"}

func builtImage(labels map[string]string) *image.InspectResponse {
	img := imageWithConfig(builtID, map[string]any{"Labels": labels, "Env": []string{"SCANTOR_DEBUG_PORT=5678"}})
	img.Size, img.Os, img.Architecture = 123<<20, "linux", "arm64"
	img.RootFS = image.RootFS{Type: "layers", Layers: append(slices.Clone(baseLayers), "sha256:task")}
	return &img
}

// imageWithConfig returns an image whose config has the given fields (decoded like ImageInspect does,
// so the test needs no image-spec types).
func imageWithConfig(id string, config map[string]any) image.InspectResponse {
	data, err := json.Marshal(map[string]any{"Id": id, "Config": config})
	if err != nil {
		panic(err)
	}
	var img image.InspectResponse
	if err := json.Unmarshal(data, &img); err != nil {
		panic(err)
	}
	return img
}

func (e *pipelineEnv) pipeline() *Pipeline {
	return New(e.cfg, NewEmitter(&e.events, EventsNDJSON), e.docker, fakeRuntime{})
}

func (e *pipelineEnv) buildTask(t *testing.T, files map[string]string, opts BuildOptions) *Result {
	t.Helper()
	if opts.Tag == "" && opts.TagFunc == nil {
		opts.Tag = testTag
	}
	return e.pipeline().Build(context.Background(), Input{Dir: writeTree(t, files)}, opts)
}

// eventList decodes the emitted events and checks the stream invariants: v 1, consecutive seq, the
// result last.
func (e *pipelineEnv) eventList(t *testing.T) []Event {
	t.Helper()
	var out []Event
	dec := json.NewDecoder(bytes.NewReader(e.events.Bytes()))
	for {
		var ev Event
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	for i, ev := range out {
		if ev.V != 1 || ev.Seq != int64(i) {
			t.Fatalf("event %d: v %d seq %d", i, ev.V, ev.Seq)
		}
		if (ev.Type == EventResult) != (i == len(out)-1) {
			t.Fatalf("the result must be exactly the last event (event %d is %s)", i, ev.Type)
		}
	}
	return out
}

func hasLog(events []Event, phase api.BuildPhase, substr string) bool {
	return slices.ContainsFunc(events, func(ev Event) bool {
		return ev.Type == EventLog && ev.Phase == phase && ev.Text != nil && strings.Contains(*ev.Text, substr)
	})
}

func onlyError(t *testing.T, res *Result, phase api.BuildPhase, substr string) api.BuildError {
	t.Helper()
	if res.OK || len(res.Errors) != 1 || res.Errors[0].Phase != phase || !strings.Contains(res.Errors[0].Message, substr) {
		t.Fatalf("errors = %+v, want one %s error containing %q", res.Errors, phase, substr)
	}
	return res.Errors[0]
}

func TestBuildSuccess(t *testing.T) {
	env := newPipelineEnv()
	files := minimalTask()
	files["Dockerfile"] = testDockerfile + "CMD [\"x\"]\n"
	res := env.buildTask(t, files, BuildOptions{})
	if !res.OK || res.ExitCode() != 0 {
		t.Fatalf("errors: %+v", res.Errors)
	}
	if res.Image == nil || res.Image.Ref != testTag || res.Image.ID != builtID || res.Image.Bytes != 123<<20 ||
		res.Image.Platform != (api.Platform{OS: "linux", Arch: "arm64"}) || res.Image.Digest != "" {
		t.Fatalf("image = %+v", res.Image)
	}
	if *res.BaseImage != (api.ImageRef{Ref: baseRef, Digest: baseID}) {
		t.Fatalf("baseImage = %+v (a local development image is passed by tag)", res.BaseImage)
	}
	if res.Description == nil || res.Description.Connector.Language != "python" || *res.Language != "python" || res.Manifest.Entry != "main.py" {
		t.Fatalf("description %+v language %v", res.Description, res.Language)
	}
	wantWarnings := []string{"Dockerfile:6: CMD is ignored; the runtime is the entrypoint (W1)", "connector warning"}
	if !slices.Equal(res.Warnings, wantWarnings) || !slices.Equal(res.Description.Warnings, wantWarnings) {
		t.Fatalf("warnings %q, description warnings %q", res.Warnings, res.Description.Warnings)
	}
	for _, phase := range []string{"pack", "static", "build", "describe", "check"} {
		if _, ok := res.DurationsMs[phase]; !ok {
			t.Errorf("no duration for %s", phase)
		}
	}

	// The build: BuildKit, the pack as context, only SCANTOR_BASE, no credentials, labels or parent pull.
	d := env.docker
	if len(d.buildOpts) != 1 {
		t.Fatalf("%d builds", len(d.buildOpts))
	}
	bo := d.buildOpts[0]
	if bo.Version != build.BuilderBuildKit || bo.Dockerfile != "Dockerfile" || !slices.Equal(bo.Tags, []string{testTag}) ||
		bo.PullParent || len(bo.AuthConfigs) != 0 || len(bo.Labels) != 0 || bo.BuildID == "" || len(bo.Platforms) != 0 {
		t.Fatalf("build options %+v", bo)
	}
	if len(bo.BuildArgs) != 1 || *bo.BuildArgs["SCANTOR_BASE"] != baseRef {
		t.Fatalf("build args %v", bo.BuildArgs)
	}
	ctxFiles := tarFiles(t, d.buildContexts[0])
	if ctxFiles["main.py"] != "import scantor\n" || len(ctxFiles) != 5 {
		t.Fatalf("build context %v", ctxFiles)
	}
	if len(d.pruned) != 1 || d.pruned[0].MaxUsedSpace != 20<<30 || !d.pruned[0].All {
		t.Fatalf("prune %+v", d.pruned)
	}

	// Describe and check containers (docs/tasks.md §9.5, docs/security.md BLD-10).
	if len(d.containers) != 2 {
		t.Fatalf("%d containers", len(d.containers))
	}
	for i, mode := range []string{container.ModeDescribe, container.ModeCheck} {
		c := d.containers[i]
		cfg, hc := c.opts.Config, c.opts.HostConfig
		if !strings.HasPrefix(c.opts.Name, "scantor-b-") || cfg.Image != builtID {
			t.Errorf("%s: name %s image %s", mode, c.opts.Name, cfg.Image)
		}
		if want := []string{"/scantor/scantor", "runtime", mode, "--entry", "main.py"}; !slices.Equal(cfg.Entrypoint, want) || len(cfg.Cmd) != 0 {
			t.Errorf("%s: entrypoint %v cmd %v", mode, cfg.Entrypoint, cfg.Cmd)
		}
		if !container.IsManaged(container.KindBuild, c.opts.Name, cfg.Labels) || cfg.Labels["traefik.enable"] != "false" {
			t.Errorf("%s: labels %v", mode, cfg.Labels)
		}
		if len(cfg.Env) != 0 {
			t.Errorf("%s: env %v; only the image environment is allowed", mode, cfg.Env)
		}
		if hc.NetworkMode != "none" || hc.Privileged || !slices.Equal(hc.CapDrop, []string{"ALL"}) || len(hc.CapAdd) != 0 ||
			!slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}) || *hc.PidsLimit != 256 ||
			hc.Memory != 1<<30 || hc.NanoCPUs != 1e9 || len(hc.Mounts) != 0 || len(hc.Tmpfs) != 0 {
			t.Errorf("%s: host config %+v", mode, hc)
		}
		if c.opts.NetworkingConfig != nil {
			t.Errorf("%s: networks %+v", mode, c.opts.NetworkingConfig)
		}
		if got := tarFiles(t, c.injected); got["scantor/scantor"] != "#!fake-runtime" {
			t.Errorf("%s: injected %v", mode, got)
		}
		if !c.removed || !c.rmOpts.RemoveVolumes || !c.rmOpts.Force {
			t.Errorf("%s: removed %v %+v", mode, c.removed, c.rmOpts)
		}
	}

	events := env.eventList(t)
	if !hasLog(events, api.BuildPhaseDescribe, "importing main.py") || !hasLog(events, api.BuildPhaseDescribe, "not json from user code") ||
		!hasLog(events, api.BuildPhaseBuild, "Step 1/3") || !hasLog(events, api.BuildPhasePack, "packed 5 files") {
		t.Fatalf("events lack the expected logs: %s", env.events.String())
	}
	last := events[len(events)-1]
	if last.Phase != api.BuildPhaseCheck || !last.Result.OK {
		t.Fatalf("result event %+v", last)
	}
	var phases []api.BuildPhase
	for _, ev := range events {
		if len(phases) == 0 || phases[len(phases)-1] != ev.Phase {
			phases = append(phases, ev.Phase)
		}
	}
	if !slices.IsSortedFunc(phases, func(a, b api.BuildPhase) int { return phaseIndex(a) - phaseIndex(b) }) {
		t.Fatalf("phases out of order: %v", phases)
	}
}

func phaseIndex(p api.BuildPhase) int {
	return slices.Index([]api.BuildPhase{api.BuildPhasePack, api.BuildPhaseStatic, api.BuildPhaseBuild, api.BuildPhaseDescribe, api.BuildPhaseCheck, api.BuildPhasePush}, p)
}

func TestBuildPinsRegistryBaseByDigest(t *testing.T) {
	env := newPipelineEnv()
	env.cfg.Images = version.ImageOverride{Prefix: "ghcr.io/lonetis/", Tag: "1.4.0"}
	ref := "ghcr.io/lonetis/scantor-base-python:1.4.0"
	digest := "sha256:4444444444444444444444444444444444444444444444444444444444444444"
	env.docker.remote[ref] = image.InspectResponse{ID: baseID, RepoDigests: []string{"ghcr.io/lonetis/scantor-base-python@" + digest}}
	env.docker.registry["ghcr.io/lonetis/scantor-base-python@"+digest] = true
	res := env.buildTask(t, minimalTask(), BuildOptions{})
	if !res.OK {
		t.Fatal(res.Errors)
	}
	if !slices.Equal(env.docker.pulls, []string{ref}) {
		t.Fatalf("pulls %v: the absent base image is pulled", env.docker.pulls)
	}
	if got := *env.docker.buildOpts[0].BuildArgs["SCANTOR_BASE"]; got != "ghcr.io/lonetis/scantor-base-python@"+digest {
		t.Fatalf("SCANTOR_BASE = %s", got)
	}
	if *res.BaseImage != (api.ImageRef{Ref: ref, Digest: digest}) {
		t.Fatalf("baseImage = %+v", res.BaseImage)
	}
}

func TestBuildKeepsTheTagOfLocalBaseImages(t *testing.T) {
	// A base image that exists only locally: its repo digest is not served by any registry, so BuildKit
	// could not resolve a digest reference.
	env := newPipelineEnv()
	env.cfg.Images = version.ImageOverride{Prefix: "example/", Tag: "local"}
	ref := "example/scantor-base-python:local"
	env.docker.addImage(image.InspectResponse{ID: baseID, RepoDigests: []string{"example/scantor-base-python@" + baseID}}, ref)
	res := env.buildTask(t, minimalTask(), BuildOptions{})
	if !res.OK || *env.docker.buildOpts[0].BuildArgs["SCANTOR_BASE"] != ref || *res.BaseImage != (api.ImageRef{Ref: ref, Digest: baseID}) {
		t.Fatalf("errors %+v base %+v", res.Errors, res.BaseImage)
	}
	if !slices.Equal(env.docker.distributionChecks, []string{"docker.io/example/scantor-base-python@" + baseID}) {
		t.Fatalf("checks %v", env.docker.distributionChecks)
	}
	// Development images (no registry, no namespace) are never looked up.
	env = newPipelineEnv()
	if res := env.buildTask(t, minimalTask(), BuildOptions{}); !res.OK || len(env.docker.distributionChecks) != 0 {
		t.Fatalf("errors %+v checks %v", res.Errors, env.docker.distributionChecks)
	}
}

func TestBuildBaseImageUnavailable(t *testing.T) {
	env := newPipelineEnv()
	env.cfg.Images = version.ImageOverride{Prefix: "ghcr.io/lonetis/", Tag: "9.9.9"}
	res := env.buildTask(t, minimalTask(), BuildOptions{})
	onlyError(t, res, api.BuildPhasePlatform, "pull the base image")
	if res.ExitCode() != 3 || len(env.docker.buildOpts) != 0 {
		t.Fatalf("exit %d, builds %d", res.ExitCode(), len(env.docker.buildOpts))
	}
}

func TestBuildExternalImages(t *testing.T) {
	files := minimalTask()
	files["Dockerfile"] = "ARG SCANTOR_BASE\nFROM golang:1.27-alpine AS tools\nFROM ${SCANTOR_BASE}\nCOPY --from=tools /usr/local/go/VERSION /V\nCOPY --from=busybox:1.37 /bin/busybox /bb\n"

	t.Run("pulled and inspected", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.remote["golang:1.27-alpine"] = imageWithConfig("sha256:aa", map[string]any{})
		env.docker.addImage(image.InspectResponse{ID: "sha256:bb"}, "busybox:1.37")
		if res := env.buildTask(t, files, BuildOptions{}); !res.OK {
			t.Fatal(res.Errors)
		}
		if !slices.Equal(env.docker.pulls, []string{"golang:1.27-alpine"}) {
			t.Fatalf("pulls %v", env.docker.pulls)
		}
	})
	t.Run("ONBUILD triggers", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.addImage(imageWithConfig("sha256:aa", map[string]any{"OnBuild": []string{"ADD https://x /x"}}), "golang:1.27-alpine")
		env.docker.addImage(image.InspectResponse{ID: "sha256:bb"}, "busybox:1.37")
		res := env.buildTask(t, files, BuildOptions{})
		be := onlyError(t, res, api.BuildPhaseBuild, "golang:1.27-alpine has ONBUILD triggers")
		if be.File != "Dockerfile" || be.Line != 2 || len(env.docker.buildOpts) != 0 {
			t.Fatalf("error %+v, builds %d", be, len(env.docker.buildOpts))
		}
	})
	t.Run("pull failure", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.addImage(image.InspectResponse{ID: "sha256:aa"}, "golang:1.27-alpine")
		res := env.buildTask(t, files, BuildOptions{})
		be := onlyError(t, res, api.BuildPhaseBuild, "cannot pull busybox:1.37")
		if be.File != "Dockerfile" || be.Line != 5 || res.ExitCode() != 2 {
			t.Fatalf("error %+v exit %d", be, res.ExitCode())
		}
	})
}

func TestBuildFailures(t *testing.T) {
	t.Run("build error", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
			return []jsonstream.Message{{Stream: "step\n"}, {Error: &jsonstream.Error{Message: "process \"/bin/sh -c pip install\" did not complete successfully: exit code: 1"}}}, nil, false
		}
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		onlyError(t, res, api.BuildPhaseBuild, "did not complete successfully")
		if res.ExitCode() != 2 || res.Image != nil || len(env.docker.containers) != 0 || len(env.docker.pruned) != 1 {
			t.Fatalf("exit %d image %v containers %d prunes %d", res.ExitCode(), res.Image, len(env.docker.containers), len(env.docker.pruned))
		}
	})
	t.Run("timeout cancels the build", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.BuildTimeout = 50 * time.Millisecond
		env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
			return nil, nil, true
		}
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		onlyError(t, res, api.BuildPhaseBuild, "build exceeded")
		if res.ExitCode() != 2 || !slices.Equal(env.docker.cancelled, []string{env.docker.buildOpts[0].BuildID}) {
			t.Fatalf("exit %d cancelled %v", res.ExitCode(), env.docker.cancelled)
		}
	})
	t.Run("image too large", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.MaxImageBytes = 100 << 20
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		onlyError(t, res, api.BuildPhaseBuild, "SCANTOR_MAX_IMAGE_BYTES")
		if !slices.Equal(env.docker.removedImages, []string{testTag}) {
			t.Fatalf("removed %v: a rejected image is removed", env.docker.removedImages)
		}
	})
	t.Run("forbidden effective label", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
			return nil, builtImage(map[string]string{"Traefik.HTTP.routers.x.rule": "Host(`a`)", "org.opencontainers.image.title": "x"}), false
		}
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		onlyError(t, res, api.BuildPhaseBuild, `"Traefik.HTTP.routers.x.rule"`)
		if len(env.docker.removedImages) != 1 || len(env.docker.containers) != 0 {
			t.Fatal("a labelled image must be removed and never described")
		}
	})
	t.Run("no docker", func(t *testing.T) {
		var events bytes.Buffer
		res := New(testConfig(), NewEmitter(&events, EventsNDJSON), nil, nil).Build(context.Background(), Input{Dir: t.TempDir()}, BuildOptions{Tag: "x"})
		onlyError(t, res, api.BuildPhasePlatform, "Docker")
	})
	t.Run("static errors stop the pipeline", func(t *testing.T) {
		env := newPipelineEnv()
		files := minimalTask()
		files["Dockerfile"] = "FROM alpine\n"
		res := env.buildTask(t, files, BuildOptions{})
		if res.OK || res.Errors[0].Phase != api.BuildPhaseStatic || len(env.docker.buildOpts) != 0 || res.Image != nil {
			t.Fatalf("errors %+v builds %d", res.Errors, len(env.docker.buildOpts))
		}
	})
	t.Run("interrupted", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
			return nil, nil, true
		}
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(50*time.Millisecond, cancel)
		res := env.pipeline().Build(ctx, Input{Dir: writeTree(t, minimalTask())}, BuildOptions{Tag: testTag})
		onlyError(t, res, api.BuildPhasePlatform, "interrupted")
		if res.ExitCode() != 3 || len(env.docker.cancelled) != 1 {
			t.Fatalf("exit %d cancelled %v", res.ExitCode(), env.docker.cancelled)
		}
	})
}

func TestBuildReuseExisting(t *testing.T) {
	env := newPipelineEnv()
	env.docker.addImage(*builtImage(nil), "tasks/x:draft-abc")
	res := env.buildTask(t, minimalTask(), BuildOptions{Tag: "tasks/x:draft-abc", ReuseExisting: true, SkipCheck: true})
	if !res.OK || len(env.docker.buildOpts) != 0 || res.Image.ID != builtID || res.Description == nil {
		t.Fatalf("ok %v builds %d image %+v errors %+v", res.OK, len(env.docker.buildOpts), res.Image, res.Errors)
	}
	if len(env.docker.containers) != 1 {
		t.Fatalf("%d containers: describe runs, the check is skipped", len(env.docker.containers))
	}
	if _, ok := res.DurationsMs["check"]; ok {
		t.Fatal("a skipped check has no duration")
	}

	if res.BaseImage == nil || res.BaseImage.Ref != baseRef || res.BaseImage.Digest != baseID {
		t.Fatalf("a reused image records its base image: %+v", res.BaseImage)
	}

	env = newPipelineEnv()
	if res := env.buildTask(t, minimalTask(), BuildOptions{Tag: "tasks/x:draft-new", ReuseExisting: true}); !res.OK || len(env.docker.buildOpts) != 1 {
		t.Fatalf("an absent image is built: %+v", res.Errors)
	}

	// A draft built on an earlier base image (before an upgrade) is rebuilt on the current one.
	env = newPipelineEnv()
	stale := builtImage(nil)
	stale.ID = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
	stale.RootFS.Layers = []string{"sha256:old-base", "sha256:task"}
	env.docker.addImage(*stale, "tasks/x:draft-abc")
	res = env.buildTask(t, minimalTask(), BuildOptions{Tag: "tasks/x:draft-abc", ReuseExisting: true, SkipCheck: true})
	if !res.OK || len(env.docker.buildOpts) != 1 || res.Image.ID != builtID || !hasLog(env.eventList(t), api.BuildPhaseBuild, "another base image") {
		t.Fatalf("ok %v builds %d image %+v", res.OK, len(env.docker.buildOpts), res.Image)
	}
}

func TestBuiltOn(t *testing.T) {
	for _, tt := range []struct {
		image, base []string
		want        bool
	}{
		{[]string{"a", "b", "c"}, []string{"a", "b"}, true},
		{[]string{"a", "b"}, []string{"a", "b"}, true},
		{[]string{"x", "b", "c"}, []string{"a", "b"}, false},
		{[]string{"a"}, []string{"a", "b"}, false},
		{[]string{"a"}, nil, false},
	} {
		if got := builtOn(tt.image, tt.base); got != tt.want {
			t.Errorf("builtOn(%v, %v) = %v", tt.image, tt.base, got)
		}
	}
}

func TestDescribeFailures(t *testing.T) {
	tests := []struct {
		name     string
		describe fakeRun
		timeout  time.Duration
		want     string
		lang     string
	}{
		{
			name: "connector error",
			describe: fakeRun{code: 2, stdout: []string{
				`{"phase":"describe","type":"error","error":{"phase":"describe","file":"/task/main.py","line":3,"message":"ImportError: no module named x"}}`,
			}},
			want: "ImportError",
		},
		{
			name:     "exit without error events",
			describe: fakeRun{code: 2, stderr: []string{"panic: boom"}},
			want:     "panic: boom",
		},
		{
			name:     "no description",
			describe: fakeRun{stdout: []string{`{"phase":"describe","type":"log","text":"x"}`}},
			want:     "no description",
		},
		{
			name:     "invalid description",
			describe: fakeRun{stdout: []string{`{"phase":"describe","type":"result","description":{"protocolVersion":1}}`}},
			want:     "invalid describe output",
		},
		{
			name:     "language mismatch",
			describe: fakeRun{stdout: []string{`{"phase":"describe","type":"result","description":` + strings.Replace(testDescription, `"language":"python"`, `"language":"go"`, 1) + `}`}},
			want:     "the manifest language is python",
		},
		{
			name:     "timeout",
			describe: fakeRun{hang: true},
			timeout:  50 * time.Millisecond,
			want:     "describe exceeded",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newPipelineEnv()
			env.describe = tt.describe
			if tt.timeout > 0 {
				env.cfg.DescribeTimeout = tt.timeout
			}
			res := env.buildTask(t, minimalTask(), BuildOptions{})
			be := onlyError(t, res, api.BuildPhaseDescribe, tt.want)
			if tt.name == "connector error" && (be.File != "main.py" || be.Line != 3) {
				t.Fatalf("location %+v: /task/ is stripped", be)
			}
			if res.ExitCode() != 2 || res.Description != nil || len(env.docker.containers) != 1 || !env.docker.containers[0].removed {
				t.Fatalf("exit %d description %v containers %d", res.ExitCode(), res.Description, len(env.docker.containers))
			}
		})
	}
}

// Describe output is untrusted like check output: forged error lines past the cap are counted, not
// kept, so the result stays below the orchestrator's event line limit.
func TestDescribeErrorCap(t *testing.T) {
	env := newPipelineEnv()
	message := strings.Repeat("x", MaxErrorMessage)
	var lines []string
	for range MaxContainerErrors + 300 {
		lines = append(lines, `{"phase":"describe","type":"error","error":{"phase":"describe","message":"`+message+`"}}`)
	}
	env.describe = fakeRun{code: 1, stdout: lines}
	res := env.buildTask(t, minimalTask(), BuildOptions{})
	if len(res.Errors) != MaxContainerErrors || res.Errors[0].Phase != api.BuildPhaseDescribe || res.Description != nil {
		t.Fatalf("%d errors, description %v", len(res.Errors), res.Description)
	}
	if !hasLog(env.eventList(t), api.BuildPhaseDescribe, "300 more diagnostics") || res.ExitCode() != 2 {
		t.Fatal("dropped describe errors are counted")
	}
}

func TestCheckPhase(t *testing.T) {
	t.Run("diagnostics", func(t *testing.T) {
		env := newPipelineEnv()
		var lines []string
		for i := range MaxContainerErrors + 50 {
			lines = append(lines, fmt.Sprintf(`{"phase":"check","type":"error","error":{"phase":"check","file":"main.py","line":%d,"column":2,"message":"bad"}}`, i+1))
		}
		lines = append(lines, `{"phase":"check","type":"result","ok":false,"exitCode":1,"skipped":false}`)
		env.check = fakeRun{code: 2, stdout: lines}
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		if len(res.Errors) != MaxContainerErrors || res.Errors[0] != (api.BuildError{Phase: api.BuildPhaseCheck, File: "main.py", Line: 1, Column: 2, Message: "bad"}) {
			t.Fatalf("%d errors, first %+v", len(res.Errors), res.Errors[0])
		}
		if !hasLog(env.eventList(t), api.BuildPhaseCheck, "50 more diagnostics") || res.ExitCode() != 2 {
			t.Fatal("dropped diagnostics are counted")
		}
	})
	t.Run("failure without diagnostics", func(t *testing.T) {
		env := newPipelineEnv()
		env.check = fakeRun{code: 2, stdout: []string{`{"phase":"check","type":"result","ok":false,"exitCode":3,"skipped":false}`}}
		onlyError(t, env.buildTask(t, minimalTask(), BuildOptions{}), api.BuildPhaseCheck, "exit code 3")
	})
	t.Run("skipped", func(t *testing.T) {
		env := newPipelineEnv()
		env.check = fakeRun{stdout: []string{`{"phase":"check","type":"result","ok":true,"exitCode":0,"skipped":true}`}}
		if res := env.buildTask(t, minimalTask(), BuildOptions{}); !res.OK || !hasLog(env.eventList(t), api.BuildPhaseCheck, "skipped") {
			t.Fatal(res.Errors)
		}
	})
	t.Run("hostile locations are dropped", func(t *testing.T) {
		env := newPipelineEnv()
		env.check = fakeRun{code: 2, stdout: []string{
			`{"phase":"build","type":"error","error":{"phase":"push","file":"../../etc/passwd","line":-4,"message":""}}`,
			`{"phase":"check","type":"result","ok":false,"exitCode":1}`,
		}}
		res := env.buildTask(t, minimalTask(), BuildOptions{})
		if res.Errors[0] != (api.BuildError{Phase: api.BuildPhaseCheck, Message: "error"}) {
			t.Fatalf("error %+v", res.Errors[0])
		}
	})
}

func TestPush(t *testing.T) {
	pushMsgs := []jsonstream.Message{{Status: "Pushed"}, {Aux: rawJSON(`{"Tag":"c1d2","Digest":"` + pushedDig + `","Size":525}`)}}

	t.Run("gate and digest", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.RegistryPushPassword = "derived-password"
		env.docker.pushMsgs = pushMsgs
		gateR, gateW := io.Pipe()
		done := make(chan *Result, 1)
		go func() {
			done <- env.pipeline().Build(context.Background(), Input{Dir: writeTree(t, minimalTask())}, BuildOptions{Tag: testTag, Push: true, PushGate: gateR})
		}()
		deadline := time.Now().Add(5 * time.Second)
		for !strings.Contains(syncString(env), PushGateWaiting) {
			if time.Now().After(deadline) {
				t.Fatal("no push gate event")
			}
			time.Sleep(5 * time.Millisecond)
		}
		if n := pushCount(env); n != 0 {
			t.Fatal("pushed before the gate opened")
		}
		if _, err := io.WriteString(gateW, "push\n"); err != nil {
			t.Fatal(err)
		}
		res := <-done
		if !res.OK {
			t.Fatal(res.Errors)
		}
		img := res.Image
		if img.Repository != "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c" || img.Tag != "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f" || img.Digest != pushedDig {
			t.Fatalf("image %+v", img)
		}
		push := env.docker.pushes[0]
		auth, err := base64.URLEncoding.DecodeString(push.Opts.RegistryAuth)
		if err != nil {
			t.Fatal(err)
		}
		var cred struct{ Username, Password, ServerAddress string }
		if err := json.Unmarshal(auth, &cred); err != nil {
			t.Fatal(err)
		}
		if push.Ref != testTag || cred.Username != "orchestrator" || cred.Password != "derived-password" || cred.ServerAddress != "localhost:5000" {
			t.Fatalf("push %s with %+v", push.Ref, cred)
		}
		if _, ok := res.DurationsMs["push"]; !ok {
			t.Fatal("no push duration")
		}
	})
	for _, gate := range []string{"", "abort\n"} {
		t.Run(fmt.Sprintf("gate %q closes", gate), func(t *testing.T) {
			env := newPipelineEnv()
			env.cfg.RegistryPushPassword = "p"
			env.docker.pushMsgs = pushMsgs
			res := env.buildTask(t, minimalTask(), BuildOptions{Push: true, PushGate: strings.NewReader(gate)})
			onlyError(t, res, api.BuildPhasePush, "push gate closed")
			if res.ExitCode() != 3 || len(env.docker.pushes) != 0 || res.Image != nil {
				t.Fatalf("exit %d pushes %d", res.ExitCode(), len(env.docker.pushes))
			}
		})
	}
	t.Run("without the credential", func(t *testing.T) {
		env := newPipelineEnv()
		res := env.buildTask(t, minimalTask(), BuildOptions{Push: true})
		onlyError(t, res, api.BuildPhasePlatform, "SCANTOR_REGISTRY_PUSH_PASSWORD")
		if res.ExitCode() != 3 || len(env.docker.buildOpts) != 0 || res.Pack != nil {
			t.Fatal("--push without the credential fails at start")
		}
	})
	for _, tag := range []string{"tasks/x:y", "docker.io/tasks/x:y", "localhost:5000/other/x:y", "localhost:5000/tasks/x"} {
		t.Run("rejects "+tag, func(t *testing.T) {
			env := newPipelineEnv()
			env.cfg.RegistryPushPassword = "p"
			res := env.buildTask(t, minimalTask(), BuildOptions{Tag: tag, Push: true})
			onlyError(t, res, api.BuildPhasePlatform, "<registry host>/tasks/")
			if len(env.docker.buildOpts) != 0 {
				t.Fatal("the target is checked before anything is built")
			}
		})
	}
	t.Run("registry error", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.RegistryPushPassword = "p"
		env.docker.pushMsgs = []jsonstream.Message{{Error: &jsonstream.Error{Message: "denied: requested access to the resource is denied"}}}
		res := env.buildTask(t, minimalTask(), BuildOptions{Push: true})
		onlyError(t, res, api.BuildPhasePush, "denied")
		if res.ExitCode() != 3 {
			t.Fatal("push failures exit 3")
		}
	})
	t.Run("digest from the status line", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.RegistryPushPassword = "p"
		env.docker.pushMsgs = []jsonstream.Message{
			{Status: "Pushed", ID: "44136fa355b3"},
			{Status: "other-tag: digest: sha256:" + strings.Repeat("9", 64) + " size: 1"},
			{Status: "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f: digest: " + pushedDig + " size: 855"},
		}
		res := env.buildTask(t, minimalTask(), BuildOptions{Push: true})
		if !res.OK || res.Image.Digest != pushedDig {
			t.Fatalf("errors %+v image %+v", res.Errors, res.Image)
		}
	})
	t.Run("no digest", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.RegistryPushPassword = "p"
		env.docker.pushMsgs = []jsonstream.Message{{Status: "Pushed"}}
		onlyError(t, env.buildTask(t, minimalTask(), BuildOptions{Push: true}), api.BuildPhasePush, "no digest")
	})
}

func rawJSON(s string) *json.RawMessage {
	r := json.RawMessage(s)
	return &r
}

func syncString(env *pipelineEnv) string { return env.events.String() }

// syncBuffer is a bytes.Buffer safe for a writer and a concurrent reader.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buf.Bytes())
}

func (b *syncBuffer) String() string { return string(b.Bytes()) }

func pushCount(env *pipelineEnv) int {
	env.docker.mu.Lock()
	defer env.docker.mu.Unlock()
	return len(env.docker.pushes)
}

func TestPackAndCheckStaticCommands(t *testing.T) {
	var events bytes.Buffer
	p := New(testConfig(), NewEmitter(&events, EventsNDJSON), nil, nil)
	var archive bytes.Buffer
	res := p.Pack(context.Background(), Input{Dir: writeTree(t, minimalTask())}, &archive)
	if !res.OK || res.Pack == nil || int64(archive.Len()) != res.Pack.PackBytes || res.Manifest != nil {
		t.Fatalf("pack %+v (%d bytes)", res, archive.Len())
	}
	res2 := p.CheckStatic(context.Background(), Input{Archive: &archive}, StaticOptions{ExpectName: "echo"})
	if !res2.OK || res2.Pack.PackSHA256 != res.Pack.PackSHA256 || res2.SettingsDefaults == nil || *res2.Privileged {
		t.Fatalf("check-static %+v", res2)
	}
	res3 := p.CheckStatic(context.Background(), Input{Archive: strings.NewReader("garbage")}, StaticOptions{})
	onlyError(t, res3, api.BuildPhasePack, "not a valid tar.gz")
	res4 := p.Pack(context.Background(), Input{}, nil)
	onlyError(t, res4, api.BuildPhasePlatform, "either a folder or a pack")
}
