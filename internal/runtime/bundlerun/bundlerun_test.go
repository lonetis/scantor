package bundlerun

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
	"github.com/lonetis/scantor/internal/runtime/local"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

// testNow is the start time of the test runs: their default run directory is results/20261120T090000Z.
var testNow = time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)

const testStamp = "20261120T090000Z"

// testInfo is the canonical bundle info with the schedule and describe output the fake connector matches:
// a task config with a secret token, an open analysis config with a secret, the result field text as a
// secret and the upload field /upload of the scan config.
func testInfo(t *testing.T, schedule api.Schedule) *bundle.Info {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "bundle", "testdata", "bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	info, err := bundle.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	d := &info.Description
	d.Schedule = schedule
	d.Schemas.TaskConfig = json.RawMessage(`{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"token":{"type":["string","null"],"writeOnly":true,"default":null}},"additionalProperties":false}`)
	d.Schemas.ScanConfig = json.RawMessage(`{"type":"object"}`)
	d.Schemas.AnalysisConfig = json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","default":"world"}}}`)
	d.SecretPaths = api.SecretPaths{TaskConfig: []string{"/token"}, ScanConfig: []string{"/password"}, AnalysisConfig: []string{"/secret"}, Result: []string{"/text"}}
	d.UploadPaths = api.UploadPaths{TaskConfig: []string{}, ScanConfig: []string{"/upload"}}
	return info
}

var (
	rangeSchedule  = api.Schedule{Kind: api.ScheduleKindTemplate, Template: "range"}
	singleSchedule = api.Schedule{Kind: api.ScheduleKindTemplate, Template: "single"}
	customSchedule = api.Schedule{Kind: api.ScheduleKindCustom}
)

// fakeConnector is the runtime config of the fake connector with the schedule kind of the info.
func fakeConnector(t *testing.T, schedule api.Schedule) runtime.Config {
	t.Helper()
	argv, extra := fakeconn.Command("ok")
	environ := append(os.Environ(), extra...)
	kind := schedule.Template
	if schedule.Kind == api.ScheduleKindCustom {
		kind = "custom"
	}
	environ = append(environ, fakeconn.EnvSchedule+"="+kind)
	return runtime.Config{
		Language: "python", ConnectorCmd: strconv.Quote(argv[0]) + " " + argv[1],
		WorkRoot: filepath.Join(t.TempDir(), "scantor"), Environ: environ,
	}
}

// mounted is the RootDevice of a work directory on a mount: no file shares the device.
func mounted() (uint64, error) { return math.MaxUint64, nil }

// noMountPoints is the MountPoints of a container without mounts, so the tests do not depend on the mounts of
// the machine that runs them.
func noMountPoints() ([]string, error) { return nil, nil }

type testRun struct {
	opts           Options
	stdout, stderr *syncBuffer
}

// syncBuffer is a bytes.Buffer safe for the concurrent writes of the console and the runtime log.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func newTestRun(t *testing.T, schedule api.Schedule, flags Flags) *testRun {
	t.Helper()
	tr := &testRun{stdout: &syncBuffer{}, stderr: &syncBuffer{}}
	tr.opts = Options{
		Info: testInfo(t, schedule), Flags: flags, Config: fakeConnector(t, schedule),
		Stdout: tr.stdout, Stderr: tr.stderr, WorkDir: t.TempDir(), TaskDir: t.TempDir(),
		Now: func() time.Time { return testNow }, RootDevice: mounted, MountPoints: noMountPoints,
	}
	return tr
}

func (tr *testRun) run(t *testing.T) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return Run(ctx, tr.opts)
}

func (tr *testRun) runDir() string {
	return filepath.Join(tr.opts.WorkDir, ResultsDir, testStamp)
}

func readRunInfo(t *testing.T, dir string) RunInfo {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, RunFile))
	if err != nil {
		t.Fatal(err)
	}
	var info RunInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatalf("run.json: %v\n%s", err, data)
	}
	return info
}

// compact returns raw without insignificant whitespace.
func compact(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return b.String()
}

func readLines(t *testing.T, dir string) []map[string]any {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, ResultsFile))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var lines []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var l map[string]any
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			t.Fatalf("results.jsonl line %q: %v", sc.Text(), err)
		}
		lines = append(lines, l)
	}
	return lines
}

