package workspace

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// stage creates staging/<id>/tree with tree, as extract or a git checkout would.
func stage(t *testing.T, ws *testWorkspace, id string, tree map[string]node) string {
	t.Helper()
	if err := ws.createStaging(id); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(ws.dir, StagingDir, id, "tree")
	writeTree(t, dir, tree)
	return dir
}

func TestCommit(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	task := filepath.Join(ws.dir, "echo")
	v1 := map[string]node{"scantor.yaml": file(testManifest), "main.py": file("v1"), "run.sh": execFile("#!/bin/sh\n")}

	// A new task folder: expect absent.
	staged := stage(t, ws, "s1", v1)
	newHash := packHash(t, staged)
	res, err := ws.Commit(bg, CommitOptions{Staging: "s1", Task: "echo", Expect: ExpectAbsent})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Changed || res.PreviousPackSHA256 != nil || res.Workspace.PackSHA256 != newHash || res.Task != "echo" {
		t.Fatalf("unexpected result %+v", res)
	}
	if got := readTestFile(t, filepath.Join(task, "main.py")); got != "v1" {
		t.Fatalf("main.py = %q", got)
	}
	mustNotExist(t, filepath.Join(ws.dir, StagingDir, "s1"))

	// The same content again: unchanged, whatever was expected.
	stage(t, ws, "s2", v1)
	res, err = ws.Commit(bg, CommitOptions{Staging: "s2", Task: "echo", Expect: strings.Repeat("0", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed || res.PreviousPackSHA256 == nil || *res.PreviousPackSHA256 != newHash {
		t.Fatalf("unexpected result %+v", res)
	}

	// New content based on a stale hash: workspaceDirty, nothing moves.
	stage(t, ws, "s3", map[string]node{"scantor.yaml": file(testManifest), "main.py": file("v2")})
	_, err = ws.Commit(bg, CommitOptions{Staging: "s3", Task: "echo", Expect: strings.Repeat("0", 64)})
	werr := codeOf(t, err, CodeWorkspaceDirty)
	if werr.Details["current"] != newHash {
		t.Fatalf("details %v", werr.Details)
	}
	_, err = ws.Commit(bg, CommitOptions{Staging: "s3", Task: "echo", Expect: ExpectAbsent})
	wantCode(t, err, CodeWorkspaceDirty)
	if got := readTestFile(t, filepath.Join(task, "main.py")); got != "v1" {
		t.Fatal("a refused commit changed the task folder")
	}

	// Based on the current hash: replaced; "any" always replaces.
	res, err = ws.Commit(bg, CommitOptions{Staging: "s3", Task: "echo", Expect: newHash})
	if err != nil || !res.Changed {
		t.Fatalf("commit with the current hash: %+v, %v", res, err)
	}
	if got := readTestFile(t, filepath.Join(task, "main.py")); got != "v2" {
		t.Fatalf("main.py = %q", got)
	}
	mustNotExist(t, filepath.Join(task, "run.sh"))
	stage(t, ws, "s4", v1)
	if res, err := ws.Commit(bg, CommitOptions{Staging: "s4", Task: "echo", Expect: ExpectAny}); err != nil || !res.Changed {
		t.Fatalf("commit with any: %+v, %v", res, err)
	}
	// No leftovers of the swap.
	if entries, err := os.ReadDir(filepath.Join(ws.dir, StagingDir)); err != nil || len(entries) != 0 {
		t.Fatalf("staging area not empty: %v %v", entries, err)
	}
}

// The pack leaves out what .dockerignore excludes, so equal pack hashes do not mean equal folders: a
// commit that changes only such a file still replaces the folder, and one that adds nothing new keeps
// the local files only the task folder has.
func TestCommitComparesDockerignoredFiles(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	task := filepath.Join(ws.dir, "echo")
	tree := func(readme string) map[string]node {
		return map[string]node{"scantor.yaml": file(testManifest), ".dockerignore": file("README.md\ndocs/\nnode_modules/\n"), "main.py": file("x"), "README.md": file(readme), "docs/a.md": file("a")}
	}
	stage(t, ws, "s1", tree("old"))
	res, err := ws.Commit(bg, CommitOptions{Staging: "s1", Task: "echo", Expect: ExpectAbsent})
	if err != nil {
		t.Fatal(err)
	}
	hash := res.Workspace.PackSHA256
	writeTree(t, task, map[string]node{"node_modules/x/index.js": file("local")})

	// Only README.md differs: the same pack, but the folder is replaced.
	stage(t, ws, "s2", tree("new"))
	res, err = ws.Commit(bg, CommitOptions{Staging: "s2", Task: "echo", Expect: hash})
	if err != nil || !res.Changed || res.Workspace.PackSHA256 != hash {
		t.Fatalf("commit of a changed ignored file: %+v, %v", res, err)
	}
	if got := readTestFile(t, filepath.Join(task, "README.md")); got != "new" {
		t.Fatalf("README.md = %q", got)
	}
	mustNotExist(t, filepath.Join(task, "node_modules"))

	// The same files again: nothing moves, and a local ignored folder stays.
	writeTree(t, task, map[string]node{"node_modules/x/index.js": file("local")})
	stage(t, ws, "s3", tree("new"))
	if res, err := ws.Commit(bg, CommitOptions{Staging: "s3", Task: "echo", Expect: hash}); err != nil || res.Changed {
		t.Fatalf("commit of the same files: %+v, %v", res, err)
	}
	if got := readTestFile(t, filepath.Join(task, "node_modules", "x", "index.js")); got != "local" {
		t.Fatalf("node_modules/x/index.js = %q", got)
	}

	// An ignored file whose execute bit or type differs, or a missing ignored folder, is a change too.
	for id, changed := range map[string]map[string]node{
		"s4": {"README.md": execFile("new")},
		"s5": {"docs/a.md": dir()},
		"s6": {"docs/b.md": file("b")},
	} {
		next := tree("new")
		if _, ok := changed["docs/a.md"]; ok {
			delete(next, "docs/a.md")
		}
		for p, n := range changed {
			next[p] = n
		}
		stage(t, ws, id, next)
		if res, err := ws.Commit(bg, CommitOptions{Staging: id, Task: "echo", Expect: ExpectAny}); err != nil || !res.Changed {
			t.Fatalf("%s: %+v, %v", id, res, err)
		}
	}
}

func TestCommitFromSubfolderKeepsStaging(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	stage(t, ws, "git1", map[string]node{
		".git/HEAD":           file("ref"),
		"one/scantor.yaml":    file(testManifest),
		"one/main.py":         file("1"),
		"one/.git/config":     file("nested"),
		"one/sub/.scantor/x":  file("scratch"),
		"two/scantor.yaml":    file(strings.Replace(testManifest, "echo", "two", 1)),
		"two/lib/__init__.py": file(""),
	})
	if _, err := ws.Commit(bg, CommitOptions{Staging: "git1", From: "one", Task: "echo", Expect: ExpectAbsent}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.Commit(bg, CommitOptions{Staging: "git1", From: "./two/", Task: "two", Expect: ExpectAbsent}); err != nil {
		t.Fatal(err)
	}
	got := listTestTree(t, filepath.Join(ws.dir, "echo"))
	want := []treeEntry{{"main.py", TypeFile, 0o644}, {"scantor.yaml", TypeFile, 0o644}, {"sub", TypeDir, 0o755}}
	if !slices.Equal(got, want) {
		t.Fatalf("task folder %+v, want %+v", got, want)
	}
	if _, err := os.Stat(filepath.Join(ws.dir, StagingDir, "git1", "tree", ".git")); err != nil {
		t.Fatalf("the rest of the checkout is gone: %v", err)
	}
	if err := ws.Discard("git1"); err != nil {
		t.Fatal(err)
	}
	mustNotExist(t, filepath.Join(ws.dir, StagingDir, "git1"))
	if err := ws.Discard("git1"); err != nil {
		t.Fatalf("discard is not idempotent: %v", err)
	}
}

func TestCommitRejections(t *testing.T) {
	tests := []struct {
		name   string
		limits Limits
		tree   map[string]node
		opts   CommitOptions
		code   Code
	}{
		{name: "symlink", tree: map[string]node{"scantor.yaml": file(testManifest), "l": symlink("scantor.yaml")}, code: CodeInvalidPath},
		{name: "entry cap", limits: Limits{MaxFiles: 2}, tree: map[string]node{"a": file("1"), "b": file("2"), "c": file("3")}, code: CodeTooManyFiles},
		{name: "byte cap", limits: Limits{MaxBytes: 3}, tree: map[string]node{"a": file("1234")}, code: CodeTooLarge},
		{name: "workspace cap", limits: Limits{MaxWorkspaceBytes: 3}, tree: map[string]node{"a": file("1234")}, code: CodeWorkspaceFull},
		{name: "bad expect", tree: map[string]node{"a": file("1")}, opts: CommitOptions{Expect: "nope"}, code: CodeInvalidArgument},
		{name: "bad task", tree: map[string]node{"a": file("1")}, opts: CommitOptions{Task: "../x"}, code: CodeInvalidArgument},
		{name: "missing from", tree: map[string]node{"a": file("1")}, opts: CommitOptions{From: "nope"}, code: CodeNotFound},
		{name: "from escapes", tree: map[string]node{"a": file("1")}, opts: CommitOptions{From: "../.."}, code: CodeInvalidPath},
		{name: "unknown staging", opts: CommitOptions{Staging: "other"}, code: CodeNotFound},
		{name: "invalid staging id", opts: CommitOptions{Staging: "../x"}, code: CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ws := newTestWorkspace(t, tt.limits)
			stage(t, ws, "s1", tt.tree)
			opts := tt.opts
			if opts.Staging == "" {
				opts.Staging = "s1"
			}
			if opts.Task == "" {
				opts.Task = "echo"
			}
			if opts.Expect == "" {
				opts.Expect = ExpectAny
			}
			_, err := ws.Commit(bg, opts)
			wantCode(t, err, tt.code)
			mustNotExist(t, filepath.Join(ws.dir, "echo"))
		})
	}
}

func TestCommitIntoSymlinkedTaskFolder(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	victim := t.TempDir()
	writeTree(t, ws.dir, map[string]node{"echo": symlink(victim)})
	stage(t, ws, "s1", map[string]node{"scantor.yaml": file(testManifest)})
	_, err := ws.Commit(bg, CommitOptions{Staging: "s1", Task: "echo", Expect: ExpectAny})
	wantCode(t, err, CodeInvalidPath)
	if entries, err := os.ReadDir(victim); err != nil || len(entries) != 0 {
		t.Fatalf("the symlink target was written: %v %v", entries, err)
	}
}

func TestExtractAndCommitRoundTrip(t *testing.T) {
	src := newTestWorkspace(t, DefaultLimits())
	writeTree(t, filepath.Join(src.dir, "echo"), map[string]node{
		"scantor.yaml":  file(testManifest),
		"main.py":       file("print(1)\n"),
		"tool.sh":       execFile("#!/bin/sh\n"),
		"pkg/a.py":      file("a"),
		".dockerignore": file("*.log\n"),
		"debug.log":     file("excluded from the pack, kept in the folder"),
	})
	var pack bytes.Buffer
	sum, err := src.Snapshot(bg, "echo", &pack)
	if err != nil {
		t.Fatal(err)
	}
	if sum.PackSHA256 != packHash(t, filepath.Join(src.dir, "echo")) || int64(pack.Len()) != sum.PackBytes {
		t.Fatalf("snapshot summary %+v does not describe the written pack", sum)
	}

	dst := newTestWorkspace(t, DefaultLimits())
	res, err := dst.Extract(bg, "up1", bytes.NewReader(pack.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if res.Summary.PackSHA256 != sum.PackSHA256 || res.Manifest.Name != "echo" || res.Manifest.Entry != "main.py" {
		t.Fatalf("extract result %+v, want hash %s", res, sum.PackSHA256)
	}
	cres, err := dst.Commit(bg, CommitOptions{Staging: "up1", Task: res.Manifest.Name, Expect: ExpectAbsent})
	if err != nil {
		t.Fatal(err)
	}
	if cres.Workspace.PackSHA256 != sum.PackSHA256 {
		t.Fatalf("committed hash %s, want %s", cres.Workspace.PackSHA256, sum.PackSHA256)
	}
	hashOnly, err := dst.Snapshot(bg, "echo", nil)
	if err != nil || hashOnly.PackSHA256 != sum.PackSHA256 {
		t.Fatalf("hash-only snapshot %+v, %v", hashOnly, err)
	}

	// A pack that is identical to the one ReadPack canonicalises.
	read, err := taskpipe.ReadPack(bg, bytes.NewReader(pack.Bytes()), taskpipe.PackLimits{})
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	if read.Summary.PackSHA256 != sum.PackSHA256 {
		t.Fatalf("ReadPack hash %s, want %s", read.Summary.PackSHA256, sum.PackSHA256)
	}
}

func TestSnapshotCapsAndErrors(t *testing.T) {
	ws := newTestWorkspace(t, Limits{MaxFiles: 2})
	writeTree(t, filepath.Join(ws.dir, "big"), map[string]node{"a": file("1"), "b": file("2"), "c": file("3")})
	_, err := ws.Snapshot(bg, "big", nil)
	wantCode(t, err, CodeTooManyFiles)

	ws = newTestWorkspace(t, Limits{MaxBytes: 1024})
	writeTree(t, filepath.Join(ws.dir, "big"), map[string]node{"a": file(strings.Repeat("x", 4096))})
	_, err = ws.Snapshot(bg, "big", nil)
	wantCode(t, err, CodeTooLarge)

	ws = newTestWorkspace(t, DefaultLimits())
	writeTree(t, filepath.Join(ws.dir, "esc"), map[string]node{"scantor.yaml": file(testManifest), "passwd": symlink("/etc/passwd")})
	_, err = ws.Snapshot(bg, "esc", nil)
	if werr := codeOf(t, err, CodeInvalidPath); werr.Path != "passwd" {
		t.Fatalf("error path %q", werr.Path)
	}
	_, err = ws.Snapshot(bg, "missing", nil)
	wantCode(t, err, CodeNotFound)

	// In-tree symlinks are packed as symlinks.
	writeTree(t, filepath.Join(ws.dir, "ok"), map[string]node{"scantor.yaml": file(testManifest), "alias.yaml": symlink("scantor.yaml")})
	if _, err := ws.Snapshot(bg, "ok", nil); err != nil {
		t.Fatalf("in-tree symlink: %v", err)
	}
}

func TestStaleStagingCollected(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]node{
		StagingDir + "/old/tree/x":   file("x"),
		StagingDir + "/fresh/tree/y": file("y"),
	})
	old := time.Now().Add(-2 * StagingMaxAge)
	if err := os.Chtimes(filepath.Join(dir, StagingDir, "old"), old, old); err != nil {
		t.Fatal(err)
	}
	openTestWorkspace(t, dir, DefaultLimits())
	mustNotExist(t, filepath.Join(dir, StagingDir, "old"))
	if _, err := os.Stat(filepath.Join(dir, StagingDir, "fresh")); err != nil {
		t.Fatalf("fresh staging removed: %v", err)
	}
}

func TestScratchDir(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	dir, remove, err := ws.ScratchDir()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dir) != filepath.Join(ws.dir, StagingDir) || !strings.HasPrefix(filepath.Base(dir), scratchPrefix) {
		t.Fatalf("scratch dir %s", dir)
	}
	if err := os.WriteFile(filepath.Join(dir, "spool"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := remove(); err != nil {
		t.Fatal(err)
	}
	mustNotExist(t, dir)
}

func TestPackSpoolsOnTheWorkspaceVolume(t *testing.T) {
	dir := t.TempDir()
	// A missing process temp directory: a pack spooling in os.TempDir() would fail (a helper's /tmp is
	// a 64 MiB tmpfs, so packs must spool on the workspace volume instead).
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	ws := openTestWorkspace(t, dir, DefaultLimits())
	writeTree(t, filepath.Join(dir, "echo"), map[string]node{"scantor.yaml": file(testManifest), "main.py": file("print(1)\n")})
	var pack bytes.Buffer
	if _, err := ws.Snapshot(bg, "echo", &pack); err != nil {
		t.Fatal(err)
	}
	// The scratch directory of the spool exists only while the pack does.
	if entries, err := os.ReadDir(filepath.Join(dir, StagingDir)); err != nil || len(entries) != 0 {
		t.Fatalf("staging area after the snapshot: %v %v", entries, err)
	}
}

func TestArchiveBrowsing(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	writeTree(t, filepath.Join(ws.dir, "echo"), map[string]node{
		"scantor.yaml": file(testManifest),
		"src/main.py":  file("print(1)\n"),
		"src/deep/x":   file("x"),
		"alias":        symlink("src/main.py"),
	})
	var pack bytes.Buffer
	if _, err := ws.Snapshot(bg, "echo", &pack); err != nil {
		t.Fatal(err)
	}
	snapshot := func() io.Reader { return bytes.NewReader(pack.Bytes()) }

	res, err := ListArchive(bg, snapshot(), ListOptions{Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	live, err := ws.List(bg, "echo", ListOptions{Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	var gotPaths, livePaths []string
	for _, e := range res.Entries {
		gotPaths = append(gotPaths, e.Path+":"+e.Type)
	}
	for _, e := range live.Entries {
		livePaths = append(livePaths, e.Path+":"+e.Type)
	}
	if !slices.Equal(gotPaths, livePaths) {
		t.Fatalf("archive list %v, live list %v", gotPaths, livePaths)
	}
	res, err = ListArchive(bg, snapshot(), ListOptions{Path: "src", Recursive: false})
	if err != nil || len(res.Entries) != 2 || res.Entries[0].Path != "src/deep" || res.Entries[1].Path != "src/main.py" {
		t.Fatalf("non-recursive archive list %+v, %v", res, err)
	}
	_, err = ListArchive(bg, snapshot(), ListOptions{Path: "nope"})
	wantCode(t, err, CodeNotFound)

	rr, err := ReadArchive(bg, snapshot(), "src/main.py", 0)
	if err != nil {
		t.Fatal(err)
	}
	liveRead, err := ws.Read(bg, "echo", "src/main.py", 0)
	if err != nil || *rr != *liveRead {
		t.Fatalf("archive read %+v, live read %+v (%v)", rr, liveRead, err)
	}
	_, err = ReadArchive(bg, snapshot(), "alias", 0)
	wantCode(t, err, CodeInvalidPath)
	_, err = ReadArchive(bg, snapshot(), "src", 0)
	wantCode(t, err, CodeInvalidPath)
	_, err = ReadArchive(bg, snapshot(), "nope", 0)
	wantCode(t, err, CodeNotFound)
	_, err = ReadArchive(bg, strings.NewReader("not gzip"), "x", 0)
	wantCode(t, err, CodeInvalidArgument)
}

// A snapshot entry that the pack allows but a workspace request may not name (deeper than 32 levels, a
// folder called .scantor-staging) does not break browsing the rest of the revision.
func TestArchiveBrowsingPackPaths(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	deep := strings.Repeat("d/", MaxPathDepth) + "x"
	dir := filepath.Join(ws.dir, "echo")
	writeTree(t, dir, map[string]node{"scantor.yaml": file(testManifest), "main.py": file("x")})
	if err := os.MkdirAll(filepath.Join(dir, filepath.FromSlash(path.Dir(deep))), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTree(t, dir, map[string]node{deep: file("deep"), ".scantor-staging/y": file("y")})
	var pack bytes.Buffer
	if _, err := ws.Snapshot(bg, "echo", &pack); err != nil {
		t.Fatal(err)
	}
	snapshot := func() io.Reader { return bytes.NewReader(pack.Bytes()) }

	res, err := ListArchive(bg, snapshot(), ListOptions{Recursive: true})
	if err != nil || !slices.ContainsFunc(res.Entries, func(e FileEntry) bool { return e.Path == deep }) {
		t.Fatalf("list %+v, %v", res, err)
	}
	if rr, err := ReadArchive(bg, snapshot(), "main.py", 0); err != nil || rr.Content != "x" {
		t.Fatalf("read next to unusual paths: %+v, %v", rr, err)
	}
	// The requested path itself still follows the request rules.
	_, err = ReadArchive(bg, snapshot(), deep, 0)
	wantCode(t, err, CodeInvalidPath)
	// An entry that breaks the pack rules is a broken snapshot.
	var bad bytes.Buffer
	gz := gzip.NewWriter(&bad)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "a//b", Typeflag: tar.TypeReg, Mode: 0o644}); err != nil {
		t.Fatal(err)
	}
	_ = tw.Close()
	_ = gz.Close()
	_, err = ListArchive(bg, &bad, ListOptions{Recursive: true})
	wantCode(t, err, CodeInvalidPath)
}
