package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/version"
)

func testApp(env map[string]string) (*App, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	app := &App{
		Getenv:        func(k string) string { return env[k] },
		Stdin:         strings.NewReader(""),
		Stdout:        &out,
		Stderr:        &errOut,
		Containerized: func() bool { return false },
		format:        string(FormatHuman),
	}
	return app, &out, &errOut
}

// run executes the real command tree with args and returns the exit code main would use.
func run(app *App, args ...string) int {
	root := newRootCommand(app)
	root.SetArgs(args)
	return ExitCode(root.Execute())
}

func TestExitCode(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{nil, 0},
		{SilentExit(1), 1},
		{WithExit(ExitAnalysisFailures, errors.New("2 analyses failed")), 1},
		{UsageError(errors.New("bad flag")), 2},
		{ValidationError(errors.New("bad config")), 2},
		{PlatformError(errors.New("docker down")), 3},
		{fmt.Errorf("wrapped: %w", &api.Error{Status: 404, Code: api.CodeNotFound}), 2},
		{&api.Error{Status: 422, Code: api.CodeConfigInvalid}, 2},
		{&api.Error{Status: 401, Code: api.CodeUnauthorized}, 2},
		{&api.Error{Status: 503, Code: api.CodeBrokerAlarm}, 3},
		{&api.Error{Status: 429, Code: api.CodeTooManyRequests}, 3},
		{&api.Error{Status: 426, Code: api.CodeIncompatibleVersion}, 3},
		{&api.NetworkError{Method: "GET", Path: "/api/x", Err: errors.New("refused")}, 3},
		{context.Canceled, 3},
		{errors.New("unexpected"), 3},
	}
	for _, tc := range cases {
		if got := ExitCode(tc.err); got != tc.want {
			t.Errorf("ExitCode(%v) = %d, want %d", tc.err, got, tc.want)
		}
	}
}

func TestVersionCommand(t *testing.T) {
	app, out, _ := testApp(nil)
	if code := run(app, "version", "-o", "json"); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var info version.Info
	if err := json.Unmarshal(out.Bytes(), &info); err != nil || info.Version != version.Version || info.Go == "" {
		t.Fatalf("json output %q: %v", out.String(), err)
	}

	app, out, _ = testApp(nil)
	if code := run(app, "version"); code != 0 || !strings.HasPrefix(out.String(), "scantor "+version.Version) {
		t.Fatalf("human output %q (exit %d)", out.String(), code)
	}
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{{"frobnicate"}, {"version", "--bogus"}, {"version", "extra"}, {"-o", "yaml", "version"}, {"conformance"}} {
		app, _, errOut := testApp(nil)
		if code := run(app, args...); code != ExitValidation {
			t.Errorf("%v: exit %d, want 2 (stderr %q)", args, code, errOut.String())
		}
		if !strings.Contains(errOut.String(), "Error:") {
			t.Errorf("%v: no error message on stderr: %q", args, errOut.String())
		}
	}
}

// Required flags and flag groups are usage errors (exit 2), also with a PreRun hook of the command.
func TestRequiredFlagsAreUsageErrors(t *testing.T) {
	withRegistry(t, func() {
		var preRan bool
		registerCommand("", func(*App) *cobra.Command {
			cmd := &cobra.Command{Use: "needs", PreRun: func(*cobra.Command, []string) { preRan = true }, RunE: func(*cobra.Command, []string) error { return nil }}
			cmd.Flags().String("name", "", "")
			cmd.Flags().String("a", "", "")
			cmd.Flags().String("b", "", "")
			_ = cmd.MarkFlagRequired("name")
			cmd.MarkFlagsRequiredTogether("a", "b")
			return cmd
		})
		for _, args := range [][]string{{"needs"}, {"needs", "--name", "x", "--a", "1"}} {
			app, _, errOut := testApp(nil)
			if code := run(app, args...); code != ExitValidation || !strings.Contains(errOut.String(), "run 'scantor needs --help'") {
				t.Errorf("%v: exit %d, stderr %q", args, code, errOut.String())
			}
		}
		app, _, errOut := testApp(nil)
		if code := run(app, "needs", "--name", "x", "--a", "1", "--b", "2"); code != 0 || !preRan {
			t.Fatalf("valid flags: exit %d, PreRun ran %v, stderr %q", code, preRan, errOut.String())
		}
	})
}