func TestRunWritesTheRunDirectory(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{TaskConfig: `{"token":"s3cret"}`, ScanConfig: `{"end":3}`, Processes: 2})
	if code := tr.run(t); code != local.ExitOK {
		t.Fatalf("exit %d\nstdout %s\nstderr %s", code, tr.stdout, tr.stderr)
	}
	dir := tr.runDir()
	info := readRunInfo(t, dir)
	if info.V != RunFileVersion || info.Bundle.Ref != "echo@3" || info.Bundle.Image != "localhost/scantor/echo:3" || info.Bundle.Platform.Arch != "amd64" {
		t.Fatalf("run.json bundle %+v", info)
	}
	if info.Reason == nil || *info.Reason != local.ReasonDone || info.ExitCode == nil || *info.ExitCode != 0 || info.FinishedAt == nil {
		t.Fatalf("run.json end %+v", info)
	}
	if info.Summary != (local.Summary{Analyses: 3, Succeeded: 3}) || info.Settings.Processes != 2 || info.Limit != 0 {
		t.Fatalf("run.json summary %+v, settings %+v", info.Summary, info.Settings)
	}
	if compact(t, info.TaskConfig) != `{"greeting":"Hello","token":"***"}` {
		t.Fatalf("run.json taskConfig %s", info.TaskConfig)
	}
	if res, ok := info.Resolved["schedule"]; !ok || res.Template != "range" || res.ExpectedTotal == nil || *res.ExpectedTotal != 3 {
		t.Fatalf("run.json resolved %+v", info.Resolved)
	}
	lines := readLines(t, dir)
	if len(lines) != 3 {
		t.Fatalf("%d lines", len(lines))
	}
	for _, l := range lines {
		if _, ok := l["type"]; ok || l["status"] != "succeeded" || l["logTail"] != "" {
			t.Fatalf("line %v", l)
		}
		if res := l["result"].(map[string]any); res["text"] != "***" {
			t.Fatalf("result not masked: %v", res)
		}
	}
	if fi, err := os.Stat(filepath.Join(dir, "files")); err != nil || !fi.IsDir() {
		t.Fatalf("files directory: %v", err)
	}
	out := tr.stdout.String()
	for _, want := range []string{"echo@3 (linux/amd64): template range, 2 processes, no limit; results in results/" + testStamp, "resolved range (schedule): 3 analyses expected", "finished (done) after", "3 analyses, 3 succeeded, 0 failed", "results: results/" + testStamp + "/results.jsonl", "exit code 0"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "s3cret") || strings.Contains(tr.stderr.String(), "s3cret") {
		t.Fatal("the secret reached the console")
	}

	// A second run in the same second gets the next name.
	if code := tr.run(t); code != local.ExitOK {
		t.Fatalf("second run: exit %d", code)
	}
	if _, err := os.Stat(filepath.Join(tr.opts.WorkDir, ResultsDir, testStamp+"-2", RunFile)); err != nil {
		t.Fatalf("second run directory: %v", err)
	}
}

// A run claims its default run directory when it starts: a run that took the name after this run's checks
// (another container started in the same second) moves it to the next suffix instead of failing.
func TestRunClaimsTheDefaultDirectory(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{ScanConfig: `{"end":1}`})
	o := tr.opts.withDefaults()
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	taken := tr.runDir()
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taken, ResultsFile), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if code := o.run(ctx, p); code != local.ExitOK {
		t.Fatalf("exit %d\nstdout %s\nstderr %s", code, tr.stdout, tr.stderr)
	}
	if info := readRunInfo(t, taken+"-2"); info.Summary.Analyses != 1 {
		t.Fatalf("run.json %+v", info)
	}
	if !strings.Contains(tr.stdout.String(), "results in results/"+testStamp+"-2") {
		t.Fatalf("stdout %s", tr.stdout)
	}

	// Runs started together in one folder get a directory each.
	work := t.TempDir()
	codes := make([]int, 3)
	var wg sync.WaitGroup
	for i := range codes {
		run := newTestRun(t, rangeSchedule, Flags{ScanConfig: `{"end":1}`})
		run.opts.WorkDir = work
		wg.Go(func() { codes[i] = run.run(t) })
	}
	wg.Wait()
	for i, code := range codes {
		if code != local.ExitOK {
			t.Fatalf("run %d: exit %d", i, code)
		}
	}
	for _, name := range []string{testStamp, testStamp + "-2", testStamp + "-3"} {
		if lines := readLines(t, filepath.Join(work, ResultsDir, name)); len(lines) != 1 {
			t.Fatalf("%s: %d lines", name, len(lines))
		}
	}
}

