package taskpipe

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/manifest"
)

// File names with a fixed meaning at the task root.
const (
	DockerfileName   = "Dockerfile"
	DockerignoreName = ".dockerignore"
)

// Path limits of pack entries (docs/tasks.md §2, §9.10).
const (
	MaxPathBytes    = 1024
	MaxSegmentBytes = 255
)

// forcedIncludes are part of every pack even when .dockerignore matches them.
var forcedIncludes = map[string]bool{manifest.FileName: true, DockerfileName: true, DockerignoreName: true}

// hardExcluded reports whether a path is never part of a task: any path segment named .git or
// .scantor (git metadata and the CLI's scratch directory).
func hardExcluded(p string) bool {
	for seg := range strings.SplitSeq(p, "/") {
		if seg == ".git" || seg == ".scantor" {
			return true
		}
	}
	return false
}

// EntryKind is the type of a pack entry.
type EntryKind uint8

// Entry kinds; nothing else can be part of a pack.
const (
	KindDir EntryKind = iota + 1
	KindFile
	KindSymlink
)

// Normalised entry modes.
const (
	modeDir     = 0o755
	modeExec    = 0o755
	modeFile    = 0o644
	modeSymlink = 0o777
)

func fileMode(perm os.FileMode) int64 {
	if perm&0o111 != 0 {
		return modeExec
	}
	return modeFile
}

// Entry is one entry of a pack: a '/'-separated path relative to the task root, without a trailing
// slash.
type Entry struct {
	Path string
	Kind EntryKind
	Mode int64
	// Size is the content size of a regular file.
	Size int64
	// Link is the target of a symlink.
	Link string
	// offset is the position of a file's content in the spooled tar.
	offset int64
}

// PackLimits are the caps of a pack, counted while streaming (docs/tasks.md §9.2), and the directory
// its spool files go to.
type PackLimits struct {
	// MaxFiles is SCANTOR_TASK_MAX_FILES, counted over all entries.
	MaxFiles int
	// MaxBytes is SCANTOR_TASK_MAX_BYTES, the uncompressed tar size.
	MaxBytes int64
	// MaxPackBytes is SCANTOR_TASK_MAX_PACK_BYTES, the compressed size.
	MaxPackBytes int64
	// TempDir holds the spool files: the uncompressed tar (up to MaxBytes) and, for ReadPack, the
	// input's file contents. "" is os.TempDir(). Workspace helpers point it at their volume, because
	// their /tmp is a small tmpfs.
	TempDir string
}

// Summary describes a pack (docs/tasks.md §9.2): the SHA-256 of the uncompressed tar, the size of the
// tar.gz, the number of regular files and the uncompressed tar size.
type Summary struct {
	PackSHA256 string `json:"packSha256"`
	PackBytes  int64  `json:"packBytes"`
	FileCount  int    `json:"fileCount"`
	Bytes      int64  `json:"bytes"`
}

// Caps of a pack, named by their environment variables (PackError.Cap).
const (
	CapFiles     = "SCANTOR_TASK_MAX_FILES"
	CapBytes     = "SCANTOR_TASK_MAX_BYTES"
	CapPackBytes = "SCANTOR_TASK_MAX_PACK_BYTES"
)

// PackError is a problem of the task content found while packing: a path rule, an entry type, a cap
// or an unreadable archive. Path is the offending path relative to the task root ("" for caps); Cap
// names the exceeded cap (CapFiles, CapBytes or CapPackBytes), "" for other problems.
type PackError struct {
	Path    string
	Message string
	Cap     string
}

func (e *PackError) Error() string {
	if e.Path == "" {
		return e.Message
	}
	return e.Path + ": " + e.Message
}

// PackErrors collects the content problems of one pack attempt.
type PackErrors []*PackError

func (e PackErrors) Error() string {
	msgs := make([]string, len(e))
	for i, pe := range e {
		msgs[i] = pe.Error()
	}
	return strings.Join(msgs, "; ")
}

// maxPackErrors bounds the reported entry problems of one pack.
const maxPackErrors = 100

func (e *PackErrors) add(path, format string, args ...any) {
	if len(*e) < maxPackErrors {
		*e = append(*e, &PackError{Path: path, Message: fmt.Sprintf(format, args...)})
	}
}

func capError(name string, limit int64) *PackError {
	return &PackError{Cap: name, Message: fmt.Sprintf("the task exceeds %s (%s)", name, envconf.FormatByteSize(limit))}
}

func filesCapError(limit int) *PackError {
	return &PackError{Cap: CapFiles, Message: fmt.Sprintf("the task has more than %d files and directories (%s)", limit, CapFiles)}
}

