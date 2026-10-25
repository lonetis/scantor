package taskpipe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// tarEntry is one entry of a decoded tar for assertions.
type tarEntry struct {
	Name     string
	Type     byte
	Mode     int64
	Linkname string
	Content  string
}

func readTarGz(t *testing.T, data []byte) ([]tarEntry, *gzip.Header) {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	hdr := gz.Header
	tr := tar.NewReader(gz)
	var out []tarEntry
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Uid != 0 || h.Gid != 0 || h.Uname != "" || h.Gname != "" || !h.ModTime.Equal(time.Unix(0, 0)) {
			t.Errorf("entry %s: owner %d:%d %q:%q mtime %v; want 0:0, empty names, mtime 0", h.Name, h.Uid, h.Gid, h.Uname, h.Gname, h.ModTime)
		}
		content, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, tarEntry{Name: h.Name, Type: h.Typeflag, Mode: h.Mode, Linkname: h.Linkname, Content: string(content)})
	}
	return out, &hdr
}

func names(entries []tarEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name
	}
	return out
}

func TestPackDeterministic(t *testing.T) {
	files := minimalTask()
	files["lib/util.py"] = "x = 1\n"
	files["lib/data/a.txt"] = "a"
	a := writeTree(t, files)
	b := writeTree(t, files)
	// Times, permissions without execute bits and creation order do not matter.
	old := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(b, "main.py"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(b, "lib", "util.py"), 0o600); err != nil {
		t.Fatal(err)
	}
	pa, pb := mustPackDir(t, a), mustPackDir(t, b)
	if pa.Summary.PackSHA256 != pb.Summary.PackSHA256 {
		t.Fatalf("same tree, different hashes: %s vs %s", pa.Summary.PackSHA256, pb.Summary.PackSHA256)
	}
	if ga, gb := gzipOf(t, pa), gzipOf(t, pb); !bytes.Equal(ga, gb) || int64(len(ga)) != pa.Summary.PackBytes {
		t.Fatalf("the tar.gz differs or its size (%d) is not packBytes (%d)", len(ga), pa.Summary.PackBytes)
	}
	// The hash is the SHA-256 of the uncompressed tar.
	tarBytes, err := io.ReadAll(pa.Tar())
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tarBytes)
	if hex.EncodeToString(sum[:]) != pa.Summary.PackSHA256 || int64(len(tarBytes)) != pa.Summary.Bytes {
		t.Fatal("packSha256/bytes do not describe the uncompressed tar")
	}
	if pa.Summary.FileCount != 7 {
		t.Fatalf("fileCount = %d, want 7 regular files", pa.Summary.FileCount)
	}

	// Content and execute bits change the hash.
	if err := os.WriteFile(filepath.Join(b, "main.py"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if mustPackDir(t, b).Summary.PackSHA256 == pa.Summary.PackSHA256 {
		t.Fatal("changed content kept the hash")
	}
	if err := os.Chmod(filepath.Join(a, "lib", "util.py"), 0o700); err != nil {
		t.Fatal(err)
	}
	if mustPackDir(t, a).Summary.PackSHA256 == pa.Summary.PackSHA256 {
		t.Fatal("an execute bit kept the hash")
	}
}

func TestPackLayout(t *testing.T) {
	files := minimalTask()
	files["b/z.txt"] = "z"
	files["a-b.txt"] = "ab"
	files["a/x.txt"] = "x"
	dir := writeTree(t, files)
	if err := os.Chmod(filepath.Join(dir, "a", "x.txt"), 0o751); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../main.py", filepath.Join(dir, "b", "link.py")); err != nil {
		t.Fatal(err)
	}
	p := mustPackDir(t, dir)
	entries, gzHdr := readTarGz(t, gzipOf(t, p))
	// Bytewise order of the entry paths (without the trailing slash of directory names), so a directory
	// comes before its contents.
	want := []string{".dockerignore", "Dockerfile", "a/", "a-b.txt", "a/x.txt", "b/", "b/link.py", "b/z.txt", "main.py", "requirements.txt", "scantor.yaml"}
	if got := names(entries); !slices.Equal(got, want) {
		t.Fatalf("entries:\n got  %v\n want %v", got, want)
	}
	for _, e := range entries {
		switch e.Name {
		case "a/", "b/":
			if e.Type != tar.TypeDir || e.Mode != 0o755 {
				t.Errorf("%s: type %c mode %o", e.Name, e.Type, e.Mode)
			}
		case "a/x.txt":
			if e.Mode != 0o755 {
				t.Errorf("executable file mode %o, want 0755", e.Mode)
			}
		case "b/link.py":
			if e.Type != tar.TypeSymlink || e.Linkname != "../main.py" || e.Content != "" {
				t.Errorf("symlink stored as %+v; want a symlink, never dereferenced", e)
			}
		default:
			if e.Type != tar.TypeReg || e.Mode != 0o644 {
				t.Errorf("%s: type %c mode %o, want a 0644 file", e.Name, e.Type, e.Mode)
			}
		}
	}
	if gzHdr.Name != "" || !gzHdr.ModTime.IsZero() || gzHdr.OS != 255 {
		t.Fatalf("gzip header %+v: want no name, mtime 0, OS 255", gzHdr)
	}
	if p.Summary.FileCount != 8 {
		t.Fatalf("fileCount = %d, want 8 (symlinks and directories are not files)", p.Summary.FileCount)
	}
	data, err := p.ReadFile("a/x.txt", 10)
	if err != nil || string(data) != "x" {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
	if _, err := p.ReadFile("b/link.py", 10); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("ReadFile of a symlink: %v", err)
	}
	var tooLarge *FileTooLargeError
	if _, err := p.ReadFile("a-b.txt", 1); !errors.As(err, &tooLarge) {
		t.Fatalf("ReadFile over the limit: %v", err)
	}
}