// A --out directory that another run filled after this run's checks is a usage error (exit 2).
func TestRunOutTakenMeanwhile(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{Out: "runs/x"})
	o := tr.opts.withDefaults()
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	dir := filepath.Join(tr.opts.WorkDir, "runs", "x")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ResultsFile), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := o.run(context.Background(), p); code != local.ExitValidation {
		t.Fatalf("exit %d\nstderr %s", code, tr.stderr)
	}
	if !strings.Contains(tr.stderr.String(), "--out: "+dir+" is not empty; every run needs a new or empty directory") {
		t.Fatalf("stderr %s", tr.stderr)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, ResultsFile)); string(data) != "{}\n" {
		t.Fatalf("the other run's results changed: %q", data)
	}
}

// A failed analysis is retried per the settings (the backoff applies uncapped) and ends the run with exit 1.
func TestRunFailures(t *testing.T) {
	tr := newTestRun(t, singleSchedule, Flags{AnalysisConfig: `{"mode":"throw","secret":"hunter2"}`, Settings: `{"maxAttempts":2,"backoff":{"initialMs":1000,"jitter":false}}`})
	started := time.Now()
	if code := tr.run(t); code != local.ExitFailures {
		t.Fatalf("exit %d\n%s", code, tr.stderr)
	}
	if elapsed := time.Since(started); elapsed < time.Second {
		t.Fatalf("the retry did not wait for the backoff: %s", elapsed)
	}
	lines := readLines(t, tr.runDir())
	if len(lines) != 1 {
		t.Fatalf("%d lines", len(lines))
	}
	l := lines[0]
	if l["status"] != "failed" || l["attempt"] != float64(2) || l["error"].(map[string]any)["type"] != "taskError" || l["result"] != nil {
		t.Fatalf("line %v", l)
	}
	if cfg := l["config"].(map[string]any); cfg["secret"] != "***" || cfg["name"] != "world" {
		t.Fatalf("config %v", cfg)
	}
	attempts := l["attempts"].([]any)
	if _, ok := attempts[0].(map[string]any)["logTail"].(string); len(attempts) != 1 || !ok {
		t.Fatalf("attempts %v", attempts)
	}
	if !strings.Contains(tr.stdout.String(), "#0 failed (taskError, attempt 2): boom") {
		t.Fatalf("stdout %s", tr.stdout)
	}
	if info := readRunInfo(t, tr.runDir()); compact(t, info.AnalysisConfig) != `{"mode":"throw","name":"world","secret":"***"}` || *info.ExitCode != 1 || info.Settings.MaxAttempts != 2 {
		t.Fatalf("run.json %s %v %+v", info.AnalysisConfig, *info.ExitCode, info.Settings)
	}
}

func TestRunJSONEvents(t *testing.T) {
	tr := newTestRun(t, singleSchedule, Flags{AnalysisConfig: `{"secret":"hunter2"}`})
	tr.opts.JSON = true
	if code := tr.run(t); code != local.ExitOK {
		t.Fatalf("exit %d", code)
	}
	var types []string
	sc := bufio.NewScanner(strings.NewReader(tr.stdout.String()))
	for sc.Scan() {
		var ev map[string]any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("not NDJSON: %q", sc.Text())
		}
		typ, _ := ev["type"].(string)
		types = append(types, typ)
		if typ == local.EventScheduled || typ == local.EventResult {
			if ev["config"].(map[string]any)["secret"] != "***" {
				t.Fatalf("%s event not masked: %v", typ, ev)
			}
		}
	}
	joined := strings.Join(types, ",")
	if !strings.Contains(joined, "start") || !strings.Contains(joined, "scheduled") || !strings.Contains(joined, "result") || types[len(types)-1] != "end" {
		t.Fatalf("event types %v", types)
	}
	if strings.Contains(tr.stdout.String(), "hunter2") {
		t.Fatal("the secret reached stdout")
	}
}