// checkPath validates a '/'-separated relative path against the rules of docs/tasks.md §2 and returns a
// message, or "" when the path is valid.
func checkPath(p string) string {
	switch {
	case !validUTF8(p):
		return "the path is not valid UTF-8"
	case strings.ContainsRune(p, 0):
		return "the path contains a NUL byte"
	case strings.ContainsRune(p, '\\'):
		return "the path contains a backslash"
	case strings.HasPrefix(p, "/"):
		return "the path is absolute"
	case len(p) > MaxPathBytes:
		return fmt.Sprintf("the path is longer than %d bytes", MaxPathBytes)
	}
	for seg := range strings.SplitSeq(p, "/") {
		switch {
		case seg == "" || seg == ".":
			return "the path has an empty or '.' segment"
		case seg == "..":
			return "the path has a '..' segment"
		case len(seg) > MaxSegmentBytes:
			return fmt.Sprintf("a path segment is longer than %d bytes", MaxSegmentBytes)
		}
	}
	return ""
}

// checkLink validates the target of the symlink at p: relative, and resolving inside the task root.
func checkLink(p, target string) string {
	switch {
	case target == "":
		return "the symlink has an empty target"
	case !validUTF8(target) || strings.ContainsRune(target, 0) || strings.ContainsRune(target, '\\'):
		return "the symlink target is not a valid path"
	case len(target) > MaxPathBytes:
		return fmt.Sprintf("the symlink target is longer than %d bytes", MaxPathBytes)
	case strings.HasPrefix(target, "/"):
		return fmt.Sprintf("the symlink points to the absolute path %q; only relative symlinks inside the task folder are allowed", target)
	}
	resolved := cleanJoin(parentDir(p), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Sprintf("the symlink target %q points outside the task folder", target)
	}
	return ""
}

// Pack is a packed task: the canonical uncompressed tar spooled to a temporary file, its summary and
// an index of its entries. Close removes the temporary file.
type Pack struct {
	Summary Summary
	spool   *os.File
	size    int64
	entries []Entry
	index   map[string]int
}

// Entries returns the entries in pack order.
func (p *Pack) Entries() []Entry { return slices.Clone(p.entries) }

// Lookup returns the entry at path.
func (p *Pack) Lookup(path string) (Entry, bool) {
	i, ok := p.index[path]
	if !ok {
		return Entry{}, false
	}
	return p.entries[i], true
}

// IsRegularFile reports whether path is a regular file of the pack.
func (p *Pack) IsRegularFile(path string) bool {
	e, ok := p.Lookup(path)
	return ok && e.Kind == KindFile
}

// ErrNotRegular is returned by ReadFile for a missing path or one that is not a regular file.
var ErrNotRegular = errors.New("not a regular file of the task")

// FileTooLargeError is returned by ReadFile when a file exceeds the caller's limit.
type FileTooLargeError struct {
	Size, Limit int64
}

func (e *FileTooLargeError) Error() string {
	return fmt.Sprintf("the file is %d bytes; the limit is %d", e.Size, e.Limit)
}

// ReadFile returns the content of the regular file at path, refusing files larger than limit.
func (p *Pack) ReadFile(path string, limit int64) ([]byte, error) {
	e, ok := p.Lookup(path)
	if !ok || e.Kind != KindFile {
		return nil, ErrNotRegular
	}
	if e.Size > limit {
		return nil, &FileTooLargeError{Size: e.Size, Limit: limit}
	}
	buf := make([]byte, e.Size)
	if _, err := p.spool.ReadAt(buf, e.offset); err != nil {
		return nil, fmt.Errorf("read %s from the pack: %w", path, err)
	}
	return buf, nil
}

// Tar returns a reader of the canonical uncompressed tar (the build context).
func (p *Pack) Tar() *io.SectionReader { return io.NewSectionReader(p.spool, 0, p.size) }

// WriteGzip writes the deterministic tar.gz of the pack (gzip header mtime 0, no name, OS 255), whose
// size is Summary.PackBytes.
func (p *Pack) WriteGzip(w io.Writer) error {
	gz, err := newGzip(w)
	if err != nil {
		return err
	}
	if _, err := io.Copy(gz, p.Tar()); err != nil {
		return fmt.Errorf("compress pack: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("compress pack: %w", err)
	}
	return nil
}

// Close removes the spooled tar.
func (p *Pack) Close() error {
	if p == nil || p.spool == nil {
		return nil
	}
	name := p.spool.Name()
	closeErr := p.spool.Close()
	p.spool = nil
	if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove pack spool: %w", err)
	}
	return closeErr
}

// newGzip returns the deterministic gzip writer of packs. Go's writer leaves the name empty, the
// header mtime 0 and the OS byte at 255 unless told otherwise.
func newGzip(w io.Writer) (*gzip.Writer, error) {
	gz, err := gzip.NewWriterLevel(w, gzip.DefaultCompression)
	if err != nil {
		return nil, fmt.Errorf("gzip: %w", err)
	}
	gz.OS = 255
	return gz, nil
}

