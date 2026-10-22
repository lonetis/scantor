package conformance

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// DefaultFixturesDir is the fixture directory relative to the repository root.
const DefaultFixturesDir = "internal/conformance/testdata"

// caseTimeout bounds one case container.
const caseTimeout = 5 * time.Minute

// Suite is the host side of the harness for one language.
type Suite struct {
	Language string
	// FixturesDir holds <language>/<fixture>/ task folders.
	FixturesDir string
	Docker      client.APIClient
	// Binary is the linux scantor binary injected into the case containers.
	Binary *container.Binary
	// Builder runs `scantor task build`: the executable and the environment it gets.
	Builder Builder
	// Cases limits the run to these case ids (all when empty).
	Cases []string
	// ImagePrefix and NamePrefix prefix the fixture image tags and the container names.
	ImagePrefix string
	NamePrefix  string
	// KeepImages keeps the fixture images after the run.
	KeepImages bool
	// Out receives progress and the summary.
	Out io.Writer
}

// Builder builds a fixture with `scantor task build` (docs/tasks.md §9.1), no push and no check.
type Builder struct {
	Executable string
	Env        []string
}

// Summary is the outcome of a suite.
type Summary struct {
	Reports []Report `json:"reports"`
	Passed  int      `json:"passed"`
	Failed  int      `json:"failed"`
}

// fixture is one built fixture image.
type fixture struct {
	name  string
	dir   string
	image string
	entry string
	tag   string
	err   error
}

// Run builds the fixtures and runs every applicable case. The error is set only for platform failures
// (Docker unreachable, no fixtures); failed cases are in the summary.
func (s *Suite) Run(ctx context.Context) (*Summary, error) {
	names, err := s.fixtures()
	if err != nil {
		return nil, err
	}
	sum := &Summary{Reports: []Report{}}
	for _, name := range names {
		var planned []Case
		for _, c := range Cases {
			if c.Applies(s.Language, name) && (len(s.Cases) == 0 || slices.Contains(s.Cases, c.ID)) {
				planned = append(planned, c)
			}
		}
		if len(planned) == 0 {
			continue
		}
		fx := s.build(ctx, name)
		for _, c := range planned {
			if ctx.Err() != nil {
				return sum, ctx.Err()
			}
			r := s.runCase(ctx, fx, c)
			sum.Reports = append(sum.Reports, r)
			if r.OK {
				sum.Passed++
				fmt.Fprintf(s.Out, "PASS %-4s %-22s %d checks, %d ms\n", r.Case, r.Fixture, r.Checks, r.DurationMs)
			} else {
				sum.Failed++
				fmt.Fprintf(s.Out, "FAIL %-4s %-22s\n", r.Case, r.Fixture)
				for _, f := range r.Failures {
					fmt.Fprintf(s.Out, "     - %s\n", f)
				}
			}
		}
		s.removeImage(fx)
	}
	fmt.Fprintf(s.Out, "%s: %d passed, %d failed\n", s.Language, sum.Passed, sum.Failed)
	return sum, nil
}

// fixtures lists the fixture folders of the language.
func (s *Suite) fixtures() ([]string, error) {
	dir := filepath.Join(s.FixturesDir, s.Language)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read the fixtures of %s: %w", s.Language, err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("no fixtures in %s", dir)
	}
	slices.Sort(names)
	return names, nil
}

// build builds one fixture with `scantor task build` and reads the image id and entry from its result
// event.
func (s *Suite) build(ctx context.Context, name string) *fixture {
	fx := &fixture{name: name, dir: filepath.Join(s.FixturesDir, s.Language, name)}
	fx.tag = fmt.Sprintf("%sconformance-%s-%s:latest", s.ImagePrefix, s.Language, name)
	fmt.Fprintf(s.Out, "building %s/%s\n", s.Language, name)
	cmd := exec.CommandContext(ctx, s.Builder.Executable, "task", "build", fx.dir, "--tag", fx.tag, "--skip-check", "--allow-privileged", "--events", "ndjson")
	cmd.Env = s.Builder.Env
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()
	var result struct {
		OK       bool             `json:"ok"`
		Errors   []api.BuildError `json:"errors"`
		Manifest *struct {
			Entry string `json:"entry"`
		} `json:"manifest"`
		Image *struct {
			ID string `json:"id"`
		} `json:"image"`
	}
	sc := bufio.NewScanner(&stdout)
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
	switch {
	case result.OK && result.Image != nil && result.Manifest != nil:
		fx.image, fx.entry = result.Image.ID, result.Manifest.Entry
	case result.Manifest != nil && onlyDescribeErrors(result.Errors):
		// A fixture that cannot be described (import-error, bad-definition) was still built and tagged;
		// the cases themselves check its handshake.
		inspect, err := s.Docker.ImageInspect(ctx, fx.tag)
		if err != nil {
			fx.err = fmt.Errorf("task build failed in describe and left no image: %w", err)
			break
		}
		fx.image, fx.entry = inspect.ID, result.Manifest.Entry
		fmt.Fprintf(s.Out, "note: %s/%s was built, but describe failed (expected for import-error and bad-definition)\n", s.Language, name)
	case len(result.Errors) > 0:
		msgs := make([]string, len(result.Errors))
		for i, e := range result.Errors {
			msgs[i] = fmt.Sprintf("%s %s:%d: %s", e.Phase, e.File, e.Line, e.Message)
		}
		fx.err = fmt.Errorf("task build failed: %s", strings.Join(msgs, "; "))
	default:
		fx.err = fmt.Errorf("task build failed: %v: %s", runErr, strings.TrimSpace(stderr.String()))
	}
	return fx
}