func TestPackDockerignore(t *testing.T) {
	files := minimalTask()
	files[".dockerignore"] = strings.Join([]string{
		"# comment",
		"*.log",
		"build/",
		"!build/keep.txt",
		"secrets",
		"Dockerfile",
		"scantor.yaml",
		".dockerignore",
		"**/__pycache__",
	}, "\n")
	files["app.log"] = "log"
	files["sub/app.log"] = "nested logs are not matched by *.log"
	files["build/out.bin"] = "out"
	files["build/keep.txt"] = "keep"
	files["secrets/token"] = "secret"
	files["pkg/__pycache__/m.pyc"] = "pyc"
	files["pkg/m.py"] = "m"
	files[".git/config"] = "[core]"
	files["sub/.git/HEAD"] = "ref"
	files[".scantor/out/x"] = "out"
	p := mustPackDir(t, writeTree(t, files))
	entries, _ := readTarGz(t, gzipOf(t, p))
	want := []string{".dockerignore", "Dockerfile", "build/", "build/keep.txt", "main.py", "pkg/", "pkg/m.py", "requirements.txt", "scantor.yaml", "sub/", "sub/app.log"}
	if got := names(entries); !slices.Equal(got, want) {
		t.Fatalf("entries:\n got  %v\n want %v", got, want)
	}
}

// FileSet is the pack's decision exported for the workspace's cap checks.
func TestFileSetClassify(t *testing.T) {
	set, err := NewFileSet([]byte("build/\n!build/keep.txt\nnode_modules\nDockerfile\n"))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		path  string
		isDir bool
		want  Inclusion
	}{
		{"main.py", false, Included},
		{"Dockerfile", false, Included},
		{".git", true, Excluded},
		{"sub/.scantor/x", false, Excluded},
		{"node_modules", true, Excluded},
		{"node_modules/x/index.js", false, Excluded},
		{"build", true, ExcludedDescend},
		{"build/out.bin", false, Excluded},
		{"build/keep.txt", false, Included},
	}
	for _, tt := range tests {
		if got, err := set.Classify(tt.path, tt.isDir); got != tt.want || err != nil {
			t.Errorf("Classify(%q) = %v, %v; want %v", tt.path, got, err, tt.want)
		}
	}
	var none *FileSet
	if got, _ := none.Classify("node_modules", true); got != Included {
		t.Errorf("a nil FileSet excludes %v", got)
	}
	if _, err := NewFileSet(make([]byte, maxIgnoreFileBytes+1)); err == nil {
		t.Error("an oversized .dockerignore is accepted")
	}
}

