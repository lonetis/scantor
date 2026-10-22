package workspace

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The tar-slip corpus (tests/corpora/tar-slip/cases.json, docs/security.md WS-3) describes upload
// archives declaratively; this file builds them and runs extract.

type slipCorpus struct {
	Version     int        `json:"version"`
	Description string     `json:"description"`
	Manifest    string     `json:"manifest"`
	Cases       []slipCase `json:"cases"`
}

type slipCase struct {
	ID          string          `json:"id"`
	Description string          `json:"description"`
	Format      string          `json:"format"`
	Raw         *string         `json:"raw"`
	Limits      *slipLimits     `json:"limits"`
	Workspace   []setupEntry    `json:"workspace"`
	Entries     []archiveSpec   `json:"entries"`
	Expect      slipExpectation `json:"expect"`
}

type slipLimits struct {
	MaxFiles          *int   `json:"maxFiles"`
	MaxBytes          *int64 `json:"maxBytes"`
	MaxPackBytes      *int64 `json:"maxPackBytes"`
	MaxWorkspaceBytes *int64 `json:"maxWorkspaceBytes"`
}

type setupEntry struct {
	Path    string  `json:"path"`
	Symlink string  `json:"symlink"`
	File    *string `json:"file"`
	Dir     bool    `json:"dir"`
}

type archiveSpec struct {
	Name         string            `json:"name"`
	NameBase64   string            `json:"nameBase64"`
	Type         string            `json:"type"`
	Content      string            `json:"content"`
	Zeros        int64             `json:"zeros"`
	Random       int64             `json:"random"`
	Mode         int64             `json:"mode"`
	Linkname     string            `json:"linkname"`
	Devmajor     int64             `json:"devmajor"`
	Devminor     int64             `json:"devminor"`
	DeclaredSize *uint64           `json:"declaredSize"`
	Generate     *generateSpec     `json:"generate"`
	GlobalPax    map[string]string `json:"globalPax"`
}

type generateSpec struct {
	Prefix  string `json:"prefix"`
	Count   int    `json:"count"`
	Content string `json:"content"`
}

type slipExpectation struct {
	OK   bool        `json:"ok"`
	Code Code        `json:"code"`
	Path *string     `json:"path"`
	Tree []treeEntry `json:"tree"`
}

func (s archiveSpec) name(t *testing.T) string {
	if s.NameBase64 == "" {
		return s.Name
	}
	raw, err := base64.StdEncoding.DecodeString(s.NameBase64)
	if err != nil {
		t.Fatalf("nameBase64: %v", err)
	}
	return string(raw)
}

func (s archiveSpec) mode(def int64) int64 {
	if s.Mode != 0 {
		return s.Mode
	}
	return def
}

