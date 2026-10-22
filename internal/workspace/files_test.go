package workspace

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// packHash returns the pack hash the task pipeline computes for dir.
func packHash(t *testing.T, dir string) string {
	t.Helper()
	pack, err := taskpipe.PackDir(bg, dir, taskpipe.PackLimits{})
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}
	defer pack.Close()
	return pack.Summary.PackSHA256
}

func TestWriteFiles(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	task := filepath.Join(ws.dir, "echo")

	if _, err := ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{"a.txt": "x"})); err == nil {
		t.Fatal("writing into a missing task folder without --create succeeded")
	} else {
		wantCode(t, err, CodeNotFound)
	}

	res, err := ws.WriteFiles(bg, "echo", true, writeRequest(t, map[string]any{
		"scantor.yaml":   testManifest,
		"src/lib/x.py":   "print('ü')\n",
		"data/blob.bin":  map[string]any{"base64": base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 255})},
		".scantor/cache": "scratch",
	}))
	if err != nil {
		t.Fatalf("WriteFiles: %v", err)
	}
	want := []string{".scantor/cache", "data/blob.bin", "scantor.yaml", "src/lib/x.py"}
	if !slices.Equal(res.Written, want) {
		t.Fatalf("written %v, want %v", res.Written, want)
	}
	if res.Workspace.PackSHA256 != packHash(t, task) {
		t.Fatalf("summary hash %s differs from the pack hash", res.Workspace.PackSHA256)
	}
	if got := readTestFile(t, filepath.Join(task, "data", "blob.bin")); got != "\x00\x01\x02\xff" {
		t.Fatalf("base64 content %q", got)
	}
	for _, e := range listTestTree(t, task) {
		wantMode := 0o644
		if e.Type == TypeDir {
			wantMode = 0o755
		}
		if e.Mode != wantMode {
			t.Errorf("%s has mode %o, want %o", e.Path, e.Mode, wantMode)
		}
		if strings.Contains(e.Path, ".scantor-tmp-") {
			t.Errorf("temporary file %s left behind", e.Path)
		}
	}

	// Overwriting replaces the content and keeps the mode.
	if _, err := ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{"src/lib/x.py": "y"})); err != nil {
		t.Fatal(err)
	}
	if got := readTestFile(t, filepath.Join(task, "src", "lib", "x.py")); got != "y" {
		t.Fatalf("content after overwrite %q", got)
	}
}

func TestWriteFilesRejections(t *testing.T) {
	tests := []struct {
		name   string
		limits Limits
		setup  map[string]node
		files  map[string]any
		raw    string
		code   Code
	}{
		{name: "invalid path", files: map[string]any{"../x": "x"}, code: CodeInvalidPath},
		{name: "staging path", files: map[string]any{".scantor-staging/x": "x"}, code: CodeInvalidPath},
		{name: "file and path below it", files: map[string]any{"a": "x", "a/b": "y"}, code: CodeInvalidPath},
		{name: "parent is a file", setup: map[string]node{"a": file("x")}, files: map[string]any{"a/b": "y"}, code: CodeInvalidPath},
		{name: "target is a directory", setup: map[string]node{"a": dir()}, files: map[string]any{"a": "y"}, code: CodeInvalidPath},
		{name: "target is a symlink", setup: map[string]node{"a": symlink("scantor.yaml")}, files: map[string]any{"a": "y"}, code: CodeInvalidPath},
		{name: "parent is a symlink", setup: map[string]node{"d": dir(), "l": symlink("d")}, files: map[string]any{"l/x": "y"}, code: CodeInvalidPath},
		{name: "invalid base64", files: map[string]any{"a": map[string]any{"base64": "!!"}}, code: CodeInvalidArgument},
		{name: "unknown content object", files: map[string]any{"a": map[string]any{"text": "x"}}, code: CodeInvalidArgument},
		{name: "unknown key", raw: `{"files": {}, "extra": 1}`, code: CodeInvalidArgument},
		{name: "missing files", raw: `{}`, code: CodeInvalidArgument},
		{name: "not json", raw: `hello`, code: CodeInvalidArgument},
		{name: "too many files in the request", files: manyFiles(MaxWriteFiles + 1), code: CodeInvalidArgument},
		{name: "entry cap", limits: Limits{MaxFiles: 3}, files: map[string]any{"a/b/c": "x", "d": "y"}, code: CodeTooManyFiles},
		{name: "byte cap", limits: Limits{MaxBytes: 10}, files: map[string]any{"a": strings.Repeat("x", 11)}, code: CodeTooLarge},
		{name: "workspace cap", limits: Limits{MaxWorkspaceBytes: 50}, setup: map[string]node{"big": file(strings.Repeat("x", 40))}, files: map[string]any{"a": strings.Repeat("x", 11)}, code: CodeWorkspaceFull},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ws := newTestWorkspace(t, tt.limits)
			task := filepath.Join(ws.dir, "echo")
			writeTree(t, task, map[string]node{"scantor.yaml": file(testManifest)})
			writeTree(t, task, tt.setup)
			before := listTestTree(t, task)
			var input io.Reader = writeRequest(t, tt.files)
			if tt.raw != "" {
				input = strings.NewReader(tt.raw)
			}
			_, err := ws.WriteFiles(bg, "echo", false, input)
			wantCode(t, err, tt.code)
			if after := listTestTree(t, task); !slices.Equal(after, before) {
				t.Fatalf("a refused write changed the task folder:\n%v\n%v", before, after)
			}
		})
	}
}