func TestRunUploadFile(t *testing.T) {
	listSchedule := api.Schedule{Kind: api.ScheduleKindTemplate, Template: "list"}
	tr := newTestRun(t, listSchedule, Flags{ScanConfig: `{"upload":"lists/targets.txt"}`})
	content := "a.example\nb.example\n\nc.example\n"
	if err := os.MkdirAll(filepath.Join(tr.opts.WorkDir, "lists"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tr.opts.WorkDir, "lists", "targets.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := tr.run(t); code != local.ExitOK {
		t.Fatalf("exit %d\n%s\n%s", code, tr.stdout, tr.stderr)
	}
	lines := readLines(t, tr.runDir())
	if len(lines) != 3 || lines[0]["config"].(map[string]any)["item"] == nil {
		t.Fatalf("lines %v", lines)
	}
	info := readRunInfo(t, tr.runDir())
	digest := sha256.Sum256([]byte(content))
	sum := hex.EncodeToString(digest[:])
	if len(info.Uploads) != 1 || info.Uploads[0].Pointer != "/scanConfig/upload" || info.Uploads[0].SHA256 != sum || info.Uploads[0].Path != filepath.Join(tr.opts.WorkDir, "lists", "targets.txt") {
		t.Fatalf("uploads %+v", info.Uploads)
	}
	if want := uuid.NewSHA1(UploadNamespace, []byte(sum)).String(); info.Uploads[0].ID != want || !strings.Contains(string(info.ScanConfig), want) {
		t.Fatalf("upload id %s, scan config %s, want %s", info.Uploads[0].ID, info.ScanConfig, want)
	}

	// A platform upload id cannot be read: exit 2 and nothing is written.
	tr = newTestRun(t, listSchedule, Flags{ScanConfig: `{"upload":"4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b"}`})
	if code := tr.run(t); code != local.ExitValidation || !strings.Contains(tr.stderr.String(), "/scanConfig/upload: is a platform upload id") {
		t.Fatalf("exit %d, stderr %s", code, tr.stderr)
	}
	if _, err := os.Stat(filepath.Join(tr.opts.WorkDir, ResultsDir)); !os.IsNotExist(err) {
		t.Fatalf("a rejected run wrote %s: %v", ResultsDir, err)
	}
}

func TestRunInvalidConfigWritesNothing(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{TaskConfig: `{"greeting":5}`, Settings: `{"workers":2}`})
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("exit %d", code)
	}
	errOut := tr.stderr.String()
	for _, want := range []string{"/taskConfig/greeting: ", "settings.workers: is not a setting of a bundle run", "nothing was run"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	if entries, _ := os.ReadDir(tr.opts.WorkDir); len(entries) != 0 {
		t.Fatalf("a rejected run wrote %v", entries)
	}

	tr = newTestRun(t, rangeSchedule, Flags{TaskConfig: `[1]`})
	tr.opts.JSON = true
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("json: exit %d", code)
	}
	lines := strings.Split(strings.TrimSpace(tr.stdout.String()), "\n")
	var errEv, endEv map[string]any
	if len(lines) != 2 || json.Unmarshal([]byte(lines[0]), &errEv) != nil || json.Unmarshal([]byte(lines[1]), &endEv) != nil {
		t.Fatalf("json output %q", tr.stdout)
	}
	if errEv["type"] != "error" || endEv["type"] != "end" || endEv["reason"] != local.ReasonStartFailed || endEv["exitCode"] != float64(2) {
		t.Fatalf("events %v %v", errEv, endEv)
	}
	issues := errEv["error"].(map[string]any)["details"].(map[string]any)["issues"].([]any)
	if issues[0].(map[string]any)["path"] != "--task-config" {
		t.Fatalf("issues %v", issues)
	}
}

