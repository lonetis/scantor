package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/workspace"
)

// helperRun runs `scantor workspace <args>` with stdin and returns the exit code, stdout and the decoded
// stderr events.
func helperRun(t *testing.T, stdin []byte, args ...string) (int, []byte, []map[string]any) {
	t.Helper()
	app, out, errOut := testApp(nil)
	app.Stdin = bytes.NewReader(stdin)
	code := run(app, append([]string{"workspace"}, args...)...)
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(errOut.String()), "\n") {
		if line == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("stderr line %q is not JSON: %v", line, err)
		}
		events = append(events, ev)
	}
	return code, out.Bytes(), events
}

// helperOK runs a helper that must succeed and decodes its stdout document into v.
func helperOK(t *testing.T, v any, stdin []byte, args ...string) []map[string]any {
	t.Helper()
	code, out, events := helperRun(t, stdin, args...)
	if code != 0 {
		t.Fatalf("workspace %v exited %d: %v", args, code, events)
	}
	if v != nil {
		if err := json.Unmarshal(out, v); err != nil {
			t.Fatalf("stdout %q: %v", out, err)
		}
	}
	return events
}

// helperFails runs a helper that must fail with exit code and helper error code.
func helperFails(t *testing.T, exit int, errCode workspace.Code, stdin []byte, args ...string) map[string]any {
	t.Helper()
	code, out, events := helperRun(t, stdin, args...)
	if code != exit || len(out) != 0 || len(events) == 0 {
		t.Fatalf("workspace %v: exit %d, stdout %q, events %v; want exit %d", args, code, out, events, exit)
	}
	last := events[len(events)-1]
	body, _ := last["error"].(map[string]any)
	if last["type"] != "error" || body["code"] != string(errCode) {
		t.Fatalf("last event %v, want error %s", last, errCode)
	}
	return body
}

func TestWorkspaceHelperCommands(t *testing.T) {
	root := t.TempDir()
	// A missing process temp directory: helpers must never spool in /tmp (a 64 MiB tmpfs in helper
	// containers); packs spool in a scratch directory on the workspace volume.
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))

	var scaffold struct {
		Workspace workspace.Summary `json:"workspace"`
	}
	helperOK(t, &scaffold, nil, "scaffold", "--root", root, "--task", "echo", "--language", "python", "--template", "list", "--description", "Echo things")
	if scaffold.Workspace.PackSHA256 == "" || scaffold.Workspace.FileCount == 0 {
		t.Fatalf("scaffold summary %+v", scaffold.Workspace)
	}
	if entries, err := os.ReadDir(filepath.Join(root, workspace.StagingDir)); err != nil || len(entries) != 0 {
		t.Fatalf("staging area not empty after the run: %v %v", entries, err)
	}

	var written workspace.WriteResult
	helperOK(t, &written, []byte(`{"files": {"lib/util.py": "x = 1\n"}}`), "write-files", "--root", root, "--task", "echo", "--max-files", "100", "--max-bytes", "1MiB", "--max-workspace-bytes", "10MiB")
	if len(written.Written) != 1 || written.Workspace.PackSHA256 == scaffold.Workspace.PackSHA256 {
		t.Fatalf("write result %+v", written)
	}

	var list workspace.ListResult
	helperOK(t, &list, nil, "list", "--root", root, "--task", "echo", "--path", "lib")
	if len(list.Entries) != 1 || list.Entries[0].Path != "lib/util.py" {
		t.Fatalf("list %+v", list)
	}
	var read workspace.ReadResult
	helperOK(t, &read, nil, "read", "--root", root, "--task", "echo", "--path", "lib/util.py")
	if read.Content != "x = 1\n" || read.Encoding != workspace.EncodingUTF8 {
		t.Fatalf("read %+v", read)
	}

	// snapshot: the tar.gz on stdout, the summary as the last stderr event.
	code, pack, events := helperRun(t, nil, "snapshot", "--root", root, "--task", "echo")
	if code != 0 || len(events) == 0 {
		t.Fatalf("snapshot exit %d, events %v", code, events)
	}
	summary := events[len(events)-1]
	if summary["type"] != "summary" || summary["packSha256"] != tarHash(t, pack) || summary["packBytes"] != float64(len(pack)) {
		t.Fatalf("summary %v does not describe the pack (sha %s, %d bytes)", summary, tarHash(t, pack), len(pack))
	}
	var hashOnly workspace.Summary
	helperOK(t, &hashOnly, nil, "snapshot", "--root", root, "--task", "echo", "--hash-only")
	if hashOnly.PackSHA256 != written.Workspace.PackSHA256 || hashOnly.PackSHA256 != summary["packSha256"] {
		t.Fatalf("hash-only %+v, write %+v", hashOnly, written.Workspace)
	}

	// --archive operations read the snapshot on stdin and need no workspace.
	var archived workspace.ListResult
	helperOK(t, &archived, pack, "list", "--archive", "--path", "lib", "--recursive=false")
	if len(archived.Entries) != 1 || archived.Entries[0].Path != "lib/util.py" {
		t.Fatalf("archive list %+v", archived)
	}
	var archivedRead workspace.ReadResult
	helperOK(t, &archivedRead, pack, "read", "--archive", "--path", "lib/util.py", "--max-bytes", "3")
	if archivedRead.Content != "x =" || !archivedRead.Truncated || archivedRead.SHA256 != read.SHA256 {
		t.Fatalf("archive read %+v", archivedRead)
	}

	// extract → commit: the same content, unchanged.
	var extracted workspace.ExtractResult
	helperOK(t, &extracted, pack, "extract", "--root", root, "--staging", "up1", "--max-pack-bytes", "1MiB")
	if extracted.Manifest.Name != "echo" || extracted.Summary.PackSHA256 != hashOnly.PackSHA256 {
		t.Fatalf("extract %+v", extracted)
	}
	var committed workspace.CommitResult
	helperOK(t, &committed, nil, "commit", "--root", root, "--staging", "up1", "--task", "echo", "--expect", hashOnly.PackSHA256)
	if committed.Changed || committed.PreviousPackSHA256 == nil || *committed.PreviousPackSHA256 != hashOnly.PackSHA256 {
		t.Fatalf("commit %+v", committed)
	}
	code, out, _ := helperRun(t, nil, "discard", "--root", root, "--staging", "up1")
	if code != 0 || strings.TrimSpace(string(out)) != "{}" {
		t.Fatalf("discard exit %d, stdout %q", code, out)
	}

	var deleted workspace.DeleteResult
	helperOK(t, &deleted, nil, "delete-files", "--root", root, "--task", "echo", "--path", "", "--recursive")
	if deleted.Workspace != nil || len(deleted.Deleted) == 0 {
		t.Fatalf("delete %+v", deleted)
	}
	if _, err := os.Stat(filepath.Join(root, "echo")); !os.IsNotExist(err) {
		t.Fatalf("task folder still exists: %v", err)
	}
}