func TestPackRejects(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, dir string)
		path  string
		want  string
	}{
		{
			name:  "absolute symlink",
			setup: func(t *testing.T, dir string) { symlink(t, "/proc/self/environ", filepath.Join(dir, "x")) },
			path:  "x",
			want:  "absolute path",
		},
		{
			name:  "escaping symlink",
			setup: func(t *testing.T, dir string) { symlink(t, "../../etc/passwd", filepath.Join(dir, "x")) },
			path:  "x",
			want:  "outside the task folder",
		},
		{
			name: "fifo",
			setup: func(t *testing.T, dir string) {
				if runtime.GOOS == "windows" {
					t.Skip("no FIFOs")
				}
				if err := syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o644); err != nil {
					t.Fatal(err)
				}
			},
			path: "pipe",
			want: "named pipe",
		},
		{
			name: "hard link to a file outside",
			setup: func(t *testing.T, dir string) {
				outside := filepath.Join(t.TempDir(), "outside")
				if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(outside, filepath.Join(dir, "linked")); err != nil {
					t.Skipf("hard links unsupported: %v", err)
				}
			},
			path: "linked",
			want: "hard link",
		},
		{
			name: "backslash in a name",
			setup: func(t *testing.T, dir string) {
				if err := os.WriteFile(filepath.Join(dir, `a\b`), nil, 0o644); err != nil {
					t.Skipf("cannot create the name: %v", err)
				}
			},
			path: `a\b`,
			want: "backslash",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeTree(t, minimalTask())
			tt.setup(t, dir)
			_, err := PackDir(context.Background(), dir, testLimits())
			var problems PackErrors
			if !errors.As(err, &problems) {
				t.Fatalf("err = %v, want PackErrors", err)
			}
			if len(problems) != 1 || problems[0].Path != tt.path || !strings.Contains(problems[0].Message, tt.want) || problems[0].Cap != "" {
				t.Fatalf("problems = %v, want one about %s containing %q", problems, tt.path, tt.want)
			}
		})
	}
}

func symlink(t *testing.T, target, name string) {
	t.Helper()
	if err := os.Symlink(target, name); err != nil {
		t.Fatal(err)
	}
}

func TestPackHardLinksInside(t *testing.T) {
	dir := writeTree(t, minimalTask())
	if err := os.Link(filepath.Join(dir, "main.py"), filepath.Join(dir, "copy.py")); err != nil {
		t.Skipf("hard links unsupported: %v", err)
	}
	p := mustPackDir(t, dir)
	if data, err := p.ReadFile("copy.py", 100); err != nil || string(data) != "import scantor\n" {
		t.Fatalf("a hard link inside the folder is packed as a regular file: %q %v", data, err)
	}
}

func TestPackCaps(t *testing.T) {
	files := minimalTask()
	files["big.bin"] = strings.Repeat("0123456789abcdef", 4096) // 64 KiB of compressible data
	dir := writeTree(t, files)
	tests := []struct {
		limits PackLimits
		cap    string
	}{
		{PackLimits{MaxFiles: 3}, CapFiles},
		{PackLimits{MaxBytes: 32 << 10}, CapBytes},
		{PackLimits{MaxPackBytes: 512}, CapPackBytes},
	}
	for _, tt := range tests {
		t.Run(tt.cap, func(t *testing.T) {
			_, err := PackDir(context.Background(), dir, tt.limits)
			var problems PackErrors
			if !errors.As(err, &problems) || len(problems) != 1 || problems[0].Cap != tt.cap || !strings.Contains(problems[0].Message, tt.cap) {
				t.Fatalf("err = %v, want a %s cap error", err, tt.cap)
			}
		})
	}
	if _, err := PackDir(context.Background(), dir, PackLimits{MaxFiles: 6, MaxBytes: 1 << 20, MaxPackBytes: 1 << 20}); err != nil {
		t.Fatalf("within the caps: %v", err)
	}
}

