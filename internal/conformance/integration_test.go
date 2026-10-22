//go:build integration

package conformance

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/pkg/stdcopy"
	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/version"
)

// These tests run the real connectors inside the base images: describe (through `scantor task build`)
// and local mode on the example tasks, and the conformance harness for every language.
//
// They need the base images and, on a non-linux host, the scantor image of the same prefix and tag
// (the native CLI extracts the linux runtime from it), for example
//
//	docker buildx bake --load base-python base-js base-go scantor        (IMAGE_PREFIX, IMAGE_TAG)
//	docker build -f connectors/python/Dockerfile --target base -t <prefix>scantor-base-python:<tag> .
//
// and are run as `go test -tags integration ./internal/conformance -args -image-prefix <prefix>
// -image-tag <tag>`. Languages whose base image is missing are skipped.

var (
	imagePrefix = flag.String("image-prefix", version.ImagePrefix, "SCANTOR_IMAGE_PREFIX of the base images under test")
	imageTag    = flag.String("image-tag", "dev", "SCANTOR_IMAGE_TAG of the base images under test")
	namePrefix  = flag.String("name-prefix", "scantor-test-", "prefix of the containers and images the tests create")
)

type env struct {
	docker   client.APIClient
	root     string
	hostBin  string // the scantor CLI for this host (task build)
	linuxBin *container.Binary
	environ  []string
}

func setup(t *testing.T) *env {
	t.Helper()
	docker, err := container.NewClient("scantor-integration-test")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	daemonOS, arch, err := container.DaemonPlatform(ctx, docker)
	if err != nil || daemonOS != "linux" {
		t.Skipf("needs a linux Docker daemon (%s, %v)", daemonOS, err)
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	e := &env{docker: docker, root: root, hostBin: filepath.Join(dir, "scantor-host")}
	e.environ = append(os.Environ(), "SCANTOR_IMAGE_PREFIX="+*imagePrefix, "SCANTOR_IMAGE_TAG="+*imageTag)
	gobuild(t, root, e.hostBin, goruntime.GOOS, goruntime.GOARCH)
	linuxPath := filepath.Join(dir, "scantor-linux")
	gobuild(t, root, linuxPath, "linux", arch)
	if e.linuxBin, err = container.LoadBinary(linuxPath); err != nil {
		t.Fatal(err)
	}
	if !container.NativeFor(goruntime.GOOS, goruntime.GOARCH) || goruntime.GOARCH != arch {
		scantorImage := version.ImageRef("scantor", version.ImageOverride{Prefix: *imagePrefix, Tag: *imageTag})
		if version.IsRelease(*imageTag) {
			t.Skipf("refusing to replace the release image %s; use a development tag", scantorImage)
		}
		buildScantorImage(t, docker, scantorImage, linuxPath)
	}
	return e
}

func gobuild(t *testing.T, root, out, goos, goarch string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", "-X github.com/lonetis/scantor/internal/version.ImagePrefix="+*imagePrefix, "-o", out, "./cmd/scantor")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+goos, "GOARCH="+goarch)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build %s/%s: %v\n%s", goos, goarch, err, b)
	}
}

// buildScantorImage builds the minimal scantor image the native CLI extracts the linux runtime from.
func buildScantorImage(t *testing.T, docker client.APIClient, ref, binary string) {
	t.Helper()
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	dockerfile := []byte("FROM alpine:3.24\nCOPY scantor /usr/local/bin/scantor\nENTRYPOINT [\"/usr/local/bin/scantor\"]\n")
	for name, content := range map[string][]byte{"Dockerfile": dockerfile, "scantor": data} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	resp, err := docker.ImageBuild(context.Background(), &buf, client.ImageBuildOptions{Tags: []string{ref}, Remove: true, ForceRemove: true})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if bytes.Contains(out, []byte(`"error"`)) {
		t.Fatalf("build %s: %s", ref, out)
	}
}

// baseImages returns the languages whose base image exists.
func (e *env) languages(t *testing.T) []string {
	t.Helper()
	table, err := languages.Load()
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range table.All() {
		ref := l.BaseImageRef(version.ImageOverride{Prefix: *imagePrefix, Tag: *imageTag})
		if _, err := e.docker.ImageInspect(context.Background(), ref); err != nil {
			t.Logf("skipping %s: base image %s is missing", l.Name, ref)
			continue
		}
		out = append(out, l.Name)
	}
	if len(out) == 0 {
		t.Skip("no base image is available")
	}
	return out
}