// withRegistry runs f with an isolated command registry.
func withRegistry(t *testing.T, f func()) {
	t.Helper()
	registryMu.Lock()
	savedRegs, savedGroups := registrations, groups
	registrations, groups = nil, nil
	registryMu.Unlock()
	defer func() {
		registryMu.Lock()
		registrations, groups = savedRegs, savedGroups
		registryMu.Unlock()
	}()
	f()
}

func TestRegistrySeam(t *testing.T) {
	withRegistry(t, func() {
		registerGroup("", "scans", "Manage scans", false)
		registerGroup("", "scans", "duplicate declaration is ignored", false)
		registerGroup("dev", "inner", "nested group", true)
		registerGroup("", "dev", "Develop tasks", false)
		registerCommand("scans", func(app *App) *cobra.Command {
			return &cobra.Command{Use: "fail", Args: cobra.NoArgs, RunE: func(*cobra.Command, []string) error {
				return &api.Error{Status: 409, Code: api.CodeInvalidState, Message: "scan is completed", Method: "POST", Path: "/api/scans/x/pause",
					Details: json.RawMessage(`{"state":"completed","allowed":["running"]}`)}
			}}
		})
		registerCommand("dev inner", func(app *App) *cobra.Command {
			return &cobra.Command{Use: "ok", RunE: func(*cobra.Command, []string) error {
				return app.Output().Print(map[string]int{"n": 1}, func(w io.Writer) error {
					return Table{Headers: []string{"N"}, Rows: [][]string{{"1"}}}.Write(w)
				})
			}}
		})
		registerCommand("", func(app *App) *cobra.Command {
			return &cobra.Command{Use: "quiet", RunE: func(*cobra.Command, []string) error { return SilentExit(ExitAnalysisFailures) }}
		})

		app, out, errOut := testApp(nil)
		if code := run(app, "dev", "inner", "ok", "-o", "json"); code != 0 || strings.TrimSpace(out.String()) != "{\n  \"n\": 1\n}" {
			t.Fatalf("nested command: exit %d, out %q, err %q", code, out.String(), errOut.String())
		}

		app, out, errOut = testApp(nil)
		if code := run(app, "dev", "inner", "ok"); code != 0 || !strings.Contains(out.String(), "N\n1") {
			t.Fatalf("table output %q (exit %d, err %q)", out.String(), code, errOut.String())
		}

		app, _, errOut = testApp(nil)
		if code := run(app, "-o", "json", "scans", "fail"); code != ExitValidation {
			t.Fatalf("api error exit %d", code)
		}
		var doc struct {
			Error struct {
				Code     string          `json:"code"`
				ExitCode int             `json:"exitCode"`
				Status   int             `json:"status"`
				Details  json.RawMessage `json:"details"`
			} `json:"error"`
		}
		if err := json.Unmarshal(errOut.Bytes(), &doc); err != nil || doc.Error.Code != api.CodeInvalidState || doc.Error.Status != 409 || doc.Error.ExitCode != 2 {
			t.Fatalf("json error %q: %v", errOut.String(), err)
		}
		if strings.Count(errOut.String(), "invalidState") != 1 {
			t.Fatalf("error printed more than once: %q", errOut.String())
		}

		app, _, errOut = testApp(nil)
		if code := run(app, "quiet"); code != ExitAnalysisFailures || errOut.Len() != 0 {
			t.Fatalf("silent exit: %d, stderr %q", code, errOut.String())
		}

		app, _, errOut = testApp(nil)
		if code := run(app, "scans", "nope"); code != ExitValidation || !strings.Contains(errOut.String(), `unknown command "nope"`) {
			t.Fatalf("unknown subcommand: exit %d, stderr %q", code, errOut.String())
		}
		app, out, _ = testApp(nil)
		if code := run(app, "scans"); code != 0 || !strings.Contains(out.String(), "fail") {
			t.Fatalf("group help: exit %d, out %q", code, out.String())
		}
	})
}

