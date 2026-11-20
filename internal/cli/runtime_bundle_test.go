package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/runtime/bundlerun"
)

// useBundleInfo points `runtime bundle` at path (the canonical test info when empty) and captures the
// options of the run, which returns code.
func useBundleInfo(t *testing.T, path string, code int) *bundlerun.Options {
	t.Helper()
	if path == "" {
		path = filepath.Join("..", "bundle", "testdata", "bundle.json")
	}
	infoPath, run := bundleInfoPath, runBundle
	t.Cleanup(func() { bundleInfoPath, runBundle = infoPath, run })
	bundleInfoPath = path
	captured := &bundlerun.Options{}
	runBundle = func(_ context.Context, o bundlerun.Options) int {
		*captured = o
		return code
	}
	return captured
}

func TestRuntimeBundleFlags(t *testing.T) {
	opts := useBundleInfo(t, "", 1)
	app, _, _ := testApp(map[string]string{"SCANTOR_TRANCO_URL": "https://tranco.example.org"})
	code := run(app, "runtime", "bundle", "--task-config", `{"text":"hi"}`, "--scan-config", "@scan.json", "--analysis-config", "-",
		"--settings", `{"maxAttempts":2}`, "--processes", "3", "--limit", "5", "--total-timeout", "1m30s", "--out", "runs/a",
		"--log-tails", "all", "--describe", "-o", "json")
	if code != 1 {
		t.Fatalf("exit %d; the run's code passes through", code)
	}
	want := bundlerun.Flags{
		TaskConfig: `{"text":"hi"}`, ScanConfig: "@scan.json", AnalysisConfig: "-", Settings: `{"maxAttempts":2}`,
		Processes: 3, Limit: 5, TotalTimeout: 90 * time.Second, Out: "runs/a", LogTails: "all", Describe: true,
	}
	if opts.Flags != want || !opts.JSON {
		t.Fatalf("flags %+v json %v", opts.Flags, opts.JSON)
	}
	if opts.Info == nil || opts.Info.Ref != "echo@3" || opts.Config.DataSources.Tranco != "https://tranco.example.org" || opts.Signals == nil || opts.Stdin == nil {
		t.Fatalf("options %+v", opts)
	}

	opts = useBundleInfo(t, "", 0)
	app, _, _ = testApp(nil)
	if code := run(app, "runtime", "bundle"); code != 0 || opts.Flags.LogTails != bundlerun.LogTailsFailed || opts.JSON || opts.Flags.Limit != 0 {
		t.Fatalf("defaults: exit %d, %+v", code, opts)
	}
}

func TestRuntimeBundleWithoutInfo(t *testing.T) {
	useBundleInfo(t, filepath.Join(t.TempDir(), "bundle.json"), 0)
	app, _, errOut := testApp(nil)
	if code := run(app, "runtime", "bundle"); code != ExitPlatform || !strings.Contains(errOut.String(), "not a scantor bundle image") {
		t.Fatalf("exit %d, stderr %s", code, errOut)
	}

	invalid := filepath.Join(t.TempDir(), "bundle.json")
	if err := os.WriteFile(invalid, []byte(`{"v":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	useBundleInfo(t, invalid, 0)
	app, _, errOut = testApp(nil)
	if code := run(app, "runtime", "bundle"); code != ExitPlatform || !strings.Contains(errOut.String(), "not a scantor bundle image") {
		t.Fatalf("invalid info: exit %d, stderr %s", code, errOut)
	}
}

func TestRuntimeBundleInvalidEnvironment(t *testing.T) {
	useBundleInfo(t, "", 0)
	app, _, _ := testApp(map[string]string{"SCANTOR_CRUX_URL": "ftp://crux.example.org"})
	if code := run(app, "runtime", "bundle"); code != ExitPlatform {
		t.Fatalf("exit %d", code)
	}
}

func TestRuntimeBundleHelp(t *testing.T) {
	useBundleInfo(t, "", 0)
	app, out, _ := testApp(nil)
	if code := run(app, "runtime", "bundle", "--help"); code != 0 || !strings.Contains(out.String(), `docker run --rm -v "$PWD:/work" localhost/scantor/echo:3 [flags]`) {
		t.Fatalf("exit %d, help %s", code, out)
	}
	if strings.Contains(out.String(), "runtime bundle") {
		t.Fatalf("the help names the hidden command:\n%s", out)
	}

	// Outside a bundle image the command's own help remains.
	useBundleInfo(t, filepath.Join(t.TempDir(), "missing.json"), 0)
	app, out, _ = testApp(nil)
	if code := run(app, "runtime", "bundle", "--help"); code != 0 || !strings.Contains(out.String(), "--task-config") || !strings.Contains(out.String(), "scantor runtime bundle") {
		t.Fatalf("exit %d, help %s", code, out)
	}
}

func TestRuntimeBundleOwnsSignals(t *testing.T) {
	app, _, _ := testApp(nil)
	cmd, _, err := newRootCommand(app).Find([]string{"runtime", "bundle"})
	if err != nil || !ownsSignals(cmd) || !cmd.Hidden {
		t.Fatalf("runtime bundle: %v", err)
	}
}