func TestPackPathRules(t *testing.T) {
	long := strings.Repeat("a", MaxSegmentBytes)
	for p, want := range map[string]string{
		"ok/file.txt":                         "",
		long:                                  "",
		long + "a":                            "segment",
		strings.Repeat(long+"/", 4) + "x.txt": "longer than 1024",
		"a//b":                                "empty",
		"./a":                                 "empty or '.'",
		"a/../b":                              "'..'",
		"/abs":                                "absolute",
		"a\x00b":                              "NUL",
		"a\\b":                                "backslash",
		"bad\xffutf8":                         "UTF-8",
	} {
		got := checkPath(p)
		if (want == "") != (got == "") || !strings.Contains(got, want) {
			t.Errorf("checkPath(%q) = %q, want %q", p, got, want)
		}
	}
	for target, want := range map[string]string{
		"sibling":     "",
		"../main.py":  "",
		"../../x":     "outside",
		"/etc/passwd": "absolute",
		"":            "empty",
	} {
		got := checkLink("dir/link", target)
		if (want == "") != (got == "") || !strings.Contains(got, want) {
			t.Errorf("checkLink(dir/link, %q) = %q, want %q", target, got, want)
		}
	}
}

func TestReadPackRoundTrip(t *testing.T) {
	files := minimalTask()
	files["lib/x.py"] = "x"
	dir := writeTree(t, files)
	symlink(t, "lib/x.py", filepath.Join(dir, "alias.py"))
	p := mustPackDir(t, dir)
	read, err := ReadPack(context.Background(), bytes.NewReader(gzipOf(t, p)), testLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	if read.Summary != p.Summary {
		t.Fatalf("ReadPack summary %+v, PackDir summary %+v", read.Summary, p.Summary)
	}
}

// archive builds a tar.gz from raw headers and contents (nil content for non-files).
func archive(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.Name, Typeflag: e.Type, Mode: e.Mode, Linkname: e.Linkname, Size: int64(len(e.Content)), Uid: 1000, Uname: "user", ModTime: time.Now()}
		if e.Type != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.Type == tar.TypeReg {
			if _, err := tw.Write([]byte(e.Content)); err != nil {
				t.Fatal(err)
			}
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

func TestReadPackCanonicalises(t *testing.T) {
	// A foreign archive: ./ prefixes, no directory entries, owners and mtimes set, .git and an ignored
	// file included. It is re-written exactly as PackDir writes the same folder.
	data := archive(t,
		tarEntry{Name: "./scantor.yaml", Type: tar.TypeReg, Mode: 0o600, Content: testManifest},
		tarEntry{Name: "./Dockerfile", Type: tar.TypeReg, Mode: 0o644, Content: testDockerfile},
		tarEntry{Name: "./main.py", Type: tar.TypeReg, Mode: 0o644, Content: "import scantor\n"},
		tarEntry{Name: "./requirements.txt", Type: tar.TypeReg, Mode: 0o644},
		tarEntry{Name: "./.dockerignore", Type: tar.TypeReg, Mode: 0o644, Content: ".git/\n*.log\n"},
		tarEntry{Name: "./lib/x.py", Type: tar.TypeReg, Mode: 0o755, Content: "x"},
		tarEntry{Name: "./.git/HEAD", Type: tar.TypeReg, Mode: 0o644, Content: "ref"},
		tarEntry{Name: "./debug.log", Type: tar.TypeReg, Mode: 0o644, Content: "log"},
	)
	read, err := ReadPack(context.Background(), bytes.NewReader(data), testLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()

	files := minimalTask()
	files[".dockerignore"] = ".git/\n*.log\n"
	files["lib/x.py"] = "x"
	files["debug.log"] = "log"
	dir := writeTree(t, files)
	if err := os.Chmod(filepath.Join(dir, "lib", "x.py"), 0o755); err != nil {
		t.Fatal(err)
	}
	if want := mustPackDir(t, dir).Summary; read.Summary != want {
		t.Fatalf("ReadPack %+v, PackDir %+v", read.Summary, want)
	}
}

func TestReadPackRejects(t *testing.T) {
	tests := []struct {
		name    string
		entries []tarEntry
		want    string
	}{
		{"absolute path", []tarEntry{{Name: "/etc/passwd", Type: tar.TypeReg, Content: "x"}}, "absolute"},
		{"dot-dot", []tarEntry{{Name: "a/../../x", Type: tar.TypeReg, Content: "x"}}, "'..'"},
		{"hard link", []tarEntry{{Name: "a", Type: tar.TypeReg, Content: "x"}, {Name: "b", Type: tar.TypeLink, Linkname: "a"}}, "hard link"},
		{"device", []tarEntry{{Name: "dev", Type: tar.TypeChar}}, "unsupported entry type"},
		{"duplicate", []tarEntry{{Name: "a", Type: tar.TypeReg, Content: "x"}, {Name: "a", Type: tar.TypeReg, Content: "y"}}, "twice"},
		{"escaping symlink", []tarEntry{{Name: "l", Type: tar.TypeSymlink, Linkname: "../x"}}, "outside"},
		{"file as parent", []tarEntry{{Name: "a", Type: tar.TypeReg, Content: "x"}, {Name: "a/b", Type: tar.TypeReg, Content: "y"}}, "not a directory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ReadPack(context.Background(), bytes.NewReader(archive(t, tt.entries...)), testLimits())
			var problems PackErrors
			if !errors.As(err, &problems) || !strings.Contains(problems.Error(), tt.want) {
				t.Fatalf("err = %v, want a pack problem containing %q", err, tt.want)
			}
		})
	}
	t.Run("not gzip", func(t *testing.T) {
		_, err := ReadPack(context.Background(), strings.NewReader("plain text"), testLimits())
		var problems PackErrors
		if !errors.As(err, &problems) || !strings.Contains(problems.Error(), "not a valid tar.gz") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestReadPackCaps(t *testing.T) {
	// A gzip bomb: 8 MiB of zeros compress to a few KiB; the uncompressed cap stops it while streaming.
	bomb := archive(t, tarEntry{Name: "zeros", Type: tar.TypeReg, Content: string(make([]byte, 8<<20))})
	tests := []struct {
		limits PackLimits
		cap    string
	}{
		{PackLimits{MaxBytes: 1 << 20}, CapBytes},
		{PackLimits{MaxPackBytes: 1 << 10}, CapPackBytes},
		{PackLimits{MaxFiles: 1}, CapFiles},
	}
	for _, tt := range tests {
		t.Run(tt.cap, func(t *testing.T) {
			data := bomb
			if tt.cap == CapFiles {
				data = archive(t, tarEntry{Name: "a", Type: tar.TypeReg}, tarEntry{Name: "b", Type: tar.TypeReg})
			}
			_, err := ReadPack(context.Background(), bytes.NewReader(data), tt.limits)
			var problems PackErrors
			if !errors.As(err, &problems) || problems[0].Cap != tt.cap {
				t.Fatalf("err = %v, want the %s cap", err, tt.cap)
			}
		})
	}
}

func TestPackCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PackDir(ctx, writeTree(t, minimalTask()), testLimits()); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestPackMissingFolder(t *testing.T) {
	_, err := PackDir(context.Background(), filepath.Join(t.TempDir(), "missing"), testLimits())
	var problems PackErrors
	if !errors.As(err, &problems) {
		t.Fatalf("err = %v, want a pack problem", err)
	}
}

func TestPackTempDir(t *testing.T) {
	spoolDir := t.TempDir()
	limits := testLimits()
	limits.TempDir = spoolDir
	spools := func() []string {
		t.Helper()
		entries, err := os.ReadDir(spoolDir)
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		return names
	}

	p, err := PackDir(context.Background(), writeTree(t, minimalTask()), limits)
	if err != nil {
		t.Fatal(err)
	}
	if got := spools(); len(got) != 1 || !strings.HasPrefix(got[0], "scantor-pack-") {
		t.Fatalf("PackDir spools %v, want one tar spool in TempDir", got)
	}
	read, err := ReadPack(context.Background(), bytes.NewReader(gzipOf(t, p)), limits)
	if err != nil {
		t.Fatal(err)
	}
	// The input spool of ReadPack is gone once it returns; its tar spool stays until Close.
	if got := spools(); len(got) != 2 {
		t.Fatalf("spools after ReadPack %v, want the two tar spools", got)
	}
	if read.Summary != p.Summary {
		t.Fatalf("ReadPack summary %+v, PackDir summary %+v", read.Summary, p.Summary)
	}
	for _, pk := range []*Pack{p, read} {
		if err := pk.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if got := spools(); len(got) != 0 {
		t.Fatalf("spools after Close %v", got)
	}
}