// buildResult is the result event of `scantor task build`.
type buildResult struct {
	OK       bool             `json:"ok"`
	Errors   []api.BuildError `json:"errors"`
	Manifest struct {
		Entry string `json:"entry"`
	} `json:"manifest"`
	Image *struct {
		ID string `json:"id"`
	} `json:"image"`
	Description *api.Description `json:"description"`
}

// taskBuild runs `scantor task build` (with the type check unless skipCheck) and returns its result
// event and exit code; the image is removed after the test.
func (e *env) taskBuild(t *testing.T, dir, tag string, skipCheck bool) (buildResult, int) {
	t.Helper()
	args := []string{"task", "build", dir, "--tag", tag, "--events", "ndjson"}
	if skipCheck {
		args = append(args, "--skip-check")
	}
	cmd := exec.Command(e.hostBin, args...)
	cmd.Env = e.environ
	out, err := cmd.Output()
	t.Cleanup(func() {
		_, _ = e.docker.ImageRemove(context.Background(), tag, client.ImageRemoveOptions{PruneChildren: true})
	})
	code := 0
	var ee *exec.ExitError
	switch {
	case errors.As(err, &ee):
		code = ee.ExitCode()
	case err != nil:
		t.Fatalf("task build %s: %v", dir, err)
	}
	var result buildResult
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		var ev struct {
			Type   string          `json:"type"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) == nil && ev.Type == "result" {
			_ = json.Unmarshal(ev.Result, &result)
		}
	}
	return result, code
}

// build runs `scantor task build --skip-check` and returns the image id, the entry and the description.
func (e *env) build(t *testing.T, dir, tag string) (string, string, *api.Description) {
	t.Helper()
	result, code := e.taskBuild(t, dir, tag, true)
	if !result.OK || result.Image == nil || result.Description == nil {
		t.Fatalf("task build %s: exit %d %+v", dir, code, result.Errors)
	}
	return result.Image.ID, result.Manifest.Entry, result.Description
}

// localRun is the outcome of one local-mode container.
type localRun struct {
	events []map[string]any
	// files maps paths below /scantor/out (outDir-relative, e.g. files/0/<id>/data.json) to contents.
	files    map[string][]byte
	exitCode int64
}

func (r localRun) end() map[string]any { return r.events[len(r.events)-1] }

func (r localRun) ofType(typ string) []map[string]any {
	var out []map[string]any
	for _, ev := range r.events {
		if ev["type"] == typ {
			out = append(out, ev)
		}
	}
	return out
}

// local runs local mode in a container of image (network none, test-run hardening) and returns its
// events, the files below /scantor/out and the container's exit code.
func (e *env) local(t *testing.T, image string, spec map[string]any) localRun {
	t.Helper()
	ctx := context.Background()
	specJSON, _ := json.Marshal(spec)
	profile := container.TestRunProfile(api.Resources{CPUs: 1, MemoryMiB: 512}, container.NetworkNone, nil)
	hc, err := profile.HostConfig()
	if err != nil {
		t.Fatal(err)
	}
	name := *namePrefix + "local-" + uuid.NewString()[:8]
	created, err := e.docker.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, HostConfig: hc, Config: &containertypes.Config{
		Image: image, Entrypoint: container.RuntimeEntrypoint(container.ModeLocal, "--spec", "/scantor/in/spec.json"), Cmd: []string{},
		Labels: map[string]string{"scantor.test": "true"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = e.docker.ContainerRemove(ctx, created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	if err := container.Inject(ctx, e.docker, created.ID, e.linuxBin, container.LocalModeFiles(specJSON, nil)); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	wait := e.docker.ContainerWait(waitCtx, created.ID, client.ContainerWaitOptions{Condition: containertypes.WaitConditionNextExit})
	if _, err := e.docker.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	var run localRun
	select {
	case res := <-wait.Result:
		run.exitCode = res.StatusCode
	case err := <-wait.Error:
		t.Fatal(err)
	}
	logs, err := e.docker.ContainerLogs(ctx, created.ID, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		t.Fatal(err)
	}
	defer logs.Close()
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, logs); err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("stdout carries a non-event line %q (stderr: %s)", line, stderr.String())
		}
		run.events = append(run.events, ev)
	}
	if end := run.end(); end["type"] != "end" || end["exitCode"] != float64(run.exitCode) {
		t.Fatalf("the last event %v does not end the run with the container's exit code %d (stderr: %s)", end, run.exitCode, stderr.String())
	}
	run.files = e.copyOut(t, created.ID)
	return run
}

// copyOut returns the regular files below /scantor/out of a stopped container.
func (e *env) copyOut(t *testing.T, id string) map[string][]byte {
	t.Helper()
	res, err := e.docker.CopyFromContainer(context.Background(), id, client.CopyFromContainerOptions{SourcePath: "/scantor/out"})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Content.Close()
	files := map[string][]byte{}
	tr := tar.NewReader(res.Content)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[strings.TrimPrefix(hdr.Name, "out/")] = data
	}
}

func localSpec(entry string, scanConfig any) map[string]any {
	return map[string]any{
		"v": 1, "runId": "local", "entry": entry, "taskConfig": map[string]any{}, "scanConfig": scanConfig,
		"limit": 20, "processes": 2, "timeoutMs": 30000, "maxAttempts": 1, "maxAnalysesPerProcess": 1000,
		"backoff": map[string]any{"initialMs": 1000, "factor": 2, "maxMs": 10000, "jitter": false},
		"limits":  map[string]any{"maxAnalysisConfigBytes": 65536, "maxResultBytes": 1048576, "maxFileBytes": 1 << 20, "maxFilesPerAnalysis": 10, "logTailBytes": 32768, "logTailEarlierBytes": 4096},
	}
}

// withFields returns a copy of spec with the given fields replaced.
func withFields(spec map[string]any, fields map[string]any) map[string]any {
	out := make(map[string]any, len(spec)+len(fields))
	for k, v := range spec {
		out[k] = v
	}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func TestExamplesDescribeAndRunLocally(t *testing.T) {
	e := setup(t)
	available := e.languages(t)
	cases := []struct {
		task, language string
		scanConfig     any
		results        int
		schedule       string
	}{
		{"echo", "python", map[string]any{}, 1, "template single"},
		{"power", "javascript", map[string]any{}, 10, "custom"},
		{"reverse-dns", "go", map[string]any{"cidrs": []string{"127.0.0.1/32"}}, 1, "template cidr"},
		{"http-status", "typescript", nil, 0, "template crux"}, // describe only: the data source needs network
	}
	for _, c := range cases {
		t.Run(c.task, func(t *testing.T) {
			if !contains(available, c.language) {
				t.Skipf("no %s base image", c.language)
			}
			image, entry, desc := e.build(t, filepath.Join(e.root, "tasks", c.task), fmt.Sprintf("%sit-%s:latest", *namePrefix, c.task))
			got := desc.Schedule.Kind
			if desc.Schedule.Template != "" {
				got += " " + desc.Schedule.Template
			}
			if got != c.schedule || desc.Connector.Language != c.language {
				t.Fatalf("description: schedule %q language %q", got, desc.Connector.Language)
			}
			if c.results == 0 {
				return
			}
			run := e.local(t, image, localSpec(entry, c.scanConfig))
			if end := run.end(); end["exitCode"] != float64(0) || end["reason"] != "done" {
				t.Fatalf("end %v (events %v)", end, run.events)
			}
			start := run.ofType("start")
			if len(start) != 1 || start[0]["language"] != c.language {
				t.Fatalf("start events %v", start)
			}
			succeeded := 0
			for _, ev := range run.ofType("result") {
				if ev["status"] == "succeeded" {
					succeeded++
				}
			}
			if succeeded != c.results {
				t.Fatalf("%d succeeded results, want %d: %v", succeeded, c.results, run.events)
			}
		})
	}
}

// TestLocalModeOutcomes runs the Python examples files, throws and sleep in local mode
// (docs/runtime.md §15): files in the output directory, retries, timeouts, crashes, schedule failures,
// the limit and the total timeout, with their events and exit codes.
func TestLocalModeOutcomes(t *testing.T) {
	e := setup(t)
	if !contains(e.languages(t), "python") {
		t.Skip("no python base image")
	}
	images := map[string]string{}
	entries := map[string]string{}
	for _, task := range []string{"files", "throws", "sleep"} {
		images[task], entries[task], _ = e.build(t, filepath.Join(e.root, "tasks", task), fmt.Sprintf("%sit-%s:latest", *namePrefix, task))
	}
	errorOf := func(ev map[string]any) map[string]any {
		m, _ := ev["error"].(map[string]any)
		return m
	}

	t.Run("files", func(t *testing.T) {
		spec := withFields(localSpec(entries["files"], map[string]any{"items": []string{"alpha", "beta"}}), map[string]any{"taskConfig": map[string]any{"copies": 1}})
		run := e.local(t, images["files"], spec)
		if run.exitCode != 0 {
			t.Fatalf("exit %d: %v", run.exitCode, run.events)
		}
		results := run.ofType("result")
		if len(results) != 2 {
			t.Fatalf("results %v", results)
		}
		for _, ev := range results {
			files, _ := ev["files"].([]any)
			if ev["status"] != "succeeded" || len(files) != 6 {
				t.Fatalf("result %v", ev)
			}
			result, _ := ev["result"].(map[string]any)
			data, _ := result["data"].(map[string]any)
			first, _ := files[0].(map[string]any)
			if data["id"] != first["id"] {
				t.Fatalf("result.data %v does not reference the first registered file %v", data, first)
			}
			for _, f := range files {
				fm, _ := f.(map[string]any)
				content, ok := run.files[fm["path"].(string)]
				sum := sha256.Sum256(content)
				if !ok || hex.EncodeToString(sum[:]) != fm["sha256"] || int64(len(content)) != int64(fm["size"].(float64)) {
					t.Fatalf("file %v: present %v, %d bytes in %v", fm, ok, len(content), keys(run.files))
				}
			}
		}
	})

	t.Run("flaky retried", func(t *testing.T) {
		spec := withFields(localSpec(entries["throws"], map[string]any{"end": 2}), map[string]any{
			"taskConfig": map[string]any{"mode": "flaky", "fail_attempts": 1}, "maxAttempts": 2,
		})
		run := e.local(t, images["throws"], spec)
		attempts, results := run.ofType("attempt"), run.ofType("result")
		if run.exitCode != 0 || len(attempts) != 2 || len(results) != 2 {
			t.Fatalf("exit %d, %d attempt and %d result events: %v", run.exitCode, len(attempts), len(results), run.events)
		}
		for _, ev := range results {
			history, _ := ev["attempts"].([]any)
			if ev["status"] != "succeeded" || ev["attempt"] != float64(2) || len(history) != 1 {
				t.Fatalf("result %v", ev)
			}
		}
		if errorOf(attempts[0])["type"] != "taskError" || attempts[0]["nextAttemptAt"] == nil {
			t.Fatalf("attempt %v", attempts[0])
		}
	})

	for _, tc := range []struct {
		name, mode string
		timeoutMs  int
		wantType   string
	}{
		{"timeout", "timeout", 2000, "timeout"},
		{"crash", "crash", 30000, "crash"},
		{"fatal", "fatal", 30000, "fatal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := withFields(localSpec(entries["throws"], nil), map[string]any{
				"scanConfig": nil, "analysisConfig": map[string]any{"value": 7}, "taskConfig": map[string]any{"mode": tc.mode}, "timeoutMs": tc.timeoutMs,
			})
			run := e.local(t, images["throws"], spec)
			results := run.ofType("result")
			if run.exitCode != 1 || len(results) != 1 || results[0]["status"] != "failed" || errorOf(results[0])["type"] != tc.wantType {
				t.Fatalf("exit %d, results %v", run.exitCode, results)
			}
			if run.ofType("scheduled")[0]["seq"] != float64(0) {
				t.Fatalf("the analysis config was not scheduled as seq 0: %v", run.events)
			}
		})
	}

	t.Run("schedule failed", func(t *testing.T) {
		spec := withFields(localSpec(entries["throws"], map[string]any{"end": 3}), map[string]any{"taskConfig": map[string]any{"fail_in_schedule": true}})
		run := e.local(t, images["throws"], spec)
		errs := run.ofType("error")
		if run.exitCode != 1 || run.end()["reason"] != "scheduleFailed" || len(errs) != 1 || errorOf(errs[0])["type"] != "taskError" || errorOf(errs[0])["phase"] != "schedule" {
			t.Fatalf("exit %d, end %v, errors %v", run.exitCode, run.end(), errs)
		}
	})

	t.Run("limit", func(t *testing.T) {
		spec := withFields(localSpec(entries["sleep"], map[string]any{"times": 5}), map[string]any{"taskConfig": map[string]any{"seconds": 0}, "limit": 3})
		run := e.local(t, images["sleep"], spec)
		if run.exitCode != 0 || run.end()["reason"] != "limit" || len(run.ofType("scheduled")) != 3 || len(run.ofType("result")) != 3 {
			t.Fatalf("exit %d, end %v", run.exitCode, run.end())
		}
		if resolved := run.ofType("resolved"); len(resolved) != 1 || resolved[0]["key"] != "schedule" || resolved[0]["template"] != "repeat" {
			t.Fatalf("resolved %v", resolved)
		}
	})

	t.Run("total timeout", func(t *testing.T) {
		spec := withFields(localSpec(entries["sleep"], map[string]any{"times": 1}), map[string]any{"taskConfig": map[string]any{"seconds": 60}, "totalTimeoutMs": 3000})
		run := e.local(t, images["sleep"], spec)
		results := run.ofType("result")
		if run.exitCode != 3 || run.end()["reason"] != "timeout" || len(results) != 1 || errorOf(results[0])["type"] != "cancelled" {
			t.Fatalf("exit %d, end %v, results %v", run.exitCode, run.end(), results)
		}
	})
}

// TestCheckMode runs the type check of `scantor task build` (docs/runtime.md §16) on a valid example
// and on a copy with a type error, which must become a BuildError with file and line.
func TestCheckMode(t *testing.T) {
	e := setup(t)
	if !contains(e.languages(t), "python") {
		t.Skip("no python base image")
	}
	result, code := e.taskBuild(t, filepath.Join(e.root, "tasks", "echo"), *namePrefix+"it-check-ok:latest", false)
	if code != 0 || !result.OK {
		t.Fatalf("check of tasks/echo: exit %d %+v", code, result.Errors)
	}
	broken := t.TempDir()
	if err := os.CopyFS(broken, os.DirFS(filepath.Join(e.root, "tasks", "echo"))); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(filepath.Join(broken, "main.py"))
	if err != nil {
		t.Fatal(err)
	}
	src = append(src, []byte("\n\nwrong: int = \"not an int\"\n")...)
	if err := os.WriteFile(filepath.Join(broken, "main.py"), src, 0o600); err != nil {
		t.Fatal(err)
	}
	result, code = e.taskBuild(t, broken, *namePrefix+"it-check-broken:latest", false)
	if code != 2 || result.OK {
		t.Fatalf("check of a broken copy: exit %d ok %v", code, result.OK)
	}
	var found bool
	for _, be := range result.Errors {
		found = found || (be.Phase == api.BuildPhaseCheck && be.File == "main.py" && be.Line > 0)
	}
	if !found {
		t.Fatalf("no check error in main.py: %+v", result.Errors)
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestConformanceOfEveryConnector(t *testing.T) {
	e := setup(t)
	for _, language := range e.languages(t) {
		t.Run(language, func(t *testing.T) {
			var out bytes.Buffer
			suite := &Suite{
				Language: language, FixturesDir: filepath.Join(e.root, DefaultFixturesDir), Docker: e.docker, Binary: e.linuxBin,
				Builder: Builder{Executable: e.hostBin, Env: e.environ}, ImagePrefix: *namePrefix + "conf/", NamePrefix: *namePrefix, Out: &out,
			}
			summary, err := suite.Run(context.Background())
			if err != nil {
				t.Fatalf("%v\n%s", err, out.String())
			}
			if summary.Failed > 0 || summary.Passed == 0 {
				t.Fatalf("%d passed, %d failed:\n%s", summary.Passed, summary.Failed, out.String())
			}
			t.Logf("%s: %d cases passed", language, summary.Passed)
		})
	}
}