// content returns the entry's content as a reader and its size.
func (s archiveSpec) content(t *testing.T) (io.Reader, int64) {
	switch {
	case s.Zeros > 0:
		return io.LimitReader(zeroReader{}, s.Zeros), s.Zeros
	case s.Random > 0:
		data := make([]byte, s.Random)
		if _, err := rand.Read(data); err != nil {
			t.Fatal(err)
		}
		return bytes.NewReader(data), s.Random
	default:
		return strings.NewReader(s.Content), int64(len(s.Content))
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// expand replaces generate specs with the entries they describe.
func expand(specs []archiveSpec) []archiveSpec {
	var out []archiveSpec
	for _, s := range specs {
		if s.Generate == nil {
			out = append(out, s)
			continue
		}
		for i := range s.Generate.Count {
			out = append(out, archiveSpec{Name: fmt.Sprintf("%s%d", s.Generate.Prefix, i), Type: "file", Content: s.Generate.Content})
		}
	}
	return out
}

// buildTarGz streams the tar.gz of specs into w; it stops at the first write error (the reader gave up).
func buildTarGz(t *testing.T, w io.Writer, specs []archiveSpec) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	for _, s := range expand(specs) {
		if s.GlobalPax != nil {
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeXGlobalHeader, PAXRecords: s.GlobalPax}); err != nil {
				return err
			}
			continue
		}
		hdr := &tar.Header{Name: s.name(t), Mode: s.mode(0o644), Linkname: s.Linkname, Devmajor: s.Devmajor, Devminor: s.Devminor}
		var content io.Reader
		switch s.Type {
		case "file":
			hdr.Typeflag = tar.TypeReg
			content, hdr.Size = s.content(t)
		case "dir":
			hdr.Typeflag, hdr.Mode = tar.TypeDir, s.mode(0o755)
		case "symlink":
			hdr.Typeflag = tar.TypeSymlink
		case "hardlink":
			hdr.Typeflag = tar.TypeLink
		case "char":
			hdr.Typeflag = tar.TypeChar
		case "block":
			hdr.Typeflag = tar.TypeBlock
		case "fifo":
			hdr.Typeflag = tar.TypeFifo
		default:
			t.Fatalf("unknown entry type %q", s.Type)
		}
		if needsPAX(hdr.Name) {
			hdr.Format = tar.FormatPAX
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if content != nil {
			if _, err := io.Copy(tw, content); err != nil {
				return err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func needsPAX(name string) bool {
	return len(name) > 100 || strings.ContainsFunc(name, func(r rune) bool { return r >= 0x80 || r == 0xfffd })
}

// buildZip returns the zip archive of specs.
func buildZip(t *testing.T, specs []archiveSpec) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, s := range expand(specs) {
		hdr := &zip.FileHeader{Name: s.name(t), Method: zip.Deflate}
		switch s.Type {
		case "file":
			hdr.SetMode(fs.FileMode(s.mode(0o644)))
		case "dir":
			hdr.Name = strings.TrimSuffix(hdr.Name, "/") + "/"
			hdr.SetMode(fs.ModeDir | fs.FileMode(s.mode(0o755)))
		case "symlink":
			hdr.SetMode(fs.ModeSymlink | 0o777)
			s.Content = s.Linkname
		default:
			t.Fatalf("zip entries of type %q are not supported", s.Type)
		}
		content, size := s.content(t)
		if s.DeclaredSize != nil {
			writeRawZipEntry(t, zw, hdr, content, *s.DeclaredSize)
			continue
		}
		hdr.UncompressedSize64 = uint64(size)
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(w, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// writeRawZipEntry writes an entry whose headers claim declared uncompressed bytes.
func writeRawZipEntry(t *testing.T, zw *zip.Writer, hdr *zip.FileHeader, content io.Reader, declared uint64) {
	data, err := io.ReadAll(content)
	if err != nil {
		t.Fatal(err)
	}
	var compressed bytes.Buffer
	fw, err := flate.NewWriter(&compressed, flate.BestCompression)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := fw.Close(); err != nil {
		t.Fatal(err)
	}
	hdr.CRC32 = crc32.ChecksumIEEE(data)
	hdr.CompressedSize64 = uint64(compressed.Len())
	hdr.UncompressedSize64 = declared
	w, err := zw.CreateRaw(hdr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(compressed.Bytes()); err != nil {
		t.Fatal(err)
	}
}

// archiveInput returns the upload stream of a case; tar.gz archives are streamed lazily, so a bomb is
// only generated as far as extract reads it.
func archiveInput(t *testing.T, c slipCase) io.Reader {
	switch {
	case c.Raw != nil:
		return strings.NewReader(*c.Raw)
	case c.Format == "zip":
		return bytes.NewReader(buildZip(t, c.Entries))
	case c.Format == "" || c.Format == "tar.gz":
		pr, pw := io.Pipe()
		go func() { pw.CloseWithError(buildTarGz(t, pw, c.Entries)) }()
		t.Cleanup(func() { pr.Close() })
		return pr
	default:
		t.Fatalf("unknown format %q", c.Format)
		return nil
	}
}

func (l *slipLimits) apply(limits Limits) Limits {
	if l == nil {
		return limits
	}
	if l.MaxFiles != nil {
		limits.MaxFiles = *l.MaxFiles
	}
	if l.MaxBytes != nil {
		limits.MaxBytes = *l.MaxBytes
	}
	if l.MaxPackBytes != nil {
		limits.MaxPackBytes = *l.MaxPackBytes
	}
	if l.MaxWorkspaceBytes != nil {
		limits.MaxWorkspaceBytes = *l.MaxWorkspaceBytes
	}
	return limits
}

func setupWorkspace(t *testing.T, root string, entries []setupEntry) {
	t.Helper()
	tree := map[string]node{}
	for _, e := range entries {
		switch {
		case e.Symlink != "":
			tree[e.Path] = symlink(e.Symlink)
		case e.File != nil:
			tree[e.Path] = file(*e.File)
		case e.Dir:
			tree[e.Path] = dir()
		default:
			t.Fatalf("setup entry %q has no kind", e.Path)
		}
	}
	writeTree(t, root, tree)
}

func loadJSON(t *testing.T, p string, v any) {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("decode %s: %v", p, err)
	}
}

func TestTarSlipCorpus(t *testing.T) {
	var corpus slipCorpus
	loadJSON(t, repoFile("tests", "corpora", "tar-slip", "cases.json"), &corpus)
	if corpus.Version != 1 || len(corpus.Cases) == 0 {
		t.Fatalf("unexpected corpus version %d with %d cases", corpus.Version, len(corpus.Cases))
	}
	seen := map[string]bool{}
	for _, c := range corpus.Cases {
		if seen[c.ID] {
			t.Fatalf("duplicate case id %q", c.ID)
		}
		seen[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			t.Parallel()
			base := t.TempDir()
			wsDir := filepath.Join(base, "workspace")
			if err := os.Mkdir(wsDir, 0o755); err != nil {
				t.Fatal(err)
			}
			setupWorkspace(t, wsDir, c.Workspace)
			ws := openTestWorkspace(t, wsDir, c.Limits.apply(DefaultLimits()))
			res, err := ws.Extract(bg, "s1", archiveInput(t, c))
			staging := filepath.Join(wsDir, StagingDir, "s1")
			if !c.Expect.OK {
				werr := codeOf(t, err, c.Expect.Code)
				if c.Expect.Path != nil && werr.Path != *c.Expect.Path {
					t.Fatalf("error path %q, want %q (%v)", werr.Path, *c.Expect.Path, werr)
				}
				mustNotExist(t, staging)
				return
			}
			if err != nil {
				t.Fatalf("Extract: %v", err)
			}
			if res.Staging != "s1" || res.Manifest.Name != "slip" || res.Summary.PackSHA256 == "" {
				t.Fatalf("unexpected result %+v", res)
			}
			got := listTestTree(t, filepath.Join(staging, "tree"))
			if !slices.Equal(got, c.Expect.Tree) {
				t.Fatalf("staging tree\n got %+v\nwant %+v", got, c.Expect.Tree)
			}
			// Nothing but the staging tree was created.
			if info, err := os.Lstat(filepath.Join(wsDir, StagingDir)); err != nil || !info.IsDir() {
				t.Fatalf("the staging area is not a real directory: %v", err)
			}
		})
	}
}

type pathsCorpus struct {
	Version     int             `json:"version"`
	Description string          `json:"description"`
	Paths       []pathCase      `json:"paths"`
	Workspace   []workspaceCase `json:"workspace"`
}

type pathCase struct {
	Path       *string `json:"path"`
	PathBase64 string  `json:"pathBase64"`
	Valid      bool    `json:"valid"`
	Reason     string  `json:"reason"`
}

type workspaceCase struct {
	ID     string       `json:"id"`
	Setup  []setupEntry `json:"setup"`
	Op     string       `json:"op"`
	Path   string       `json:"path"`
	Expect struct {
		Code      Code        `json:"code"`
		Entries   []listEntry `json:"entries"`
		Deleted   []string    `json:"deleted"`
		Remaining []string    `json:"remaining"`
	} `json:"expect"`
}

type listEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

func TestPathsCorpus(t *testing.T) {
	var corpus pathsCorpus
	loadJSON(t, repoFile("tests", "corpora", "paths", "cases.json"), &corpus)
	if corpus.Version != 1 {
		t.Fatalf("unexpected corpus version %d", corpus.Version)
	}
	for i, c := range corpus.Paths {
		p := ""
		switch {
		case c.Path != nil:
			p = *c.Path
		case c.PathBase64 != "":
			raw, err := base64.StdEncoding.DecodeString(c.PathBase64)
			if err != nil {
				t.Fatal(err)
			}
			p = string(raw)
		}
		err := ValidatePath(p)
		if c.Valid && err != nil {
			t.Errorf("case %d %q: %v", i, printable(p), err)
		}
		if !c.Valid {
			if err == nil {
				t.Errorf("case %d %q (%s): valid, want invalidPath", i, printable(p), c.Reason)
				continue
			}
			if werr := AsError(err); werr.Code != CodeInvalidPath || werr.Path != p {
				t.Errorf("case %d: got %s path %q", i, werr.Code, werr.Path)
			}
		}
	}

	for _, c := range corpus.Workspace {
		t.Run(c.ID, func(t *testing.T) {
			ws := newTestWorkspace(t, DefaultLimits())
			task := filepath.Join(ws.dir, "echo")
			writeTree(t, task, map[string]node{"scantor.yaml": file(testManifest)})
			setupWorkspace(t, task, c.Setup)
			// The target as the OS resolves it (following symlinks) must be unchanged by a refused operation.
			target := filepath.Join(task, filepath.FromSlash(c.Path))
			before := statFollow(target)
			var err error
			var res any
			switch c.Op {
			case "list":
				res, err = ws.List(bg, "echo", ListOptions{Path: c.Path, Recursive: true})
			case "read":
				res, err = ws.Read(bg, "echo", c.Path, 0)
			case "write":
				res, err = ws.WriteFiles(bg, "echo", false, writeRequest(t, map[string]any{c.Path: "evil"}))
			case "delete":
				res, err = ws.DeleteFiles(bg, "echo", c.Path, false)
			default:
				t.Fatalf("unknown op %q", c.Op)
			}
			if c.Expect.Code != "" {
				wantCode(t, err, c.Expect.Code)
			} else if err != nil {
				t.Fatalf("%s: %v", c.Op, err)
			}
			switch {
			case c.Expect.Entries != nil:
				var got []listEntry
				for _, e := range res.(*ListResult).Entries {
					if e.Path != "scantor.yaml" {
						got = append(got, listEntry{e.Path, e.Type})
					}
				}
				if !slices.Equal(got, c.Expect.Entries) {
					t.Fatalf("entries %+v, want %+v", got, c.Expect.Entries)
				}
			case c.Expect.Deleted != nil:
				if got := res.(*DeleteResult).Deleted; !slices.Equal(got, c.Expect.Deleted) {
					t.Fatalf("deleted %v, want %v", got, c.Expect.Deleted)
				}
				var remaining []string
				for _, e := range listTestTree(t, task) {
					if e.Path != "scantor.yaml" {
						remaining = append(remaining, e.Path)
					}
				}
				if !slices.Equal(remaining, c.Expect.Remaining) {
					t.Fatalf("remaining %v, want %v", remaining, c.Expect.Remaining)
				}
			}
			if c.Expect.Code != "" {
				if after := statFollow(target); after != before {
					t.Fatalf("the refused operation changed %s: %q → %q", target, before, after)
				}
			}
		})
	}
}

// statFollow describes the file at p as the OS resolves it: absent, a directory, or a file's content.
func statFollow(p string) string {
	info, err := os.Stat(p)
	switch {
	case err != nil:
		return "absent"
	case info.IsDir():
		return "dir"
	case info.Size() > 1<<20:
		return fmt.Sprintf("file of %d bytes", info.Size())
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "unreadable"
	}
	return "file " + string(data)
}
