package workspace

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"slices"
	"strings"
	"unicode/utf8"
)

// Defaults of the browsing operations (docs/editor.md §9.4).
const (
	DefaultMaxEntries   = 5000
	DefaultMaxReadBytes = 1 << 20
)

// Entry types of list.
const (
	TypeFile    = "file"
	TypeDir     = "dir"
	TypeSymlink = "symlink"
)

// FileEntry is one entry of list: lstat information only, symlinks are never followed.
type FileEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	Mode int    `json:"mode"`
}

// ListResult is the output of list.
type ListResult struct {
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

// ListOptions select what list returns. Path "" is the task root; with Recursive false only the direct
// children of Path are listed.
type ListOptions struct {
	Path       string
	Recursive  bool
	MaxEntries int
}

// ReadResult is the output of read. SHA256 covers the whole file; Content is cut at the read limit.
type ReadResult struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	Encoding  string `json:"encoding"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

// Content encodings of read.
const (
	EncodingUTF8   = "utf8"
	EncodingBase64 = "base64"
)

// List lists the task folder task (docs/editor.md §9.4 list). Entries are sorted by path and lstat-only.
func (w *Workspace) List(ctx context.Context, task string, opts ListOptions) (*ListResult, error) {
	if err := optionalPath(opts.Path); err != nil {
		return nil, err
	}
	root, err := w.openTask(task)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if opts.Path != "" {
		if err := noSymlinkParents(root, opts.Path); err != nil {
			return nil, err
		}
	}
	start := "."
	if opts.Path != "" {
		start = opts.Path
		info, err := root.Lstat(opts.Path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil, notFound(opts.Path, "%q does not exist", printable(opts.Path))
		case err != nil:
			return nil, internalError(err, "stat %s", opts.Path)
		case !info.IsDir():
			entry, ok := fileEntry(opts.Path, info)
			if !ok {
				return nil, pathError(opts.Path, "%q is not a file, directory or symlink", printable(opts.Path))
			}
			return &ListResult{Entries: []FileEntry{entry}}, nil
		}
	}
	var entries []FileEntry
	err = fs.WalkDir(root.FS(), start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "walk %s", p)
		}
		if p == start {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return internalError(err, "stat %s", p)
		}
		if entry, ok := fileEntry(p, info); ok {
			entries = append(entries, entry)
		}
		if d.IsDir() && !opts.Recursive {
			return fs.SkipDir
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return finishList(entries, opts.MaxEntries), nil
}

func fileEntry(p string, info fs.FileInfo) (FileEntry, bool) {
	e := FileEntry{Path: p, Mode: int(info.Mode().Perm())}
	switch m := info.Mode(); {
	case m.IsRegular():
		e.Type, e.Size = TypeFile, info.Size()
	case m.IsDir():
		e.Type = TypeDir
	case m&fs.ModeSymlink != 0:
		e.Type, e.Size = TypeSymlink, info.Size()
	default:
		return FileEntry{}, false
	}
	return e, true
}

func finishList(entries []FileEntry, maxEntries int) *ListResult {
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	slices.SortFunc(entries, func(a, b FileEntry) int { return strings.Compare(a.Path, b.Path) })
	res := &ListResult{Entries: entries}
	if len(entries) > maxEntries {
		res.Entries, res.Truncated = entries[:maxEntries], true
	}
	if res.Entries == nil {
		res.Entries = []FileEntry{}
	}
	return res
}

// Read returns a regular file of the task folder (docs/editor.md §9.4 read). A symlink anywhere in the
// path or a directory is invalidPath.
func (w *Workspace) Read(ctx context.Context, task, p string, maxBytes int64) (*ReadResult, error) {
	if err := ValidatePath(p); err != nil {
		return nil, err
	}
	root, err := w.openTask(task)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := noSymlinkComponents(root, p); err != nil {
		return nil, err
	}
	info, err := root.Lstat(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, notFound(p, "%q does not exist", printable(p))
	case err != nil:
		return nil, internalError(err, "stat %s", p)
	case info.IsDir():
		return nil, pathError(p, "%q is a directory", printable(p))
	case !info.Mode().IsRegular():
		return nil, pathError(p, "%q is not a regular file", printable(p))
	}
	f, err := root.OpenFile(p, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return nil, internalError(err, "open %s", p)
	}
	defer f.Close()
	if info, err = f.Stat(); err != nil {
		return nil, internalError(err, "stat %s", p)
	}
	if !info.Mode().IsRegular() {
		return nil, pathError(p, "%q is not a regular file", printable(p))
	}
	return readContent(ctx, p, f, maxBytes)
}

// readContent hashes the whole stream and keeps its first maxBytes bytes as the content: UTF-8 text when
// the whole stream is valid UTF-8 without NUL, else base64.
func readContent(ctx context.Context, p string, r io.Reader, maxBytes int64) (*ReadResult, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxReadBytes
	}
	hash := sha256.New()
	text := &textDetector{}
	var head []byte
	buf := make([]byte, 64<<10)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, err := r.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			hash.Write(chunk)
			text.Write(chunk)
			if room := maxBytes - int64(len(head)); room > 0 {
				head = append(head, chunk[:min(int64(n), room)]...)
			}
			size += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, internalError(err, "read %s", p)
		}
	}
	res := &ReadResult{Path: p, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil)), Truncated: size > int64(len(head))}
	if text.IsText() {
		if res.Truncated {
			head = trimPartialRune(head)
		}
		res.Encoding, res.Content = EncodingUTF8, string(head)
	} else {
		res.Encoding, res.Content = EncodingBase64, base64.StdEncoding.EncodeToString(head)
	}
	return res, nil
}

// textDetector checks a byte stream for valid UTF-8 without NUL bytes, across chunk boundaries.
type textDetector struct {
	carry  []byte
	binary bool
}

func (t *textDetector) Write(p []byte) {
	if t.binary {
		return
	}
	data := append(t.carry, p...)
	// Keep an incomplete rune at the end for the next chunk.
	end := len(data)
	for i := 1; i <= utf8.UTFMax-1 && i <= len(data); i++ {
		b := data[len(data)-i]
		if utf8.RuneStart(b) {
			if !utf8.FullRune(data[len(data)-i:]) {
				end = len(data) - i
			}
			break
		}
	}
	complete := data[:end]
	if !utf8.Valid(complete) || slices.Contains(complete, 0) {
		t.binary = true
		return
	}
	t.carry = slices.Clone(data[end:])
}

// IsText reports whether everything written was valid UTF-8 without NUL.
func (t *textDetector) IsText() bool { return !t.binary && len(t.carry) == 0 }

// trimPartialRune drops an incomplete UTF-8 sequence at the end of b (content cut at the read limit).
func trimPartialRune(b []byte) []byte {
	for i := 1; i <= utf8.UTFMax-1 && i <= len(b); i++ {
		if utf8.RuneStart(b[len(b)-i]) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			break
		}
	}
	return b
}

// ListArchive lists a revision snapshot (a pack streamed on stdin; docs/editor.md §9.4 list --archive).
func ListArchive(ctx context.Context, r io.Reader, opts ListOptions) (*ListResult, error) {
	if err := optionalPath(opts.Path); err != nil {
		return nil, err
	}
	var entries []FileEntry
	var self *FileEntry
	err := walkPack(ctx, r, func(name string, hdr *tar.Header, _ io.Reader) (bool, error) {
		entry, ok := tarEntry(name, hdr)
		if !ok {
			return false, nil
		}
		switch {
		case opts.Path != "" && name == opts.Path:
			self = &entry
		case opts.Path == "" || strings.HasPrefix(name, opts.Path+"/"):
			rel := strings.TrimPrefix(strings.TrimPrefix(name, opts.Path), "/")
			if opts.Recursive || !strings.Contains(rel, "/") {
				entries = append(entries, entry)
			}
		}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	if opts.Path != "" && self == nil && len(entries) == 0 {
		return nil, notFound(opts.Path, "%q does not exist in the snapshot", printable(opts.Path))
	}
	if self != nil && self.Type != TypeDir {
		return &ListResult{Entries: []FileEntry{*self}}, nil
	}
	return finishList(entries, opts.MaxEntries), nil
}

// ReadArchive returns a regular file of a revision snapshot (read --archive).
func ReadArchive(ctx context.Context, r io.Reader, p string, maxBytes int64) (*ReadResult, error) {
	if err := ValidatePath(p); err != nil {
		return nil, err
	}
	var res *ReadResult
	err := walkPack(ctx, r, func(name string, hdr *tar.Header, content io.Reader) (bool, error) {
		if name != p {
			return false, nil
		}
		switch hdr.Typeflag {
		case tar.TypeReg:
			rr, err := readContent(ctx, p, content, maxBytes)
			res = rr
			return true, err
		case tar.TypeDir:
			return true, pathError(p, "%q is a directory", printable(p))
		default:
			return true, pathError(p, "%q is not a regular file", printable(p))
		}
	})
	if err != nil {
		return nil, err
	}
	if res == nil {
		return nil, notFound(p, "%q does not exist in the snapshot", printable(p))
	}
	return res, nil
}

func tarEntry(name string, hdr *tar.Header) (FileEntry, bool) {
	e := FileEntry{Path: name, Mode: int(hdr.Mode & 0o777)}
	switch hdr.Typeflag {
	case tar.TypeReg:
		e.Type, e.Size = TypeFile, hdr.Size
	case tar.TypeDir:
		e.Type = TypeDir
	case tar.TypeSymlink:
		e.Type, e.Size = TypeSymlink, int64(len(hdr.Linkname))
	default:
		return FileEntry{}, false
	}
	return e, true
}

// walkPack reads a tar.gz pack and calls fn for every entry with its normalised name until fn returns
// stop. The rest of the input is drained, so the writer of stdin never sees a broken pipe.
func walkPack(ctx context.Context, r io.Reader, fn func(name string, hdr *tar.Header, content io.Reader) (stop bool, err error)) error {
	defer drain(r)
	gz, err := gzip.NewReader(r)
	if err != nil {
		return invalidArgument("the snapshot is not a gzip stream: %v", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil && !errors.Is(err, tar.ErrInsecurePath) {
			return invalidArgument("the snapshot is not a valid tar.gz: %v", err)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name, isRoot := archiveName(hdr.Name)
		if isRoot {
			continue
		}
		if err := ValidatePath(name); err != nil {
			return err
		}
		stop, err := fn(name, hdr, tr)
		if err != nil || stop {
			return err
		}
	}
}

func drain(r io.Reader) {
	// Errors are irrelevant here: the operation's own result is already decided.
	_, _ = io.Copy(io.Discard, r)
}