// source is an entry to write together with a function that opens a file's content and returns its
// actual size.
type source struct {
	Entry
	open func() (io.ReadCloser, int64, error)
}

// capWriter counts bytes and fails once max (when > 0) would be exceeded.
type capWriter struct {
	w   io.Writer
	n   int64
	max int64
	err error
}

func (c *capWriter) Write(b []byte) (int, error) {
	if c.max > 0 && c.n+int64(len(b)) > c.max {
		return 0, c.err
	}
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

var epoch = time.Unix(0, 0)

// writePack writes the canonical tar of sources (already sorted) into a new spool and returns the
// pack. Entries are written in order, owned by 0:0 with empty user and group names and mtime 0, and in
// USTAR format unless a name needs PAX.
func writePack(ctx context.Context, sources []source, limits PackLimits) (pack *Pack, err error) {
	spool, err := os.CreateTemp(limits.TempDir, "scantor-pack-*.tar")
	if err != nil {
		return nil, fmt.Errorf("create pack spool: %w", err)
	}
	pack = &Pack{spool: spool, index: make(map[string]int, len(sources))}
	defer func() {
		if err != nil {
			_ = pack.Close()
			pack = nil
		}
	}()

	hasher := sha256.New()
	gzCount := &capWriter{w: io.Discard, max: limits.MaxPackBytes, err: capError(CapPackBytes, limits.MaxPackBytes)}
	gz, err := newGzip(gzCount)
	if err != nil {
		return nil, err
	}
	tarOut := &capWriter{w: io.MultiWriter(spool, hasher, gz), max: limits.MaxBytes, err: capError(CapBytes, limits.MaxBytes)}
	tw := tar.NewWriter(tarOut)

	files := 0
	for _, s := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		e := s.Entry
		hdr := &tar.Header{Name: e.Path, Mode: e.Mode, ModTime: epoch}
		switch e.Kind {
		case KindDir:
			hdr.Typeflag, hdr.Name = tar.TypeDir, e.Path+"/"
		case KindSymlink:
			hdr.Typeflag, hdr.Linkname = tar.TypeSymlink, e.Link
		case KindFile:
			hdr.Typeflag = tar.TypeReg
			if e.offset, err = writeFile(tw, tarOut, hdr, s); err != nil {
				return nil, packWriteError(err)
			}
			files++
			pack.add(e)
			continue
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, packWriteError(err)
		}
		pack.add(e)
	}
	if err := tw.Close(); err != nil {
		return nil, packWriteError(err)
	}
	if err := gz.Close(); err != nil {
		return nil, packWriteError(err)
	}
	pack.size = tarOut.n
	pack.Summary = Summary{
		PackSHA256: hex.EncodeToString(hasher.Sum(nil)),
		PackBytes:  gzCount.n,
		FileCount:  files,
		Bytes:      tarOut.n,
	}
	return pack, nil
}

// writeFile writes the header and content of a regular file and returns the offset of the content in
// the tar. A file that changes size while it is packed is an error.
func writeFile(tw *tar.Writer, tarOut *capWriter, hdr *tar.Header, s source) (int64, error) {
	rc, size, err := s.open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()
	if size != s.Size {
		return 0, &PackError{Path: s.Path, Message: "the file changed while it was packed"}
	}
	hdr.Size = size
	if err := tw.WriteHeader(hdr); err != nil {
		return 0, err
	}
	offset := tarOut.n
	n, err := io.CopyN(tw, rc, size)
	if err != nil {
		if n < size && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)) {
			return 0, &PackError{Path: s.Path, Message: "the file changed while it was packed"}
		}
		return 0, err
	}
	return offset, nil
}

// packWriteError keeps content problems (caps, changed files) as PackErrors and wraps the rest.
func packWriteError(err error) error {
	var pe *PackError
	if errors.As(err, &pe) {
		return PackErrors{pe}
	}
	return fmt.Errorf("write pack: %w", err)
}

func (p *Pack) add(e Entry) {
	p.index[e.Path] = len(p.entries)
	p.entries = append(p.entries, e)
}

// sortSources orders sources bytewise by path. A directory's path is a prefix of its contents' paths,
// so every directory comes before its contents.
func sortSources(sources []source) {
	slices.SortFunc(sources, func(a, b source) int { return strings.Compare(a.Path, b.Path) })
}

// parentDir returns the parent of a '/'-separated relative path ("." for top-level paths).
func parentDir(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return "."
}

// ancestors returns the parent directories of p from the top down.
func ancestors(p string) []string {
	var out []string
	for i := 0; i < len(p); i++ {
		if p[i] == '/' {
			out = append(out, p[:i])
		}
	}
	return out
}