// A secret that fails a pattern or format check is reported without its value: on stderr, in the -o json error
// event and in --describe (docs/security.md BDL-7). The messages of other fields keep the value.
func TestRunConfigIssuesHideSecrets(t *testing.T) {
	const secret = "hunter2-TOP-SECRET-value"
	flags := Flags{TaskConfig: `{"token":"` + secret + `","mail":"` + secret + `","list":["` + secret + `"],"name":"` + secret + `"}`}
	newRun := func(flags Flags) *testRun {
		tr := newTestRun(t, rangeSchedule, flags)
		d := &tr.opts.Info.Description
		d.Schemas.TaskConfig = json.RawMessage(`{"type":"object","properties":{
			"token":{"type":"string","writeOnly":true,"pattern":"^sk_"},
			"mail":{"type":"string","writeOnly":true,"format":"email"},
			"list":{"type":"array","items":{"type":"string","writeOnly":true,"format":"uri"}},
			"name":{"type":"string","pattern":"^[a-z]+$"}}}`)
		d.SecretPaths.TaskConfig = []string{"/token", "/mail", "/list/*"}
		return tr
	}
	wantPaths := []string{"/taskConfig/token: does not satisfy the schema's pattern", "/taskConfig/mail: does not satisfy the schema's format", "/taskConfig/list/0: does not satisfy the schema's format"}

	tr := newRun(flags)
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("exit %d", code)
	}
	errOut := tr.stderr.String()
	for _, want := range wantPaths {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	// The value of a field that is not secret is still quoted.
	if strings.Count(errOut, secret) != 1 || !strings.Contains(errOut, "/taskConfig/name: '"+secret+"' does not match pattern") {
		t.Fatalf("stderr shows a secret or hides the plain field:\n%s", errOut)
	}

	flags.TaskConfig = `{"token":"` + secret + `","mail":"` + secret + `","list":["` + secret + `"]}`
	tr = newRun(flags)
	tr.opts.JSON = true
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("json: exit %d", code)
	}
	if out := tr.stdout.String(); strings.Contains(out, secret) || !strings.Contains(out, `"path":"/taskConfig/token"`) {
		t.Fatalf("json output shows the secret or lacks the issue:\n%s", out)
	}

	flags.Describe = true
	tr = newRun(flags)
	tr.opts.JSON = true
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("describe: exit %d", code)
	}
	var d Description
	if err := json.Unmarshal([]byte(tr.stdout.String()), &d); err != nil {
		t.Fatalf("%v\n%s", err, tr.stdout)
	}
	if strings.Contains(tr.stdout.String(), secret) || !strings.Contains(issueText(d.Issues), wantPaths[0]) || len(d.Issues) != 3 {
		t.Fatalf("describe shows the secret or lacks the issues:\n%s", tr.stdout)
	}
}

func TestUnderSecret(t *testing.T) {
	secrets := []string{"/token", "/hosts/*/password", "/a~1b"}
	for path, want := range map[string]bool{
		"/token": true, "/token/x": true, "/tokens": false, "": false, "/hosts/0/password": true,
		"/hosts/0/password/0": true, "/hosts/0": false, "/hosts/0/user": false, "/a~1b": true, "/a": false,
	} {
		if got := underSecret(path, secrets); got != want {
			t.Errorf("underSecret(%q) = %v", path, got)
		}
	}
	if !underSecret("/anything", []string{""}) || underSecret("/token", nil) {
		t.Fatal("root secret or no secrets")
	}
}

func TestRunInterrupted(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{ScanConfig: `{"end":1000000000000}`})
	signals := make(chan os.Signal, 1)
	tr.opts.Signals = signals
	go func() {
		// Interrupt once results arrive while the unbounded schedule still produces.
		for {
			time.Sleep(20 * time.Millisecond)
			if data, err := os.ReadFile(filepath.Join(tr.runDir(), ResultsFile)); err == nil && bytes.Count(data, []byte("\n")) >= 3 {
				signals <- syscall.SIGINT
				return
			}
		}
	}()
	if code := tr.run(t); code != local.ExitPlatform {
		t.Fatalf("exit %d", code)
	}
	info := readRunInfo(t, tr.runDir())
	if *info.Reason != local.ReasonInterrupted || *info.ExitCode != 3 || info.Summary.Analyses < 3 {
		t.Fatalf("run.json %+v", info)
	}
}

func TestRunWithoutMount(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{})
	tr.opts.RootDevice = func() (uint64, error) {
		fi, err := os.Stat(tr.opts.WorkDir)
		if err != nil {
			return 0, err
		}
		dev, _ := device(fi)
		return dev, nil
	}
	if code := tr.run(t); code != local.ExitValidation || !strings.Contains(tr.stderr.String(), `docker run --rm -v "$PWD:`) {
		t.Fatalf("exit %d, stderr %s", code, tr.stderr)
	}
}

func TestReapOutsidePID1(t *testing.T) {
	if code, handled := Reap([]string{"runtime", "bundle"}); handled || code != 0 {
		t.Fatalf("Reap handled the run outside PID 1 (code %d)", code)
	}
}

func TestUsage(t *testing.T) {
	u := Usage(testInfo(t, rangeSchedule))
	for _, want := range []string{`docker run --rm -v "$PWD:/work" localhost/scantor/echo:3 [flags]`, "--task-config json", "--log-tails which", "-o, --output format", "echo@3 (python, linux/amd64)", `-v "${PWD}:/work"`, `-v "%cd%:/work"`, "MSYS_NO_PATHCONV=1"} {
		if !strings.Contains(u, want) {
			t.Errorf("usage lacks %q:\n%s", want, u)
		}
	}
	for _, f := range FlagDocs {
		if !strings.Contains(u, "--"+f.Name) || FlagHelp(f.Name) != f.Help {
			t.Errorf("flag %s", f.Name)
		}
	}
}