func TestRegistryErrors(t *testing.T) {
	withRegistry(t, func() {
		registerCommand("missing", func(*App) *cobra.Command { return &cobra.Command{Use: "x"} })
		app, _, _ := testApp(nil)
		if err := attachCommands(&cobra.Command{Use: "scantor"}, app); err == nil {
			t.Fatal("unknown parent accepted")
		}
	})
	withRegistry(t, func() {
		build := func(*App) *cobra.Command { return &cobra.Command{Use: "dup"} }
		registerCommand("", build)
		registerCommand("", build)
		app, _, _ := testApp(nil)
		if err := attachCommands(&cobra.Command{Use: "scantor"}, app); err == nil {
			t.Fatal("duplicate command accepted")
		}
	})
}

// interruptSelf sends SIGINT to the test process and waits until ctx (which must be an InterruptContext)
// is cancelled.
func interruptSelf(t *testing.T, ctx context.Context) {
	t.Helper()
	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the command context was not cancelled by SIGINT")
	}
}

// Every command runs with InterruptContext; an error after the signal is reported as an interrupt (exit
// 3), a silent exit keeps its code.
func TestInterruptIsPlatformError(t *testing.T) {
	withRegistry(t, func() {
		registerCommand("", func(*App) *cobra.Command {
			return &cobra.Command{Use: "block", RunE: func(cmd *cobra.Command, _ []string) error {
				interruptSelf(t, cmd.Context())
				return fmt.Errorf("list scans: %w", cmd.Context().Err())
			}}
		})
		registerCommand("", func(*App) *cobra.Command {
			return &cobra.Command{Use: "summary", RunE: func(cmd *cobra.Command, _ []string) error {
				interruptSelf(t, cmd.Context())
				return SilentExit(ExitAnalysisFailures)
			}}
		})
		app, _, errOut := testApp(nil)
		if code := run(app, "-o", "json", "block"); code != ExitPlatform {
			t.Fatalf("exit %d, want 3 (stderr %q)", code, errOut.String())
		}
		var doc struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(errOut.Bytes(), &doc); err != nil || doc.Error.Code != "platform" || doc.Error.Message != "interrupted" {
			t.Fatalf("stderr %q: %v", errOut.String(), err)
		}
		app, _, errOut = testApp(nil)
		if code := run(app, "summary"); code != ExitAnalysisFailures || errOut.Len() != 0 {
			t.Fatalf("silent exit after an interrupt: exit %d, stderr %q", code, errOut.String())
		}
	})
}

// A request in flight when SIGINT arrives ends the command with exit 3 and the JSON error document,
// for commands without a wait of their own (CLI-5).
func TestInterruptDuringRequest(t *testing.T) {
	f := newAPIFake(t)
	f.on("GET", "/api/scans", func(w http.ResponseWriter, r *http.Request) {
		_ = syscall.Kill(os.Getpid(), syscall.SIGINT)
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
			apiFakeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "nextCursor": nil})
		}
	})
	code, out, errOut := f.exec("-o", "json", "scans", "list")
	if code != ExitPlatform || out != "" || !strings.Contains(errOut, `"message":"interrupted"`) {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, out, errOut)
	}
}

