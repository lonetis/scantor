//go:build integration

package taskpipe_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/cli"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
	"github.com/lonetis/scantor/internal/version"
)

// The integration tests need the host Docker socket (just test-go-integration). Images they create are
// named <name-prefix>…; the pipeline's own describe, check and local-mode containers are removed by the
// pipeline itself.

var (
	namePrefix  = flag.String("name-prefix", "scantor-test-", "prefix of the images and containers the integration tests create")
	basePrefix  = flag.String("base-image-prefix", "", "SCANTOR_IMAGE_PREFIX of the Python base image (<prefix>scantor-base-python:<tag>)")
	baseTag     = flag.String("base-image-tag", "dev", "SCANTOR_IMAGE_TAG of the Python base image")
	runtimeMode = flag.String("runtime", "auto", "runtime injected into describe, check and local-mode containers: auto (this tree's runtime when it has one, else the stub), real or stub")
)

const fixtureBase = "alpine:3.24"

// moduleRoot is the repository root relative to this package.
const moduleRoot = "../.."

func dockerClient(t *testing.T) *client.Client {
	t.Helper()
	c, err := container.NewClient(version.UserAgent("scantor-test"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ping(context.Background(), client.PingOptions{}); err != nil {
		t.Skipf("no Docker daemon: %v", err)
	}
	return c
}

// fileRuntime injects a binary from a file.
type fileRuntime string

func (f fileRuntime) Resolve(context.Context) (*container.Binary, error) {
	return container.LoadBinary(string(f))
}

// buildLinux cross-compiles pkg for the daemon's architecture.
func buildLinux(t *testing.T, c client.APIClient, pkg string) fileRuntime {
	t.Helper()
	_, arch, err := container.DaemonPlatform(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "scantor")
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, pkg)
	cmd.Dir = moduleRoot
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build %s: %v\n%s", pkg, err, b)
	}
	return fileRuntime(out)
}

// hasRealRuntime reports whether this tree registers `scantor runtime describe`.
func hasRealRuntime() bool {
	cmd, _, err := cli.NewRootCommand().Find([]string{"runtime", "describe"})
	return err == nil && cmd.Name() == "describe"
}

// taskRuntime returns the runtime for tests that need a real connector, and whether it is the real one.
func taskRuntime(t *testing.T, c client.APIClient) (fileRuntime, bool) {
	t.Helper()
	real := *runtimeMode == "real" || (*runtimeMode == "auto" && hasRealRuntime())
	if real {
		return buildLinux(t, c, "./cmd/scantor"), true
	}
	t.Log("using the stub runtime: this tree has no `scantor runtime describe` yet")
	return stubRuntime(t, c), false
}

func stubRuntime(t *testing.T, c client.APIClient) fileRuntime {
	return buildLinux(t, c, "./internal/taskpipe/testdata/stubruntime")
}

func pipelineConfig(images version.ImageOverride) taskpipe.Config {
	return taskpipe.Config{
		Pack:            taskpipe.PackLimits{MaxFiles: 5000, MaxBytes: 200 << 20, MaxPackBytes: 50 << 20},
		ManifestLimits:  manifest.DefaultLimits(),
		Images:          images,
		BuildTimeout:    10 * time.Minute,
		DescribeTimeout: 10 * time.Minute,
		MaxImageBytes:   10 << 30,
		PublicURL:       "http://localhost:3000",
	}
}

func removeImage(t *testing.T, c client.APIClient, ref string) {
	t.Cleanup(func() {
		if _, err := c.ImageRemove(context.Background(), ref, client.ImageRemoveOptions{Force: true, PruneChildren: true}); err != nil && !container.IsNotFound(err) {
			t.Errorf("remove %s: %v", ref, err)
		}
	})
}

// buildFixture builds an image from a Dockerfile (context: the Dockerfile only).
func buildFixture(t *testing.T, c client.APIClient, tag, dockerfile string) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.ImageInspect(ctx, fixtureBase); err != nil {
		if err := container.Pull(ctx, c, fixtureBase, container.PullOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(dockerfile))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(dockerfile)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	removeImage(t, c, tag)
	resp, err := c.ImageBuild(ctx, &buf, client.ImageBuildOptions{Tags: []string{tag}, Remove: true})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte(`"error"`)) || bytes.Contains(body, []byte(`"errorDetail"`)) {
		t.Fatalf("build %s: %s", tag, body)
	}
}