// tarHash returns the SHA-256 of the uncompressed tar inside a tar.gz and checks that it is a tar.
func tarHash(t *testing.T, tgz []byte) string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tar.NewReader(bytes.NewReader(raw)).Next(); err != nil {
		t.Fatalf("not a tar: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestWorkspaceHelperErrors(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	root := t.TempDir()
	helperOK(t, nil, nil, "scaffold", "--root", root, "--task", "echo", "--language", "go")

	body := helperFails(t, 1, workspace.CodeInvalidPath, nil, "read", "--root", root, "--task", "echo", "--path", "../x")
	if details, _ := body["details"].(map[string]any); details["path"] != "../x" || body["path"] != "../x" {
		t.Fatalf("error body %v", body)
	}
	helperFails(t, 1, workspace.CodeNotFound, nil, "list", "--root", root, "--task", "missing")
	helperFails(t, 1, workspace.CodeExists, nil, "scaffold", "--root", root, "--task", "echo", "--language", "go")
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "list", "--root", root)
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "list", "--root", root, "--task", "echo", "--bogus")
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "list", "--root", root, "--task", "echo", "extra")
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "write-files", "--root", root, "--task", "echo", "--max-bytes", "lots")
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "commit", "--root", root, "--staging", "s", "--task", "echo")
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "git-clone", "--root", root, "--staging", "s", "--url", "http://example.com/x.git")
	helperFails(t, 1, workspace.CodeInvalidArgument, []byte{}, "extract", "--root", root, "--staging", "s")
	body = helperFails(t, 1, workspace.CodeManifestInvalid, tgzOf(t, map[string]string{"main.py": "x"}), "extract", "--root", root, "--staging", "s")
	if details, _ := body["details"].(map[string]any); details["errors"] == nil {
		t.Fatalf("manifestInvalid without details.errors: %v", body)
	}
	helperFails(t, 1, workspace.CodeTooLarge, []byte(`{"files": {"a": "123456"}}`), "write-files", "--root", root, "--task", "echo", "--max-bytes", "5")
	helperFails(t, 2, workspace.CodeInternal, nil, "list", "--root", filepath.Join(root, "nope"), "--task", "echo")
}

func TestWorkspaceHelperVolumes(t *testing.T) {
	volumes := t.TempDir()
	for _, v := range []string{"workspaces", "editor-home"} {
		if err := os.Mkdir(filepath.Join(volumes, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	const user = "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11"
	uid, gid := itoa(os.Getuid()), itoa(os.Getgid())
	var initRes workspace.InitResult
	helperOK(t, &initRes, nil, "init", "--user", user, "--volumes", volumes, "--uid", uid, "--gid", gid)
	if len(initRes.Created) != 2 {
		t.Fatalf("init %+v", initRes)
	}
	var purgeRes workspace.PurgeResult
	helperOK(t, &purgeRes, nil, "purge", "--user", user, "--volumes", volumes)
	if len(purgeRes.Removed) != 2 {
		t.Fatalf("purge %+v", purgeRes)
	}
	helperFails(t, 1, workspace.CodeInvalidArgument, nil, "init", "--user", "../x", "--volumes", volumes)
}

// tgzOf returns a tar.gz with the regular files of files.
func tgzOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestWorkspaceGroupIsHidden(t *testing.T) {
	app, out, _ := testApp(nil)
	if code := run(app, "--help"); code != 0 {
		t.Fatalf("help exited %d", code)
	}
	if strings.Contains(out.String(), "\n  workspace ") {
		t.Fatalf("the helper group is listed in --help:\n%s", out)
	}
}