func manyFiles(n int) map[string]any {
	files := map[string]any{}
	for i := range n {
		files[strings.Repeat("f", 1+i%7)+"/"+string(rune('a'+i%26))+strings.Repeat("x", i/26)] = "x"
	}
	return files
}

func TestWriteFilesEntryCapCountsNewDirectories(t *testing.T) {
	// scantor.yaml + a + a/b + a/b/c = 4 entries.
	ws := newTestWorkspace(t, Limits{MaxFiles: 4})
	writeTree(t, filepath.Join(ws.dir, "echo"), map[string]node{"scantor.yaml": file(testManifest)})
	if _, err := ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{"a/b/c": "x"})); err != nil {
		t.Fatalf("4 entries: %v", err)
	}
	_, err := ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{"a/d/e": "x"}))
	wantCode(t, err, CodeTooManyFiles)
	// Overwriting an existing file adds nothing.
	if _, err := ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{"a/b/c": "y"})); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
}

func TestDeleteFiles(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	task := filepath.Join(ws.dir, "echo")
	writeTree(t, task, map[string]node{
		"scantor.yaml": file(testManifest),
		"a/b/c.txt":    file("c"),
		"a/d.txt":      file("d"),
		"empty":        dir(),
		"single.txt":   file("s"),
	})

	res, err := ws.DeleteFiles(bg, "echo", "single.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.Deleted, []string{"single.txt"}) || res.Workspace == nil || res.Workspace.PackSHA256 != packHash(t, task) {
		t.Fatalf("unexpected result %+v", res)
	}
	if _, err := ws.DeleteFiles(bg, "echo", "empty", false); err != nil {
		t.Fatalf("delete an empty directory: %v", err)
	}
	_, err = ws.DeleteFiles(bg, "echo", "a", false)
	wantCode(t, err, CodeInvalidArgument)
	res, err = ws.DeleteFiles(bg, "echo", "a", true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a", "a/b", "a/b/c.txt", "a/d.txt"}; !slices.Equal(res.Deleted, want) {
		t.Fatalf("deleted %v, want %v", res.Deleted, want)
	}
	_, err = ws.DeleteFiles(bg, "echo", "a", true)
	wantCode(t, err, CodeNotFound)
	_, err = ws.DeleteFiles(bg, "missing", "x", false)
	wantCode(t, err, CodeNotFound)

	// The whole task folder: workspace null; again: nothing deleted (idempotent).
	_, err = ws.DeleteFiles(bg, "echo", "", false)
	wantCode(t, err, CodeInvalidArgument)
	res, err = ws.DeleteFiles(bg, "echo", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.Deleted, []string{"scantor.yaml"}) || res.Workspace != nil {
		t.Fatalf("unexpected result %+v", res)
	}
	mustNotExist(t, task)
	res, err = ws.DeleteFiles(bg, "echo", "", true)
	if err != nil || len(res.Deleted) != 0 || res.Workspace != nil {
		t.Fatalf("second task deletion: %+v, %v", res, err)
	}
}

func TestDeleteTaskFolderThatIsASymlink(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	victim := t.TempDir()
	writeTree(t, victim, map[string]node{"keep": file("x")})
	writeTree(t, ws.dir, map[string]node{"echo": symlink(victim)})
	_, err := ws.DeleteFiles(bg, "echo", "", true)
	wantCode(t, err, CodeInvalidPath)
	if got := readTestFile(t, filepath.Join(victim, "keep")); got != "x" {
		t.Fatal("the symlink target was touched")
	}
}