// plainBase builds a minimal base image that honours the ENV contract without a connector (for tests
// that use the stub runtime) and returns the image override that selects it.
func plainBase(t *testing.T, c client.APIClient, labels string) version.ImageOverride {
	t.Helper()
	images := version.ImageOverride{Prefix: *namePrefix, Tag: "fixture-" + uuid.NewString()[:8]}
	dockerfile := "FROM " + fixtureBase + "\nENV SCANTOR_LANGUAGE=python SCANTOR_CONNECTOR_CMD=\"python -m scantor.serve {entry}\" SCANTOR_CHECK_CMD=\"\"\nWORKDIR /task\n"
	if labels != "" {
		dockerfile += "LABEL " + labels + "\n"
	}
	buildFixture(t, c, version.ImageRef("scantor-base-python", images), dockerfile)
	return images
}

func writeTask(t *testing.T, dockerfile string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range map[string]string{
		"scantor.yaml":  "scantor: 1\nname: fixture\nlanguage: python\n",
		"Dockerfile":    dockerfile,
		"main.py":       "print('hi')\n",
		".dockerignore": ".git/\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const plainDockerfile = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n"

type run struct {
	events bytes.Buffer
	res    *taskpipe.Result
}

func build(t *testing.T, c client.APIClient, cfg taskpipe.Config, rt taskpipe.RuntimeResolver, dir string, opts taskpipe.BuildOptions) *run {
	t.Helper()
	r := &run{}
	if opts.Tag != "" {
		removeImage(t, c, opts.Tag)
	}
	r.res = taskpipe.New(cfg, taskpipe.NewEmitter(&r.events, taskpipe.EventsText), c, rt).Build(context.Background(), taskpipe.Input{Dir: dir}, opts)
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("pipeline events:\n%s", r.events.String())
		}
	})
	return r
}

func onlyError(t *testing.T, res *taskpipe.Result, phase api.BuildPhase, substr string) api.BuildError {
	t.Helper()
	if res.OK || len(res.Errors) != 1 || res.Errors[0].Phase != phase || !strings.Contains(res.Errors[0].Message, substr) {
		t.Fatalf("errors %+v, want one %s error containing %q", res.Errors, phase, substr)
	}
	return res.Errors[0]
}

