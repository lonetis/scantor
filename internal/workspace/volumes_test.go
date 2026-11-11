package workspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const testUserID = "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11"

func newVolumes(t *testing.T) VolumeOptions {
	t.Helper()
	root := t.TempDir()
	for _, v := range []string{volumeWorkspaces, volumeEditorHome} {
		if err := os.Mkdir(filepath.Join(root, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Tests run unprivileged: the owner is the current user.
	return VolumeOptions{Root: root, UID: os.Getuid(), GID: os.Getgid()}
}

func TestInitUser(t *testing.T) {
	opts := newVolumes(t)
	res, err := InitUser(bg, opts, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"workspaces/" + testUserID, "editor-home/" + testUserID}
	if !slices.Equal(res.Created, want) {
		t.Fatalf("created %v, want %v", res.Created, want)
	}
	for _, p := range []string{
		filepath.Join(opts.Root, volumeWorkspaces, testUserID),
		filepath.Join(opts.Root, volumeWorkspaces, testUserID, StagingDir),
		filepath.Join(opts.Root, volumeEditorHome, testUserID),
	} {
		info, err := os.Lstat(p)
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Fatalf("%s: %v %v", p, info, err)
		}
	}

	// Idempotent; modes are repaired; a staging folder replaced by a symlink is recreated.
	userDir := filepath.Join(opts.Root, volumeWorkspaces, testUserID)
	if err := os.Chmod(userDir, 0o777); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Chmod(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(userDir, StagingDir)
	if err := os.Remove(staging); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, staging); err != nil {
		t.Fatal(err)
	}
	res, err = InitUser(bg, opts, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Created) != 0 {
		t.Fatalf("second init created %v", res.Created)
	}
	if info, err := os.Lstat(userDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("mode not repaired: %v %v", info, err)
	}
	if info, err := os.Lstat(staging); err != nil || !info.IsDir() {
		t.Fatalf("staging symlink not replaced: %v %v", info, err)
	}
	if info, err := os.Lstat(outside); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("init touched the symlink target: %v %v", info, err)
	}
}

func TestInitUserRejections(t *testing.T) {
	opts := newVolumes(t)
	for _, id := range []string{"", "..", "../etc", "0B6F6F0E-3C0E-4A6E-9F0E-5D1F8B0A7C11", "not-a-uuid", testUserID + "/x"} {
		_, err := InitUser(bg, opts, id)
		wantCode(t, err, CodeInvalidArgument)
		_, err = PurgeUser(bg, opts, id)
		wantCode(t, err, CodeInvalidArgument)
	}
	// An existing entry that is not a directory is never replaced.
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(opts.Root, volumeWorkspaces, testUserID)); err != nil {
		t.Fatal(err)
	}
	_, err := InitUser(bg, opts, testUserID)
	wantCode(t, err, CodeInternal)
	// A missing volume is an internal error.
	_, err = InitUser(bg, VolumeOptions{Root: t.TempDir()}, testUserID)
	wantCode(t, err, CodeInternal)
}

func TestPurgeUser(t *testing.T) {
	opts := newVolumes(t)
	if _, err := InitUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}
	victim := t.TempDir()
	writeTree(t, victim, map[string]node{"keep": file("x")})
	writeTree(t, filepath.Join(opts.Root, volumeWorkspaces, testUserID), map[string]node{
		"echo/scantor.yaml": file(testManifest),
		"echo/link":         symlink(victim),
	})
	res, err := PurgeUser(bg, opts, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"workspaces/" + testUserID, "editor-home/" + testUserID}; !slices.Equal(res.Removed, want) {
		t.Fatalf("removed %v, want %v", res.Removed, want)
	}
	mustNotExist(t, filepath.Join(opts.Root, volumeWorkspaces, testUserID))
	mustNotExist(t, filepath.Join(opts.Root, volumeEditorHome, testUserID))
	if got := readTestFile(t, filepath.Join(victim, "keep")); got != "x" {
		t.Fatal("purge followed a symlink")
	}
	res, err = PurgeUser(bg, opts, testUserID)
	if err != nil || len(res.Removed) != 0 {
		t.Fatalf("second purge: %+v, %v", res, err)
	}
}

// A user can make directories unwritable or unsearchable in the editor; the purge helper, which runs as
// their owner without DAC_OVERRIDE, still removes them.
func TestPurgeUserLockedDirectories(t *testing.T) {
	opts := newVolumes(t)
	if _, err := InitUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}
	userDir := filepath.Join(opts.Root, volumeWorkspaces, testUserID)
	writeTree(t, userDir, map[string]node{"echo/scantor.yaml": file(testManifest), "echo/deep/x": file("x")})
	// The inner directory first: once echo is locked, deep cannot be reached.
	for _, lock := range []struct {
		path string
		mode os.FileMode
	}{
		{filepath.Join(userDir, "echo", "deep"), 0o500},
		{filepath.Join(userDir, "echo"), 0o000},
	} {
		if err := os.Chmod(lock.path, lock.mode); err != nil {
			t.Fatal(err)
		}
	}
	res, err := PurgeUser(bg, opts, testUserID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(res.Removed, "workspaces/"+testUserID) {
		t.Fatalf("removed %v", res.Removed)
	}
	mustNotExist(t, userDir)
}

