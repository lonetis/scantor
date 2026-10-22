package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// testManifest is a valid manifest of the task "echo".
const testManifest = "scantor: 1\nname: echo\nlanguage: python\n"

// testWorkspace is a workspace in a temporary directory with its stderr events.
type testWorkspace struct {
	*Workspace
	dir    string
	stderr *bytes.Buffer
}

func newTestWorkspace(t *testing.T, limits Limits) *testWorkspace {
	t.Helper()
	dir := t.TempDir()
	return openTestWorkspace(t, dir, limits)
}

func openTestWorkspace(t *testing.T, dir string, limits Limits) *testWorkspace {
	t.Helper()
	stderr := &bytes.Buffer{}
	ws, err := Open(dir, limits, NewEvents(stderr))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := ws.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return &testWorkspace{Workspace: ws, dir: dir, stderr: stderr}
}

// node describes one entry of a test tree: a file (content), a directory (dir) or a symlink (link).
type node struct {
	content string
	dir     bool
	link    string
	mode    fs.FileMode
}

func file(content string) node     { return node{content: content} }
func dir() node                    { return node{dir: true} }
func symlink(target string) node   { return node{link: target} }
func execFile(content string) node { return node{content: content, mode: 0o755} }

// writeTree creates the entries of tree below root; parents are created as needed.
func writeTree(t *testing.T, root string, tree map[string]node) {
	t.Helper()
	paths := make([]string, 0, len(tree))
	for p := range tree {
		paths = append(paths, p)
	}
	slices.Sort(paths)
	for _, p := range paths {
		n := tree[p]
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		var err error
		switch {
		case n.dir:
			err = os.MkdirAll(full, 0o755)
		case n.link != "":
			err = os.Symlink(n.link, full)
		default:
			mode := n.mode
			if mode == 0 {
				mode = 0o644
			}
			err = os.WriteFile(full, []byte(n.content), mode)
			if err == nil {
				err = os.Chmod(full, mode)
			}
		}
		if err != nil {
			t.Fatalf("create %s: %v", p, err)
		}
	}
}

// treeEntry is one entry of a tree as listTestTree reports it.
type treeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Mode int    `json:"mode"`
}

// listTestTree lists every entry below root (lstat only), sorted by path.
func listTestTree(t *testing.T, root string) []treeEntry {
	t.Helper()
	var out []treeEntry
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		e := treeEntry{Path: filepath.ToSlash(rel), Mode: int(info.Mode().Perm())}
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			e.Type = TypeSymlink
		case info.IsDir():
			e.Type = TypeDir
		default:
			e.Type = TypeFile
		}
		out = append(out, e)
		return nil
	})
	if err != nil {
		t.Fatalf("list %s: %v", root, err)
	}
	slices.SortFunc(out, func(a, b treeEntry) int { return strings.Compare(a.Path, b.Path) })
	return out
}

func readTestFile(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(data)
}

// wantCode fails unless err is a helper error with code.
func wantCode(t *testing.T, err error, code Code) {
	t.Helper()
	_ = codeOf(t, err, code)
}

// codeOf fails unless err is a helper error with code and returns it.
func codeOf(t *testing.T, err error, code Code) *Error {
	t.Helper()
	if err == nil {
		t.Fatalf("got no error, want %s", code)
	}
	var werr *Error
	if !errors.As(err, &werr) {
		t.Fatalf("got %T %v, want a helper error %s", err, err, code)
	}
	if werr.Code != code {
		t.Fatalf("got %s (%v), want %s", werr.Code, werr, code)
	}
	return werr
}

func mustNotExist(t *testing.T, p string) {
	t.Helper()
	if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s exists (err %v), want it absent", p, err)
	}
}

// writeRequest encodes a write-files request.
func writeRequest(t *testing.T, files map[string]any) *bytes.Reader {
	t.Helper()
	data, err := json.Marshal(map[string]any{"files": files})
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(data)
}

// repoFile returns the path of a repository file from this package's directory.
func repoFile(parts ...string) string {
	return filepath.Join(append([]string{"..", ".."}, parts...)...)
}

var bg = context.Background()