// onlyDescribeErrors reports whether every build error is a describe error.
func onlyDescribeErrors(errs []api.BuildError) bool {
	for _, e := range errs {
		if e.Phase != api.BuildPhaseDescribe {
			return false
		}
	}
	return len(errs) > 0
}

func (s *Suite) removeImage(fx *fixture) {
	if s.KeepImages {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if _, err := s.Docker.ImageRemove(ctx, fx.tag, client.ImageRemoveOptions{PruneChildren: true}); err != nil && !container.IsNotFound(err) {
		fmt.Fprintf(s.Out, "warning: cannot remove %s: %v\n", fx.tag, err)
	}
}

// runCase runs one case in a fresh container of the fixture image.
func (s *Suite) runCase(ctx context.Context, fx *fixture, c Case) Report {
	report := Report{Case: c.ID, Fixture: fx.name, Language: s.Language}
	if fx.err != nil {
		report.Failures = []string{fx.err.Error()}
		return report
	}
	stdout, stderr, code, err := s.runContainer(ctx, fx, c)
	if err != nil {
		report.Failures = []string{err.Error()}
		return report
	}
	sc := bufio.NewScanner(bytes.NewReader(stdout))
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	found := false
	for sc.Scan() {
		var r Report
		if json.Unmarshal(sc.Bytes(), &r) == nil && r.Case == c.ID {
			report, found = r, true
		}
	}
	if !found {
		report.Failures = []string{fmt.Sprintf("the case container exited %d without a report: %s", code, tail(string(stderr)))}
	}
	return report
}

func (s *Suite) runContainer(ctx context.Context, fx *fixture, c Case) ([]byte, []byte, int64, error) {
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	name := fmt.Sprintf("%sconformance-%s-%s-%s-%s", s.NamePrefix, s.Language, fx.name, strings.ToLower(c.ID), hex.EncodeToString(suffix))
	profile := container.BuildProfile(api.Resources{CPUs: 1, MemoryMiB: 768})
	hc, err := profile.HostConfig()
	if err != nil {
		return nil, nil, 0, err
	}
	cfg := &containertypes.Config{
		Image: fx.image,
		Entrypoint: []string{
			container.BinaryPath, "conformance", "exec", "--case", c.ID, "--fixture", fx.name, "--entry", fx.entry, "--language", s.Language,
		},
		Cmd:    []string{},
		Labels: map[string]string{"scantor.test": "true"},
	}
	cleanup := context.WithoutCancel(ctx)
	created, err := s.Docker.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: cfg, HostConfig: hc})
	if err != nil {
		return nil, nil, 0, fmt.Errorf("create %s: %w", name, err)
	}
	defer func() {
		_, _ = s.Docker.ContainerRemove(cleanup, created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	if err := container.Inject(ctx, s.Docker, created.ID, s.Binary, nil); err != nil {
		return nil, nil, 0, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, caseTimeout)
	defer cancel()
	wait := s.Docker.ContainerWait(waitCtx, created.ID, client.ContainerWaitOptions{Condition: containertypes.WaitConditionNextExit})
	if _, err := s.Docker.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return nil, nil, 0, fmt.Errorf("start %s: %w", name, err)
	}
	var code int64
	select {
	case res := <-wait.Result:
		code = res.StatusCode
	case err := <-wait.Error:
		_, _ = s.Docker.ContainerKill(cleanup, created.ID, client.ContainerKillOptions{Signal: "SIGKILL"})
		if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
			return nil, nil, 0, fmt.Errorf("the case did not finish within %s", caseTimeout)
		}
		return nil, nil, 0, fmt.Errorf("wait for %s: %w", name, err)
	}
	logs, err := s.Docker.ContainerLogs(cleanup, created.ID, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return nil, nil, code, fmt.Errorf("logs of %s: %w", name, err)
	}
	defer logs.Close()
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, logs); err != nil {
		return nil, nil, code, fmt.Errorf("read the logs of %s: %w", name, err)
	}
	return stdout.Bytes(), stderr.Bytes(), code, nil
}