// TestIntegrationBuildEcho builds tasks/echo on the Python base image: pack, static checks, BuildKit
// build, describe and type check, then runs it in local mode.
func TestIntegrationBuildEcho(t *testing.T) {
	c := dockerClient(t)
	images := version.ImageOverride{Prefix: *basePrefix, Tag: *baseTag}
	base := version.ImageRef("scantor-base-python", images)
	if _, err := c.ImageInspect(context.Background(), base); err != nil {
		t.Skipf("the Python base image %s is not available (docker buildx bake --load base-python, or -base-image-prefix/-base-image-tag): %v", base, err)
	}
	rt, real := taskRuntime(t, c)
	tag := *namePrefix + "echo:" + uuid.NewString()[:8]
	r := build(t, c, pipelineConfig(images), rt, filepath.Join(moduleRoot, "tasks", "echo"), taskpipe.BuildOptions{Tag: tag, ExpectName: "echo"})
	res := r.res
	if !res.OK {
		t.Fatalf("errors: %+v", res.Errors)
	}
	_, arch, err := container.DaemonPlatform(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if res.Image.Platform.OS != "linux" || res.Image.Platform.Arch != arch || res.Image.Bytes == 0 || res.BaseImage.Ref != base {
		t.Fatalf("image %+v base %+v", res.Image, res.BaseImage)
	}
	if res.Description.Connector.Language != "python" || *res.Language != "python" {
		t.Fatalf("description %+v", res.Description)
	}
	text := r.events.String()
	for _, want := range []string{"[build] #", "[describe]", "[check]", "[result] ok: image " + tag} {
		if !strings.Contains(text, want) {
			t.Errorf("events lack %q", want)
		}
	}
	if real {
		if res.Description.Schedule.Template != "single" || !strings.Contains(string(res.Description.Schemas.Result), "echo") {
			t.Errorf("description %+v", res.Description)
		}
	} else if !strings.Contains(text, "interfaces up: lo\n") {
		t.Errorf("describe and check containers must have network none:\n%s", text)
	}

	// Local mode (scantor dev run): the spec is copied in, /scantor/out copied out.
	input := json.RawMessage(`{}`) // the stub describes empty configs
	if real {
		input = json.RawMessage(`{"text":"hi"}`)
	}
	taskConfig, issues, err := taskpipe.EffectiveConfig("taskConfig", res.Description.Schemas.TaskConfig, input)
	if err != nil || len(issues) != 0 {
		t.Fatalf("config: %v %v", err, issues)
	}
	spec := taskpipe.LocalSpec{
		V: taskpipe.LocalSpecVersion, RunID: taskpipe.LocalRunID, Entry: res.Manifest.Entry,
		TaskConfig: taskConfig, ScanConfig: json.RawMessage(`{}`), Limit: 5, Processes: 1,
		TimeoutMs: res.SettingsDefaults.TimeoutMs, MaxAttempts: 1, Backoff: res.SettingsDefaults.Backoff,
		MaxAnalysesPerProcess: res.SettingsDefaults.MaxAnalysesPerProcess,
		DataSources:           api.DataSources{Tranco: cli.DefaultTrancoURL, Crux: cli.DefaultCruxURL, CruxCache: cli.DefaultCruxCacheURL},
		Uploads:               map[string]taskpipe.LocalUpload{}, Resolved: map[string]json.RawMessage{},
		Limits: taskpipe.DefaultLocalLimits(), OutDir: taskpipe.LocalOutDir,
	}
	var lines []string
	outDir := filepath.Join(t.TempDir(), "out")
	lr, err := taskpipe.LocalRun{
		Docker: c, Runtime: rt, Image: res.Image.ID, Spec: spec, Resources: res.SettingsDefaults.Resources, OutDir: outDir,
		OnEvent: func(b []byte) { lines = append(lines, string(b)) }, OnStderr: func(b []byte) { t.Logf("runtime: %s", b) },
	}.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if lr.ExitCode != 0 || len(lines) == 0 {
		t.Fatalf("local run: %+v\n%s", lr, strings.Join(lines, "\n"))
	}
	last, err := taskpipe.ParseLocalEvent([]byte(lines[len(lines)-1]))
	if err != nil || last.Type != taskpipe.LocalEventEnd || last.Summary.Succeeded != 1 {
		t.Fatalf("last event %+v %v", last, err)
	}
	if real {
		if !strings.Contains(strings.Join(lines, "\n"), `"echo":"hi"`) {
			t.Errorf("events:\n%s", strings.Join(lines, "\n"))
		}
	} else {
		data, err := os.ReadFile(filepath.Join(outDir, "files", "0", "f1", "hello.txt"))
		if err != nil || string(data) != `{}` {
			t.Fatalf("copied file %q %v", data, err)
		}
	}
}

// TestIntegrationInheritedLabels checks the post-build label check (docs/security.md LBL-3): labels a
// base image brings in pass the static policy but fail the build phase, and the image is removed.
func TestIntegrationInheritedLabels(t *testing.T) {
	c := dockerClient(t)
	images := plainBase(t, c, "traefik.enable=true com.docker.compose.project=scantor")
	tag := *namePrefix + "labels:" + uuid.NewString()[:8]
	r := build(t, c, pipelineConfig(images), stubRuntime(t, c), writeTask(t, plainDockerfile), taskpipe.BuildOptions{Tag: tag})
	if r.res.OK || len(r.res.Errors) != 2 {
		t.Fatalf("errors %+v", r.res.Errors)
	}
	for _, e := range r.res.Errors {
		if e.Phase != api.BuildPhaseBuild || !strings.Contains(e.Message, "reserved") {
			t.Fatalf("error %+v", e)
		}
	}
	if _, err := c.ImageInspect(context.Background(), tag); !container.IsNotFound(err) {
		t.Fatalf("the rejected image still exists: %v", err)
	}
	if r.res.BaseImage == nil || r.res.BaseImage.Ref != version.ImageRef("scantor-base-python", images) {
		t.Fatalf("base %+v", r.res.BaseImage)
	}
}

// TestIntegrationOnbuildImage checks docs/security.md BLD-7: an external image with ONBUILD triggers
// fails the build phase before anything is built.
func TestIntegrationOnbuildImage(t *testing.T) {
	c := dockerClient(t)
	images := plainBase(t, c, "")
	onbuild := *namePrefix + "onbuild:" + uuid.NewString()[:8]
	buildFixture(t, c, onbuild, "FROM "+fixtureBase+"\nONBUILD RUN echo triggered\n")
	tag := *namePrefix + "uses-onbuild:" + uuid.NewString()[:8]
	r := build(t, c, pipelineConfig(images), stubRuntime(t, c), writeTask(t, "ARG SCANTOR_BASE\nFROM "+onbuild+" AS tools\nFROM ${SCANTOR_BASE}\nCOPY --from=tools /etc/alpine-release /x\n"), taskpipe.BuildOptions{Tag: tag})
	be := onlyError(t, r.res, api.BuildPhaseBuild, "ONBUILD")
	if be.File != "Dockerfile" || be.Line != 2 {
		t.Fatalf("error %+v", be)
	}
	if _, err := c.ImageInspect(context.Background(), tag); !container.IsNotFound(err) {
		t.Fatal("nothing may be built")
	}
}

// TestIntegrationLimits checks the build timeout (the build is cancelled) and the image size cap
// (docs/security.md BLD-9).
func TestIntegrationLimits(t *testing.T) {
	c := dockerClient(t)
	images := plainBase(t, c, "")
	rt := stubRuntime(t, c)

	cfg := pipelineConfig(images)
	cfg.BuildTimeout = 3 * time.Second
	start := time.Now()
	r := build(t, c, cfg, rt, writeTask(t, plainDockerfile+"RUN sleep 120\n"), taskpipe.BuildOptions{Tag: *namePrefix + "slow:" + uuid.NewString()[:8]})
	onlyError(t, r.res, api.BuildPhaseBuild, "build exceeded 3s")
	if d := time.Since(start); d > time.Minute {
		t.Fatalf("the timed-out build took %s", d)
	}

	cfg = pipelineConfig(images)
	cfg.MaxImageBytes = 1 << 20
	tag := *namePrefix + "big:" + uuid.NewString()[:8]
	r = build(t, c, cfg, rt, writeTask(t, plainDockerfile), taskpipe.BuildOptions{Tag: tag})
	onlyError(t, r.res, api.BuildPhaseBuild, "SCANTOR_MAX_IMAGE_BYTES")
}

// TestIntegrationPush pushes through the push gate to a throwaway registry and records the digest. The
// registry runs in the daemon's network namespace on a loopback port, the way the platform registry is
// reached as localhost:${SCANTOR_REGISTRY_PORT} (on Docker Desktop that is the VM, not the host).
func TestIntegrationPush(t *testing.T) {
	c := dockerClient(t)
	const registryImage = "registry:3.1.2"
	ctx := context.Background()
	if _, err := c.ImageInspect(ctx, registryImage); err != nil {
		t.Skipf("%s is not available locally: %v", registryImage, err)
	}
	port := 40000 + time.Now().Nanosecond()%10000
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	created, err := c.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:       *namePrefix + "registry-" + uuid.NewString()[:8],
		Config:     &containertypes.Config{Image: registryImage, Env: []string{"REGISTRY_HTTP_ADDR=" + addr}},
		HostConfig: &containertypes.HostConfig{NetworkMode: "host"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := c.ContainerRemove(context.Background(), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil {
			t.Errorf("remove the registry: %v", err)
		}
	})
	if _, err := c.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	waitForLog(t, c, created.ID, "listening on")

	taskID, revisionID := uuid.NewString(), uuid.NewString()
	// 127.0.0.1 rather than localhost: the daemon may resolve localhost to ::1. Loopback registries are
	// plain HTTP for the daemon.
	tag := addr + "/tasks/" + taskID + ":" + revisionID
	cfg := pipelineConfig(plainBase(t, c, ""))
	cfg.RegistryPushPassword = "derived-password"
	r := build(t, c, cfg, stubRuntime(t, c), writeTask(t, plainDockerfile), taskpipe.BuildOptions{Tag: tag, Push: true, PushGate: strings.NewReader("push\n")})
	if !r.res.OK {
		t.Fatalf("errors %+v", r.res.Errors)
	}
	img := r.res.Image
	if img.Repository != "tasks/"+taskID || img.Tag != revisionID || !strings.HasPrefix(img.Digest, "sha256:") {
		t.Fatalf("image %+v", img)
	}
	if !strings.Contains(r.events.String(), taskpipe.PushGateWaiting) {
		t.Fatal("no push gate event")
	}
	dist, err := c.DistributionInspect(ctx, addr+"/tasks/"+taskID+"@"+img.Digest, client.DistributionInspectOptions{})
	if err != nil {
		t.Fatalf("the registry has no manifest %s: %v", img.Digest, err)
	}
	if dist.Descriptor.Digest.String() != img.Digest {
		t.Fatalf("registry digest %s, recorded %s", dist.Descriptor.Digest, img.Digest)
	}
}

func waitForLog(t *testing.T, c client.APIClient, id, text string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		logs, err := c.ContainerLogs(context.Background(), id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(logs)
		_ = logs.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(text)) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the registry did not start:\n%s", data)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// TestIntegrationBuildScript builds a script folder on a plain base image: pack, the static checks of
// scantor-script.yaml and the BuildKit build, without describe, check, push or a runtime binary. A
// second build of the unchanged folder with --reuse-existing reuses the local image.
func TestIntegrationBuildScript(t *testing.T) {
	c := dockerClient(t)
	images := plainBase(t, c, "")
	dir := t.TempDir()
	for name, content := range map[string]string{
		"scantor-script.yaml": "scantor: 1\nname: fixture\nlanguage: python\ndefaults:\n  resources:\n    cpus: 2\n",
		"Dockerfile":          plainDockerfile,
		"main.py":             "print('hi')\n",
		".dockerignore":       ".git/\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tag := *namePrefix + "script:" + uuid.NewString()[:8]
	removeImage(t, c, tag)
	buildScript := func() (*taskpipe.ScriptResult, string) {
		t.Helper()
		var events bytes.Buffer
		opts := taskpipe.ScriptBuildOptions{ScriptStaticOptions: taskpipe.ScriptStaticOptions{ExpectName: "fixture"}, Tag: tag, ReuseExisting: true}
		res := taskpipe.New(pipelineConfig(images), taskpipe.NewEmitter(&events, taskpipe.EventsText), c, nil).BuildScript(context.Background(), taskpipe.Input{Dir: dir}, opts)
		if !res.OK {
			t.Fatalf("errors %+v\n%s", res.Errors, events.String())
		}
		return res, events.String()
	}

	res, text := buildScript()
	inspect, err := c.ImageInspect(context.Background(), tag)
	if err != nil || inspect.ID != res.Image.ID {
		t.Fatalf("image %+v: %v", res.Image, err)
	}
	if res.BaseImage.Ref != version.ImageRef("scantor-base-python", images) || *res.Entry != "main.py" ||
		res.Defaults.Resources != (api.Resources{CPUs: 2, MemoryMiB: manifest.ScriptDefaultMemoryMiB}) || res.Defaults.TimeoutMs != nil {
		t.Fatalf("base %+v entry %v defaults %+v", res.BaseImage, res.Entry, res.Defaults)
	}
	for _, unwanted := range []string{"[describe]", "[check]", "[push]"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("a script build has no %s phase:\n%s", unwanted, text)
		}
	}
	if !strings.Contains(text, "[result] ok: image "+tag) {
		t.Errorf("events:\n%s", text)
	}

	again, text := buildScript()
	if again.Image.ID != res.Image.ID || !strings.Contains(text, "reusing the existing image "+tag) {
		t.Fatalf("the unchanged script must reuse %s: %+v\n%s", res.Image.ID, again.Image, text)
	}
}

// taskName matches the task-name slug of schemas/task-manifest.schema.json.
var taskName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`)

// bundleTaskName returns a fresh task name <name-prefix><random>, so the loaded bundle image is named
// like everything else the tests create.
func bundleTaskName(t *testing.T) string {
	t.Helper()
	task := *namePrefix + uuid.NewString()[:8]
	if !taskName.MatchString(task) {
		t.Fatalf("-name-prefix %q does not give a task name", *namePrefix)
	}
	return task
}

// bundleInfoFor returns a bundle info of a fresh task at revision 1 for a built image: its description
// and settings defaults, the dev-run limits and the image's platform.
func bundleInfoFor(t *testing.T, res *taskpipe.Result) *bundle.Info {
	t.Helper()
	task := bundleTaskName(t)
	s, l := res.SettingsDefaults, taskpipe.DefaultLocalLimits()
	return &bundle.Info{
		V: bundle.InfoVersion, Image: bundle.ImageName(task, 1), Ref: bundle.RevisionRef(task, 1), Task: task, Revision: 1,
		Language: *res.Language, Entry: res.Manifest.Entry, Platform: res.Image.Platform, Description: *res.Description,
		Settings: bundle.Settings{
			Processes: s.Processes, TimeoutMs: s.TimeoutMs, MaxAttempts: s.MaxAttempts, Backoff: s.Backoff,
			Resources: s.Resources, MaxAnalysesPerProcess: s.MaxAnalysesPerProcess,
		},
		Limits: bundle.Limits{
			MaxAnalysisConfigBytes: l.MaxAnalysisConfigBytes, MaxResultBytes: l.MaxResultBytes, MaxFileBytes: l.MaxFileBytes,
			MaxFilesPerAnalysis: l.MaxFilesPerAnalysis, LogTailBytes: l.LogTailBytes, LogTailEarlierBytes: l.LogTailEarlierBytes,
			MaxProcesses: 64,
		},
	}
}

// bundleRun is the outcome of one bundle step into a file.
type bundleRun struct {
	res    *taskpipe.BundleResult
	file   string
	events string
}

func bundleTo(t *testing.T, c client.APIClient, cfg taskpipe.Config, rt taskpipe.RuntimeResolver, info *bundle.Info, opts taskpipe.BundleOptions) bundleRun {
	t.Helper()
	data, err := info.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), bundle.FileName(info.Task, info.Revision, info.Platform))
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	var events bytes.Buffer
	res := taskpipe.New(cfg, taskpipe.NewEmitter(&events, taskpipe.EventsText), c, rt).Bundle(context.Background(), data, opts, f)
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("bundle errors %+v\n%s", res.Errors, events.String())
	}
	return bundleRun{res: res, file: file, events: events.String()}
}

// checkTemporaryTagsRemoved checks that the temporary tags the step names in its events are gone.
func checkTemporaryTagsRemoved(t *testing.T, c client.APIClient, events string) {
	t.Helper()
	m := regexp.MustCompile(`tagged \S+ as (` + taskpipe.BundleTempRepository + `/[0-9a-f-]{36}):src`).FindStringSubmatch(events)
	if m == nil {
		t.Fatalf("no temporary tag in the events:\n%s", events)
	}
	for _, ref := range []string{m[1] + ":src", m[1] + ":build"} {
		if _, err := c.ImageInspect(context.Background(), ref); !container.IsNotFound(err) {
			t.Errorf("the temporary tag %s survived: %v", ref, err)
		}
	}
}

// loadBundle checks the archive's size and digest, checks that its uncompressed bytes name neither the
// temporary tags nor the forbidden strings, and loads it into the daemon. The loaded image is removed at
// the end of the test.
func loadBundle(t *testing.T, c client.APIClient, run bundleRun, forbidden ...string) {
	t.Helper()
	data, err := os.ReadFile(run.file)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if a := run.res.Bundle; int64(len(data)) != a.Bytes || hex.EncodeToString(sum[:]) != a.SHA256 {
		t.Fatalf("archive of %d bytes, sha256 %x; reported %+v", len(data), sum, a)
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range append([]string{taskpipe.BundleTempRepository + "/"}, forbidden...) {
		if bytes.Contains(plain, []byte(s)) {
			t.Errorf("the archive contains %q", s)
		}
	}
	removeImage(t, c, run.res.Bundle.Image)
	resp, err := c.ImageLoad(context.Background(), bytes.NewReader(data), client.ImageLoadWithQuiet(true))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(resp)
	_ = resp.Close()
	if err != nil || bytes.Contains(out, []byte(`"error`)) {
		t.Fatalf("docker load: %v %s", err, out)
	}
}