func TestListAndRead(t *testing.T) {
	ws := newTestWorkspace(t, DefaultLimits())
	task := filepath.Join(ws.dir, "echo")
	writeTree(t, task, map[string]node{
		"scantor.yaml": file(testManifest),
		"src/main.py":  file("print(1)\n"),
		"src/run.sh":   execFile("#!/bin/sh\n"),
		"bin.dat":      file("\x00\x01binary"),
		"link":         symlink("src/main.py"),
		"z/deep/x":     file("x"),
	})

	res, err := ws.List(bg, "echo", ListOptions{Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, e := range res.Entries {
		paths = append(paths, e.Path+":"+e.Type)
	}
	want := []string{"bin.dat:file", "link:symlink", "scantor.yaml:file", "src:dir", "src/main.py:file", "src/run.sh:file", "z:dir", "z/deep:dir", "z/deep/x:file"}
	if !slices.Equal(paths, want) || res.Truncated {
		t.Fatalf("entries %v (truncated %t), want %v", paths, res.Truncated, want)
	}
	if res.Entries[5].Mode != 0o755 || res.Entries[4].Size != 9 {
		t.Fatalf("unexpected mode or size: %+v", res.Entries)
	}

	res, err = ws.List(bg, "echo", ListOptions{Path: "z", Recursive: false})
	if err != nil || len(res.Entries) != 1 || res.Entries[0].Path != "z/deep" {
		t.Fatalf("non-recursive list: %+v, %v", res, err)
	}
	res, err = ws.List(bg, "echo", ListOptions{Recursive: true, MaxEntries: 2})
	if err != nil || len(res.Entries) != 2 || !res.Truncated {
		t.Fatalf("truncated list: %+v, %v", res, err)
	}
	res, err = ws.List(bg, "echo", ListOptions{Path: "src/main.py"})
	if err != nil || len(res.Entries) != 1 || res.Entries[0].Type != TypeFile {
		t.Fatalf("list of a file: %+v, %v", res, err)
	}
	_, err = ws.List(bg, "echo", ListOptions{Path: "nope"})
	wantCode(t, err, CodeNotFound)
	_, err = ws.List(bg, "nope", ListOptions{})
	wantCode(t, err, CodeNotFound)

	rr, err := ws.Read(bg, "echo", "src/main.py", 0)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("print(1)\n"))
	if rr.Encoding != EncodingUTF8 || rr.Content != "print(1)\n" || rr.Truncated || rr.Size != 9 || rr.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("unexpected read %+v", rr)
	}
	rr, err = ws.Read(bg, "echo", "bin.dat", 0)
	if err != nil || rr.Encoding != EncodingBase64 || rr.Content != base64.StdEncoding.EncodeToString([]byte("\x00\x01binary")) {
		t.Fatalf("binary read %+v, %v", rr, err)
	}
	rr, err = ws.Read(bg, "echo", "src/main.py", 5)
	if err != nil || rr.Content != "print" || !rr.Truncated || rr.Size != 9 || rr.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("truncated read %+v, %v", rr, err)
	}
	_, err = ws.Read(bg, "echo", "link", 0)
	wantCode(t, err, CodeInvalidPath)
	_, err = ws.Read(bg, "echo", "src", 0)
	wantCode(t, err, CodeInvalidPath)
	_, err = ws.Read(bg, "echo", "nope", 0)
	wantCode(t, err, CodeNotFound)
}

func TestReadContentEncoding(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		max      int64
		encoding string
		want     string
	}{
		{"utf8", "héllo", 0, EncodingUTF8, "héllo"},
		{"cut inside a rune", "aé", 2, EncodingUTF8, "a"},
		{"nul is binary", "a\x00b", 0, EncodingBase64, base64.StdEncoding.EncodeToString([]byte("a\x00b"))},
		{"invalid utf8 is binary", "a\xffb", 0, EncodingBase64, base64.StdEncoding.EncodeToString([]byte("a\xffb"))},
		{"empty", "", 0, EncodingUTF8, ""},
		{"truncated rune at the end of the file", "a\xc3", 0, EncodingBase64, base64.StdEncoding.EncodeToString([]byte("a\xc3"))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := readContent(bg, "f", &chunkReader{data: []byte(tt.content), chunk: 1}, tt.max)
			if err != nil {
				t.Fatal(err)
			}
			if res.Encoding != tt.encoding || res.Content != tt.want {
				t.Fatalf("got %s %q, want %s %q", res.Encoding, res.Content, tt.encoding, tt.want)
			}
		})
	}
}

// chunkReader returns data in chunks of chunk bytes, so rune boundaries fall between reads.
type chunkReader struct {
	data  []byte
	chunk int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p[:min(len(p), c.chunk)], c.data)
	c.data = c.data[n:]
	return n, nil
}