func TestPrepareVolumes(t *testing.T) {
	opts := newVolumes(t)
	res, err := PrepareVolumes(bg, opts, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []PreparedVolume{{Volume: volumeWorkspaces}, {Volume: volumeEditorHome}}
	if !slices.Equal(res.Volumes, want) {
		t.Fatalf("volumes %+v, want %+v", res.Volumes, want)
	}
	for _, v := range []string{volumeWorkspaces, volumeEditorHome} {
		if info, err := os.Lstat(filepath.Join(opts.Root, v)); err != nil || info.Mode() != os.ModeDir|0o711 {
			t.Fatalf("%s: %v %v", v, info, err)
		}
	}
	// init and purge then work as the owner of the roots.
	if _, err := InitUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := PurgeUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}
}

// Where chown is refused (here: an unprivileged test chowning to another uid, on NFS under rootless Docker:
// every chown), the roots become sticky and writable for everyone, and a warning says so.
func TestPrepareVolumesWithoutChown(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root can chown to any uid")
	}
	opts := newVolumes(t)
	opts.UID, opts.GID = os.Getuid()+1, os.Getgid()+1
	var buf bytes.Buffer
	res, err := PrepareVolumes(bg, opts, NewEvents(&buf))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Volumes[0].Shared || !res.Volumes[1].Shared {
		t.Fatalf("volumes %+v", res.Volumes)
	}
	for _, v := range []string{volumeWorkspaces, volumeEditorHome} {
		if info, err := os.Lstat(filepath.Join(opts.Root, v)); err != nil || info.Mode() != os.ModeDir|os.ModeSticky|0o777 {
			t.Fatalf("%s: %v %v", v, info, err)
		}
	}
	if !strings.Contains(buf.String(), "refuses chown") {
		t.Fatalf("no warning: %s", buf.String())
	}
	// init then gives the user directories mode 0755, so the rootless Docker daemon can open them to mount
	// them as volume subpaths; the staging folder stays private.
	opts.UID, opts.GID = os.Getuid(), os.Getgid()
	if _, err := InitUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{
		filepath.Join(opts.Root, volumeWorkspaces, testUserID):             0o755,
		filepath.Join(opts.Root, volumeEditorHome, testUserID):             0o755,
		filepath.Join(opts.Root, volumeWorkspaces, testUserID, StagingDir): 0o700,
	} {
		if info, err := os.Lstat(path); err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v, want %v", path, info, err, want)
		}
	}
	if _, err := PurgeUser(bg, opts, testUserID); err != nil {
		t.Fatal(err)
	}

	// A root that is no directory is an error.
	if err := os.RemoveAll(filepath.Join(opts.Root, volumeEditorHome)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.Root, volumeEditorHome), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareVolumes(bg, opts, nil); err == nil {
		t.Fatal("a file as volume root was accepted")
	}
}

func TestEvents(t *testing.T) {
	var buf bytes.Buffer
	ev := NewEvents(&buf)
	ev.AddRedaction("s3cr3t-token")
	ev.Infof("cloning with s3cr3t-token")
	ev.Warnf("careful <&>")
	ev.Summary(PackSummary{PackSHA256: "ab", PackBytes: 3, FileCount: 1, Bytes: 9})
	ev.Error(pathError("a/../b", "invalid path s3cr3t-token"))
	var nilEvents *Events
	nilEvents.Infof("ignored")
	nilEvents.Error(newError(CodeInternal, "ignored"))

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("got %d lines: %q", len(lines), buf.String())
	}
	var got []map[string]any
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("line %q: %v", l, err)
		}
		got = append(got, m)
	}
	if got[0]["type"] != "log" || got[0]["level"] != "info" || strings.Contains(got[0]["msg"].(string), "s3cr3t") {
		t.Fatalf("info line %v", got[0])
	}
	if got[1]["level"] != "warn" || got[1]["msg"] != "careful <&>" {
		t.Fatalf("warn line %v", got[1])
	}
	if got[2]["type"] != "summary" || got[2]["packSha256"] != "ab" || got[2]["packBytes"] != 3.0 || got[2]["fileCount"] != 1.0 || got[2]["bytes"] != 9.0 {
		t.Fatalf("summary line %v", got[2])
	}
	e := got[3]["error"].(map[string]any)
	if got[3]["type"] != "error" || e["code"] != "invalidPath" || e["path"] != "a/../b" || strings.Contains(e["message"].(string), "s3cr3t") {
		t.Fatalf("error line %v", got[3])
	}
	if d := e["details"].(map[string]any); d["path"] != "a/../b" {
		t.Fatalf("details %v", d)
	}
}

func TestErrorExitCodes(t *testing.T) {
	if got := newError(CodeInternal, "x").ExitCode(); got != ExitInternal {
		t.Fatalf("internal exit %d", got)
	}
	if got := newError(CodeNotFound, "x").ExitCode(); got != ExitUser {
		t.Fatalf("user exit %d", got)
	}
	plain := errors.New("boom")
	if werr := AsError(plain); werr.Code != CodeInternal || !errors.Is(werr, plain) {
		t.Fatalf("AsError %+v", werr)
	}
}