// TestIntegrationBundle bundles the integration build of tasks/echo (docs/tasks.md §9.11), loads the
// archive into the same daemon and checks the loaded image: its only name, the bundle entrypoint, the
// runtime healthcheck, the working directory /work, no reserved labels, and the bundle info it carries,
// read from a created but never started container. Running the image is covered by the bundle e2e
// suite.
func TestIntegrationBundle(t *testing.T) {
	c := dockerClient(t)
	ctx := context.Background()
	images := version.ImageOverride{Prefix: *basePrefix, Tag: *baseTag}
	base := version.ImageRef("scantor-base-python", images)
	if _, err := c.ImageInspect(ctx, base); err != nil {
		t.Skipf("the Python base image %s is not available (docker buildx bake --load base-python, or -base-image-prefix/-base-image-tag): %v", base, err)
	}
	rt, _ := taskRuntime(t, c)
	tag := *namePrefix + "echo:" + uuid.NewString()[:8]
	r := build(t, c, pipelineConfig(images), rt, filepath.Join(moduleRoot, "tasks", "echo"), taskpipe.BuildOptions{Tag: tag, ExpectName: "echo", SkipCheck: true})
	if !r.res.OK {
		t.Fatalf("errors: %+v", r.res.Errors)
	}
	info := bundleInfoFor(t, r.res)
	run := bundleTo(t, c, pipelineConfig(images), rt, info, taskpipe.BundleOptions{Image: tag})
	if a := run.res.Bundle; a.Image != info.Image || a.Platform != info.Platform || a.ImageBytes <= r.res.Image.Bytes || a.ScantorVersion != version.Version {
		t.Fatalf("bundle %+v (revision image %d bytes)", a, r.res.Image.Bytes)
	}
	if !strings.Contains(run.events, "[result] ok: bundle "+info.Image) {
		t.Errorf("events:\n%s", run.events)
	}
	checkTemporaryTagsRemoved(t, c, run.events)
	if _, err := c.ImageInspect(ctx, tag); err != nil {
		t.Fatalf("the revision image must stay: %v", err)
	}
	loadBundle(t, c, run, tag)

	img, err := c.ImageInspect(ctx, info.Image)
	if err != nil {
		t.Fatal(err)
	}
	cfg := img.Config
	if !slices.Equal(img.RepoTags, []string{info.Image}) || img.Os != "linux" || img.Architecture != info.Platform.Arch || cfg == nil {
		t.Fatalf("loaded image %+v", img.InspectResponse)
	}
	if !slices.Equal(cfg.Entrypoint, []string{"/scantor/scantor", "runtime", "bundle"}) || len(cfg.Cmd) != 0 || cfg.WorkingDir != bundle.WorkDir || cfg.StopSignal != "SIGTERM" {
		t.Fatalf("config %+v", cfg)
	}
	if hc := cfg.Healthcheck; hc == nil || !slices.Equal(hc.Test, []string{"CMD", "/scantor/scantor", "runtime", "healthcheck"}) || hc.Interval != 30*time.Second || hc.StartInterval != 5*time.Second {
		t.Fatalf("healthcheck %+v", cfg.Healthcheck)
	}
	for k := range cfg.Labels {
		if container.ForbiddenImageLabel(k) {
			t.Errorf("the bundle image carries the label %s", k)
		}
	}
	if cfg.Labels["org.opencontainers.image.title"] != info.Ref {
		t.Errorf("labels %v", cfg.Labels)
	}

	// The bundle info, read from a created container that never starts.
	created, err := c.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:   *namePrefix + "bundle-" + uuid.NewString()[:8],
		Config: &containertypes.Config{Image: info.Image, Labels: map[string]string{"scantor.test": "true"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := c.ContainerRemove(context.Background(), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil {
			t.Errorf("remove the container: %v", err)
		}
	})
	copied, err := c.CopyFromContainer(ctx, created.ID, client.CopyFromContainerOptions{SourcePath: bundle.InfoPath})
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Content.Close()
	tr := tar.NewReader(copied.Content)
	hdr, err := tr.Next()
	if err != nil {
		t.Fatal(err)
	}
	baked, err := io.ReadAll(tr)
	if err != nil {
		t.Fatal(err)
	}
	want, err := info.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if hdr.Name != "bundle.json" || hdr.Mode&0o777 != 0o644 || !bytes.Equal(baked, want) {
		t.Fatalf("baked %s (%o):\n%s\nwant:\n%s", hdr.Name, hdr.Mode, baked, want)
	}
	parsed, err := bundle.Parse(baked)
	if err != nil || parsed.Image != info.Image {
		t.Fatalf("parse the baked info: %+v %v", parsed, err)
	}
}

// TestIntegrationBundlePull bundles a revision image whose local tag is gone (the built-in node's image
// GC): the step pulls it by digest from a throwaway registry, reached on a loopback port the way the
// platform registry is reached at localhost:${SCANTOR_REGISTRY_PORT}, and bundles the pulled image.
func TestIntegrationBundlePull(t *testing.T) {
	c := dockerClient(t)
	const registryImage = "registry:3.1.2"
	ctx := context.Background()
	if _, err := c.ImageInspect(ctx, registryImage); err != nil {
		t.Skipf("%s is not available locally: %v", registryImage, err)
	}
	port := 40000 + time.Now().Nanosecond()%10000
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	created, err := c.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:       *namePrefix + "registry-" + uuid.NewString()[:8],
		Config:     &containertypes.Config{Image: registryImage, Env: []string{"REGISTRY_HTTP_ADDR=" + addr}, Labels: map[string]string{"scantor.test": "true"}},
		HostConfig: &containertypes.HostConfig{NetworkMode: "host"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := c.ContainerRemove(context.Background(), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil {
			t.Errorf("remove the registry: %v", err)
		}
	})
	if _, err := c.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	waitForLog(t, c, created.ID, "listening on")

	taskID := uuid.NewString()
	tag := addr + "/tasks/" + taskID + ":" + uuid.NewString()
	cfg := pipelineConfig(plainBase(t, c, ""))
	cfg.RegistryPushPassword = "derived-password"
	rt := stubRuntime(t, c)
	r := build(t, c, cfg, rt, writeTask(t, plainDockerfile), taskpipe.BuildOptions{Tag: tag, Push: true})
	if !r.res.OK {
		t.Fatalf("errors %+v", r.res.Errors)
	}
	pull := addr + "/tasks/" + taskID + "@" + r.res.Image.Digest
	removeImage(t, c, pull)
	if _, err := c.ImageRemove(ctx, tag, client.ImageRemoveOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ImageInspect(ctx, tag); !container.IsNotFound(err) {
		t.Fatalf("the local tag must be gone: %v", err)
	}

	data, err := os.ReadFile(filepath.Join("..", "bundle", "testdata", "bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	info, err := bundle.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	task := bundleTaskName(t)
	info.Task, info.Image, info.Ref, info.Platform = task, bundle.ImageName(task, 3), bundle.RevisionRef(task, 3), r.res.Image.Platform
	run := bundleTo(t, c, cfg, rt, info, taskpipe.BundleOptions{Image: tag, Pull: pull})
	if !strings.Contains(run.events, "does not exist; pulling "+pull) {
		t.Errorf("events:\n%s", run.events)
	}
	checkTemporaryTagsRemoved(t, c, run.events)
	loadBundle(t, c, run, taskID, addr, "derived-password")
	if img, err := c.ImageInspect(ctx, info.Image); err != nil || !slices.Equal(img.RepoTags, []string{info.Image}) {
		t.Fatalf("loaded image %v %v", img.RepoTags, err)
	}
}