// The runtime roles handle signals themselves; everything else runs with InterruptContext.
func TestRuntimeOwnsSignals(t *testing.T) {
	app, _, _ := testApp(nil)
	root := newRootCommand(app)
	for _, path := range [][]string{{"runtime", "worker"}, {"runtime", "local"}, {"runtime", "describe"}, {"runtime", "check"}} {
		cmd, _, err := root.Find(path)
		if err != nil || !ownsSignals(cmd) {
			t.Errorf("%v: ownsSignals = false (%v)", path, err)
		}
	}
	for _, path := range [][]string{{"scans", "list"}, {"node"}, {"workspace", "snapshot"}, {"dev", "run"}} {
		cmd, _, err := root.Find(path)
		if err != nil || ownsSignals(cmd) {
			t.Errorf("%v: ownsSignals = true (%v)", path, err)
		}
	}
}

// The real registrations of every command file must assemble without errors.
func TestRealTreeBuilds(t *testing.T) {
	app, _, _ := testApp(nil)
	root := newRootCommand(app)
	if _, _, err := root.Find([]string{"version"}); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := LoadConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != DefaultURL || cfg.Token != "" || cfg.DevMode != DevModeLocal || cfg.Images.Active() ||
		cfg.DataSources.Tranco != DefaultTrancoURL || cfg.DataSources.Crux != DefaultCruxURL ||
		cfg.Limits.MaxWorkersPerScan != 100 || cfg.Limits.MaxProcessesPerWorker != 64 ||
		cfg.Pipeline.BuildTimeout != DefaultBuildTimeout || cfg.Pipeline.TaskMaxFiles != 5000 ||
		cfg.Pipeline.TaskMaxPackBytes != 50<<20 || cfg.Pipeline.MaxImageBytes != 10<<30 ||
		cfg.Pipeline.PublicURL != DefaultPublicURL || cfg.Pipeline.RegistryPublicHost != DefaultRegistryPublicHost {
		t.Fatalf("defaults = %+v", cfg)
	}
	// The CLI never prunes the (shared) BuildKit cache unless SCANTOR_BUILD_CACHE_MAX_BYTES is set.
	if cfg.Pipeline.BuildCacheMaxBytes != 0 {
		t.Fatalf("BuildCacheMaxBytes = %d, want 0 when unset", cfg.Pipeline.BuildCacheMaxBytes)
	}
}

func TestLoadConfigValues(t *testing.T) {
	env := map[string]string{
		"SCANTOR_URL":                      "https://scantor.example.com/",
		"SCANTOR_TOKEN":                    "sk_scantor_abc",
		"SCANTOR_DEV_MODE":                 "remote",
		"SCANTOR_WORKSPACE":                "/home/coder/workspace",
		"SCANTOR_IMAGE_PREFIX":             "ghcr.io/lonetis/",
		"SCANTOR_IMAGE_TAG":                "1.4.0",
		"SCANTOR_MAX_PROCESSES_PER_WORKER": "8",
		"SCANTOR_TASK_MAX_BYTES":           "1GiB",
		"SCANTOR_BUILD_TIMEOUT":            "bogus",
		"SCANTOR_BUILD_CACHE_MAX_BYTES":    "20GiB",
	}
	cfg, err := LoadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "https://scantor.example.com" || cfg.DevMode != DevModeRemote || cfg.Workspace != "/home/coder/workspace" ||
		cfg.Images != (version.ImageOverride{Prefix: "ghcr.io/lonetis/", Tag: "1.4.0"}) || cfg.Limits.MaxProcessesPerWorker != 8 ||
		cfg.Pipeline.TaskMaxBytes != 1<<30 || cfg.Pipeline.BuildTimeout != DefaultBuildTimeout || cfg.Pipeline.BuildCacheMaxBytes != 20<<30 {
		t.Fatalf("config = %+v", cfg)
	}
	if len(cfg.Warnings) != 1 || !strings.Contains(cfg.Warnings[0], "SCANTOR_BUILD_TIMEOUT") {
		t.Fatalf("warnings = %v", cfg.Warnings)
	}

	for name, value := range map[string]string{
		"SCANTOR_URL":          "ftp://x",
		"SCANTOR_TOKEN":        "ghp_notakey",
		"SCANTOR_CA_CERT":      "not a pem",
		"SCANTOR_DEV_MODE":     "cloud",
		"SCANTOR_IMAGE_PREFIX": "ghcr.io/lonetis",
	} {
		_, err := LoadConfig(func(k string) string {
			if k == name {
				return value
			}
			return ""
		})
		if err == nil || ExitCode(err) != ExitValidation || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%q: err = %v", name, value, err)
		}
		if strings.Contains(fmt.Sprint(err), value) {
			t.Errorf("%s: the error repeats the value: %v", name, err)
		}
	}
}

