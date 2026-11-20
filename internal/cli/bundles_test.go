package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

// apiBundleArchive stands in for the gzip image archive of a bundle.
var apiBundleArchive = []byte("\x1f\x8b\x08\x00bundle-archive-bytes")

func apiBundleDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// apiNoTempFiles fails when a download left a temporary file in dir.
func apiNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".scantor-download-") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

func TestRevisionsBundleCreatesWaitsAndDownloads(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	f.reply("POST", apiBundlePath("echo", "latest"), 201, f.bundleFixture("queued", nil, nil))
	f.sequence("GET", apiBundlePath("echo", "3"), f.bundleFixture("running", nil, nil), f.bundleFixture("ready", apiBundleArchive, nil))

	dir := t.TempDir()
	t.Chdir(dir)
	code, out, errOut := f.exec("revisions", "bundle", "echo")
	if code != 0 {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	if !strings.Contains(out, "saved echo-3-linux-amd64.bundle.tar.gz") || !strings.Contains(out, apiBundleDigest(apiBundleArchive)) {
		t.Fatalf("stdout %q", out)
	}
	data, err := os.ReadFile(filepath.Join(dir, "echo-3-linux-amd64.bundle.tar.gz"))
	if err != nil || string(data) != string(apiBundleArchive) {
		t.Fatalf("file %q, %v", data, err)
	}
	// The commands go to stderr, so stdout stays clean.
	for _, line := range []string{"docker load -i echo-3-linux-amd64.bundle.tar.gz", `docker run --rm -v "$PWD:/work" localhost/scantor/echo:3`, "--describe"} {
		if !strings.Contains(errOut, line) {
			t.Errorf("stderr lacks %q: %q", line, errOut)
		}
		if strings.Contains(out, line) {
			t.Errorf("stdout carries %q", line)
		}
	}
	if !strings.Contains(errOut, "waiting") {
		t.Errorf("stderr lacks the waiting notice: %q", errOut)
	}

	// The create has no rebuild or wait; the poll waits server-side and follows the revision by number.
	if q := f.last("POST", apiBundlePath("echo", "latest")).Query; q.Has("rebuild") || q.Has("wait") {
		t.Fatalf("create query %v", q)
	}
	polls := f.calls("GET", apiBundlePath("echo", "3"))
	if len(polls) != 2 || polls[0].Query.Get("wait") == "" || polls[0].Query.Get("wait") == "0" {
		t.Fatalf("polls %+v", polls)
	}
	if dl := f.last("GET", apiBundleS3Path); dl.Header.Get("Authorization") != "" || dl.Query.Get("X-Amz-Signature") != "abc" {
		t.Fatalf("presigned request %+v", dl)
	}
	apiNoTempFiles(t, dir)

	// An existing file is replaced only with --force.
	if code, _, errOut := f.exec("revisions", "bundle", "echo"); code != ExitValidation || !strings.Contains(errOut, "--force") {
		t.Fatalf("existing file: exit %d, %q", code, errOut)
	}
	if code, _, errOut := f.exec("revisions", "bundle", "echo", "--force"); code != 0 {
		t.Fatalf("--force: exit %d, %q", code, errOut)
	}
}

func TestRevisionsBundleReusesAndRebuilds(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	f.reply("POST", apiBundlePath("echo", "3"), 200, f.bundleFixture("ready", apiBundleArchive, nil))

	target := filepath.Join(t.TempDir(), "my bundle.tar.gz")
	code, out, errOut := f.exec("revisions", "bundle", "echo@3", "--file", target, "-o", "json")
	if code != 0 {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	// A ready bundle is downloaded at once, without polling.
	if n := len(f.calls("GET", apiBundlePath("echo", "3"))); n != 0 {
		t.Fatalf("%d polls of a ready bundle", n)
	}
	result := apiDecode[struct {
		Bundle api.Bundle    `json:"bundle"`
		File   *apiSavedFile `json:"file"`
	}](t, []byte(out))
	if result.Bundle.State != api.BundleReady || result.File == nil || result.File.Path != target ||
		result.File.Bytes != int64(len(apiBundleArchive)) || result.File.SHA256 != apiBundleDigest(apiBundleArchive) {
		t.Fatalf("json %+v", result)
	}
	if errOut != "" {
		t.Fatalf("json mode wrote to stderr: %q", errOut)
	}
	if data, _ := os.ReadFile(target); string(data) != string(apiBundleArchive) {
		t.Fatalf("file %q", data)
	}

	// --rebuild asks for a new bundle; in human mode the load command names the path the bundle was saved to.
	f.reply("POST", apiBundlePath("echo", "3"), 201, f.bundleFixture("ready", apiBundleArchive, nil))
	code, _, errOut = f.exec("revisions", "bundle", "echo@3", "--rebuild", "--file", target, "--force")
	if code != 0 {
		t.Fatalf("rebuild: exit %d, %q", code, errOut)
	}
	if q := f.last("POST", apiBundlePath("echo", "3")).Query; q.Get("rebuild") != "true" {
		t.Fatalf("rebuild query %v", q)
	}
	if !strings.Contains(errOut, "docker load -i '"+target+"'") {
		t.Fatalf("load line for another path: %q", errOut)
	}
}

func TestRevisionsBundleFailed(t *testing.T) {
	f := newAPIFake(t)
	failed := f.bundleFixture("failed", nil, map[string]any{"error": map[string]any{"code": "bundleFailed", "message": "the image is not linux/amd64"}})
	f.reply("POST", apiBundlePath("echo", "3"), 201, f.bundleFixture("queued", nil, nil))
	f.reply("GET", apiBundlePath("echo", "3"), 200, failed)

	dir := t.TempDir()
	t.Chdir(dir)
	code, out, errOut := f.exec("revisions", "bundle", "echo@3")
	if code != ExitPlatform || !strings.Contains(errOut, "bundle echo@3 failed: the image is not linux/amd64 (bundleFailed)") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	if out != "" || len(f.calls("GET", apiBundleS3Path)) != 0 {
		t.Fatalf("failed bundle printed %q or downloaded", out)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("failed bundle wrote %v", entries)
	}

	// -o json prints the failed bundle and the error envelope.
	code, out, errOut = f.exec("revisions", "bundle", "echo@3", "-o", "json")
	if code != ExitPlatform || !strings.Contains(errOut, `"exitCode":3`) {
		t.Fatalf("json: exit %d, err %q", code, errOut)
	}
	if got := apiDecode[apiBundleOutput](t, []byte(out)); got.Bundle == nil || got.Bundle.State != api.BundleFailed || got.File != nil {
		t.Fatalf("json %q", out)
	}

	// Errors of the create keep their exit class.
	f.fail("POST", apiBundlePath("echo", "4"), 409, "revisionNotReady", "revision echo@4 is building", map[string]any{"state": "building"})
	if code, _, errOut := f.exec("revisions", "bundle", "echo@4"); code != ExitValidation || !strings.Contains(errOut, "revisions get echo@4 --wait") {
		t.Fatalf("not ready: exit %d, %q", code, errOut)
	}
	f.fail("POST", apiBundlePath("echo", "5"), 409, "bundleUnsupported", "privileged revisions cannot be bundled", map[string]any{"reason": "privileged"})
	if code, _, errOut := f.exec("revisions", "bundle", "echo@5"); code != ExitValidation || !strings.Contains(errOut, "privileged") {
		t.Fatalf("unsupported: exit %d, %q", code, errOut)
	}
}

func TestRevisionsBundleNoDownload(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	f.reply("POST", apiBundlePath("echo", "3"), 201, f.bundleFixture("running", nil, nil))
	f.reply("GET", apiBundlePath("echo", "3"), 200, f.bundleFixture("ready", apiBundleArchive, nil))

	dir := t.TempDir()
	t.Chdir(dir)
	code, out, errOut := f.exec("revisions", "bundle", "echo@3", "--no-download")
	if code != 0 || !strings.Contains(out, "localhost/scantor/echo:3") || !strings.Contains(out, "linux/amd64") || !strings.Contains(errOut, "docker load -i echo-3-linux-amd64.bundle.tar.gz") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	code, out, _ = f.exec("revisions", "bundle", "echo@3", "--no-download", "-o", "json")
	if code != 0 {
		t.Fatalf("json: exit %d", code)
	}
	got := apiDecode[map[string]any](t, []byte(out))
	if file, ok := got["file"]; !ok || file != nil {
		t.Fatalf("json %q: file must be null", out)
	}
	if bundle, _ := got["bundle"].(map[string]any); bundle == nil || bundle["state"] != "ready" {
		t.Fatalf("json %q", out)
	}
	if n := len(f.calls("GET", apiBundleS3Path)); n != 0 {
		t.Fatalf("--no-download downloaded %d times", n)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("--no-download wrote %v", entries)
	}
	if code, _, _ := f.exec("revisions", "bundle", "echo@3", "--no-download", "--file", "x.tar.gz"); code != ExitValidation {
		t.Fatalf("--no-download with --file: exit %d", code)
	}
}

func TestRevisionsBundleToStdout(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	f.reply("POST", apiBundlePath("echo", "3"), 200, f.bundleFixture("ready", apiBundleArchive, nil))

	for _, format := range []string{"human", "json"} {
		code, out, errOut := f.exec("revisions", "bundle", "echo@3", "--file", "-", "-o", format)
		if code != 0 || out != string(apiBundleArchive) {
			t.Fatalf("%s: exit %d, out %q, err %q", format, code, out, errOut)
		}
		// The archive is all of stdout; the run commands go to stderr, without a load line for a file.
		if format == "human" && (!strings.Contains(errOut, "localhost/scantor/echo:3 --describe") || strings.Contains(errOut, "docker load -i")) {
			t.Fatalf("stderr %q", errOut)
		}
	}
}

func TestRevisionsBundleVerifiesTheDownload(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	ready := f.bundleFixture("ready", apiBundleArchive, map[string]any{"sha256": strings.Repeat("0", 64)})
	f.reply("POST", apiBundlePath("echo", "3"), 200, ready)

	dir := t.TempDir()
	t.Chdir(dir)
	code, _, errOut := f.exec("revisions", "bundle", "echo@3")
	if code != ExitPlatform || !strings.Contains(errOut, "SHA-256") {
		t.Fatalf("corrupt: exit %d, %q", code, errOut)
	}
	if _, err := os.Stat(filepath.Join(dir, "echo-3-linux-amd64.bundle.tar.gz")); !os.IsNotExist(err) {
		t.Fatal("a corrupt download left a file behind")
	}
	apiNoTempFiles(t, dir)

	// A short download is a platform error too.
	f.reply("POST", apiBundlePath("echo", "3"), 200, f.bundleFixture("ready", apiBundleArchive, map[string]any{"bytes": len(apiBundleArchive) + 1}))
	if code, _, errOut := f.exec("revisions", "bundle", "echo@3"); code != ExitPlatform || !strings.Contains(errOut, "incomplete") {
		t.Fatalf("short: exit %d, %q", code, errOut)
	}

	// A ready bundle without a download URL.
	f.reply("POST", apiBundlePath("echo", "3"), 200, f.bundleFixture("ready", apiBundleArchive, map[string]any{"download": nil}))
	if code, _, errOut := f.exec("revisions", "bundle", "echo@3"); code != ExitPlatform || !strings.Contains(errOut, "no download URL") {
		t.Fatalf("no URL: exit %d, %q", code, errOut)
	}
}

// A file the download could not write is reported before the wait for the bundle, not after it.
func TestRevisionsBundleChecksTheFileFirst(t *testing.T) {
	f := newAPIFake(t)
	f.serveBundle(apiBundleArchive)
	f.reply("POST", apiBundlePath("echo", "latest"), 201, f.bundleFixture("queued", nil, nil))
	f.sequence("GET", apiBundlePath("echo", "3"), f.bundleFixture("running", nil, nil), f.bundleFixture("ready", apiBundleArchive, nil))

	dir := t.TempDir()
	t.Chdir(dir)
	existing := filepath.Join(dir, "mine.tar.gz")
	if err := os.WriteFile(existing, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	// An explicit --file is checked before any request.
	for args, want := range map[string]string{
		existing:                               "already exists; use --force",
		filepath.Join(dir, "nope", "x.tar.gz"): "directory " + filepath.Join(dir, "nope") + " does not exist",
	} {
		if code, _, errOut := f.exec("revisions", "bundle", "echo", "--file", args); code != ExitValidation || !strings.Contains(errOut, want) {
			t.Fatalf("--file %s: exit %d, %q", args, code, errOut)
		}
	}
	if n := f.count(); n != 0 {
		t.Fatalf("%d requests for an unusable --file", n)
	}

	// The default file name is known once the bundle is created: an existing file ends the command before the wait.
	name := filepath.Join(dir, "echo-3-linux-amd64.bundle.tar.gz")
	if err := os.WriteFile(name, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := f.exec("revisions", "bundle", "echo", "--rebuild")
	if code != ExitValidation || !strings.Contains(errOut, "echo-3-linux-amd64.bundle.tar.gz already exists; use --force") || strings.Contains(errOut, "waiting") {
		t.Fatalf("existing default file: exit %d, %q", code, errOut)
	}
	if polls, downloads := len(f.calls("GET", apiBundlePath("echo", "3"))), len(f.calls("GET", apiBundleS3Path)); polls != 0 || downloads != 0 {
		t.Fatalf("%d polls and %d downloads before the check", polls, downloads)
	}
	if data, _ := os.ReadFile(name); string(data) != "keep" {
		t.Fatalf("the existing file changed: %q", data)
	}
	if code, _, errOut := f.exec("revisions", "bundle", "echo", "--force"); code != 0 {
		t.Fatalf("--force: exit %d, %q", code, errOut)
	}
	if data, _ := os.ReadFile(name); string(data) != string(apiBundleArchive) {
		t.Fatalf("--force did not replace the file: %q", data)
	}
}

func TestRevisionsBundleUsage(t *testing.T) {
	f := newAPIFake(t)
	for _, args := range [][]string{
		{"revisions", "bundle"},
		{"revisions", "bundle", "echo@"},
		{"revisions", "bundle", "echo@3", "--timeout=-1s"},
	} {
		if code, _, _ := f.exec(args...); code != ExitValidation {
			t.Errorf("%v: exit %d", args, code)
		}
	}
	if f.count() != 0 {
		t.Fatalf("usage errors sent %d requests", f.count())
	}

	// --timeout bounds the wait.
	f.reply("POST", apiBundlePath("echo", "3"), 201, f.bundleFixture("queued", nil, nil))
	f.reply("GET", apiBundlePath("echo", "3"), 200, f.bundleFixture("running", nil, nil))
	if code, _, errOut := f.exec("revisions", "bundle", "echo@3", "--timeout", "50ms"); code != ExitPlatform || !strings.Contains(errOut, "timed out") {
		t.Fatalf("timeout: exit %d, %q", code, errOut)
	}
}

func TestAPIShellQuote(t *testing.T) {
	for in, want := range map[string]string{
		"echo-3-linux-amd64.bundle.tar.gz": "echo-3-linux-amd64.bundle.tar.gz",
		"/tmp/out/x.tar.gz":                "/tmp/out/x.tar.gz",
		"my bundle.tar.gz":                 "'my bundle.tar.gz'",
		"it's.tar.gz":                      `'it'\''s.tar.gz'`,
		"$HOME/x":                          `'$HOME/x'`,
	} {
		if got := apiShellQuote(in); got != want {
			t.Errorf("apiShellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}