func TestEffectiveURL(t *testing.T) {
	cases := []struct {
		url           string
		containerized bool
		want          string
	}{
		{"http://localhost:3000", false, "http://localhost:3000"},
		{"http://localhost:3000", true, "http://host.docker.internal:3000"},
		{"http://127.0.0.1:3000", true, "http://host.docker.internal:3000"},
		{"http://[::1]:3000", true, "http://host.docker.internal:3000"},
		{"http://localhost", true, "http://host.docker.internal"},
		{"http://orchestrator:3000", true, "http://orchestrator:3000"},
		{"https://scantor.example.com", true, "https://scantor.example.com"},
	}
	for _, tc := range cases {
		if got := (Config{URL: tc.url}).EffectiveURL(tc.containerized); got != tc.want {
			t.Errorf("EffectiveURL(%s, %v) = %s, want %s", tc.url, tc.containerized, got, tc.want)
		}
	}
}

func TestAPIClientFromConfig(t *testing.T) {
	app, _, _ := testApp(map[string]string{})
	if _, err := app.APIClient(); err == nil || ExitCode(err) != ExitValidation {
		t.Fatalf("missing token: %v", err)
	}
	app, _, _ = testApp(map[string]string{"SCANTOR_URL": "http://localhost:3000", "SCANTOR_TOKEN": "sk_scantor_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl"})
	app.Containerized = func() bool { return true }
	c, err := app.APIClient()
	if err != nil {
		t.Fatal(err)
	}
	if c.BaseURL() != "http://host.docker.internal:3000" {
		t.Fatalf("BaseURL = %s", c.BaseURL())
	}
}

func TestPrintErrorHuman(t *testing.T) {
	var errOut bytes.Buffer
	o := &Output{Format: FormatHuman, Out: io.Discard, Err: &errOut}
	o.PrintError(&api.Error{Status: http.StatusUnprocessableEntity, Code: api.CodeConfigInvalid, Message: "taskConfig is invalid",
		Details: json.RawMessage(`{"issues":[{"path":"/greeting","message":"must be string"}]}`)})
	if !strings.Contains(errOut.String(), "Error: taskConfig is invalid") || !strings.Contains(errOut.String(), "/greeting: must be string") {
		t.Fatalf("stderr = %q", errOut.String())
	}
	errOut.Reset()
	o.PrintError(errors.New("dial amqp://u:secretpw@h failed"))
	if strings.Contains(errOut.String(), "secretpw") {
		t.Fatalf("error not redacted: %q", errOut.String())
	}
}

func TestHumanHelpers(t *testing.T) {
	if HumanBytes(512) != "512 B" || HumanBytes(1536) != "1.5 KiB" || HumanSize(512<<20) != "512MiB" || HumanDuration(40) != "40ms" || HumanDuration(1200) != "1.2s" {
		t.Fatal("human helpers")
	}
	if FormatBuildError(api.BuildError{Phase: api.BuildPhaseStatic, File: "Dockerfile", Line: 3, Message: "x"}) != "[static] Dockerfile:3: x" {
		t.Fatal("FormatBuildError")
	}
}
