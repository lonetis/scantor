package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
)

// ExtractResult is the output of extract: the staging id, the normalised manifest and the summary of
// the extracted tree.
type ExtractResult struct {
	Staging  string            `json:"staging"`
	Manifest manifest.Manifest `json:"manifest"`
	Summary  Summary           `json:"summary"`
}

// Extract extracts an uploaded archive (a tar.gz, or a zip) from r into staging/<id>/tree with the
// archive rules of docs/editor.md §9.5 and validates its scantor.yaml (docs/editor.md §9.4 extract).
// When the manifest is not at the root but every entry is below one directory that contains it (GitHub
// tarball style), that directory becomes the root. On any failure the staging directory is removed.
func (w *Workspace) Extract(ctx context.Context, id string, r io.Reader) (res *ExtractResult, err error) {
	if err := w.createStaging(id); err != nil {
		return nil, err
	}
	defer w.discardOnError(id, &err)
	wsBytes, err := w.workspaceBytes(ctx)
	if err != nil {
		return nil, err
	}
	tree, _, err := w.openStagingTree(id, "")
	if err != nil {
		return nil, err
	}
	x := &extractor{root: tree, limits: w.limits, wsBytes: wsBytes, seen: map[string]seenKind{}}
	err = closeRoot(tree, x.extract(ctx, r))
	if err != nil {
		return nil, err
	}
	if err := w.stripTopLevel(id); err != nil {
		return nil, err
	}
	tree, _, err = w.openStagingTree(id, "")
	if err != nil {
		return nil, err
	}
	defer tree.Close()
	m, err := checkTreeManifest(tree, "")
	if err != nil {
		return nil, err
	}
	summary, err := w.summarizeDir(ctx, w.abs(stagingPath(id, "tree")))
	if err != nil {
		return nil, err
	}
	w.events.Infof("extracted %d files and directories (%d bytes) into staging %s", x.usage.Entries, x.usage.Bytes, id)
	return &ExtractResult{Staging: id, Manifest: *m, Summary: summary}, nil
}

type seenKind int

const (
	seenFile seenKind = iota + 1
	seenDir
	seenImplicitDir
)

// extractor applies the archive rules while streaming: entry types, paths, duplicates, normalised
// modes and the caps on entries, uncompressed bytes and the workspace size.
type extractor struct {
	root    *os.Root
	limits  Limits
	wsBytes int64
	usage   treeUsage
	seen    map[string]seenKind
}

func (x *extractor) extract(ctx context.Context, r io.Reader) error {
	ar, err := openArchive(r, x.limits.MaxPackBytes)
	if err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		e, err := ar.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return archiveError(err, x.limits.MaxPackBytes)
		}
		if err := x.entry(e); err != nil {
			return err
		}
	}
}

func (x *extractor) entry(e *archiveEntry) error {
	name, isRoot := archiveName(e.name)
	if isRoot {
		if e.kind != archiveDir {
			return pathError(e.name, "invalid archive entry %q", printable(e.name))
		}
		return nil
	}
	if err := ValidatePath(name); err != nil {
		return err
	}
	if e.kind != archiveFile && e.kind != archiveDir {
		return pathError(name, "%q is a %s; archives may contain only regular files and directories", printable(name), e.kind)
	}
	if isHardExcluded(name) {
		return nil
	}
	if err := x.checkParents(name); err != nil {
		return err
	}
	switch prev := x.seen[name]; {
	case prev == seenImplicitDir && e.kind == archiveDir:
		x.seen[name] = seenDir
		return nil
	case prev != 0:
		return pathError(name, "duplicate archive entry %q", printable(name))
	}
	if e.kind == archiveDir {
		return x.mkdir(name, seenDir)
	}
	return x.writeFile(name, e)
}

// checkParents creates the missing parents of name and fails when a parent is a file.
func (x *extractor) checkParents(name string) error {
	var missing []string
	for d := path.Dir(name); d != "."; d = path.Dir(d) {
		switch x.seen[d] {
		case seenFile:
			return pathError(name, "%q is below the file %q", printable(name), printable(d))
		case 0:
			missing = append(missing, d)
		}
	}
	for i := len(missing) - 1; i >= 0; i-- {
		if err := x.mkdir(missing[i], seenImplicitDir); err != nil {
			return err
		}
	}
	return nil
}

// countEntry counts one more entry against the entry cap.
func (x *extractor) countEntry() error {
	x.usage.add(0)
	if x.limits.MaxFiles > 0 && x.usage.Entries > x.limits.MaxFiles {
		return limitError(CodeTooManyFiles, int64(x.limits.MaxFiles), -1, "the archive has more than %d files and directories", x.limits.MaxFiles)
	}
	return nil
}

func (x *extractor) mkdir(name string, kind seenKind) error {
	if err := x.countEntry(); err != nil {
		return err
	}
	if err := x.root.Mkdir(name, dirMode); err != nil {
		return internalError(err, "create %s", name)
	}
	if err := x.root.Chmod(name, dirMode); err != nil {
		return internalError(err, "chmod %s", name)
	}
	x.seen[name] = kind
	return nil
}

func (x *extractor) writeFile(name string, e *archiveEntry) error {
	if err := x.countEntry(); err != nil {
		return err
	}
	if e.size >= 0 {
		if err := x.checkBytes(x.usage.Bytes + e.size); err != nil {
			return err
		}
	}
	mode := fileMode
	if e.mode&0o111 != 0 {
		mode = execMode
	}
	src, err := e.open()
	if err != nil {
		return archiveError(err, x.limits.MaxPackBytes)
	}
	defer src.Close()
	out, err := x.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, mode)
	if err != nil {
		return internalError(err, "create %s", name)
	}
	x.seen[name] = seenFile
	n, err := io.Copy(out, &capReader{r: src, x: x})
	x.usage.Bytes += n
	if err != nil {
		_ = out.Close() // the copy error is the one to report
		var werr *Error
		if errors.As(err, &werr) {
			return werr
		}
		return archiveError(err, x.limits.MaxPackBytes)
	}
	if err := out.Chmod(mode); err != nil {
		_ = out.Close() // the chmod error is the one to report
		return internalError(err, "chmod %s", name)
	}
	if err := out.Close(); err != nil {
		return internalError(err, "close %s", name)
	}
	return nil
}

// checkBytes applies the uncompressed and the workspace cap to a byte total.
func (x *extractor) checkBytes(total int64) error {
	if x.limits.MaxBytes > 0 && total > x.limits.MaxBytes {
		return limitError(CodeTooLarge, x.limits.MaxBytes, -1, "the archive is larger than %d bytes uncompressed", x.limits.MaxBytes)
	}
	if limit := x.limits.MaxWorkspaceBytes; limit > 0 && x.wsBytes+total > limit {
		return limitError(CodeWorkspaceFull, limit, -1, "the workspace would grow beyond %d bytes", limit)
	}
	return nil
}

// capReader counts the bytes actually read from an entry (headers can lie) and stops at the caps, so a
// decompression bomb never reaches the disk beyond them.
type capReader struct {
	r    io.Reader
	x    *extractor
	read int64
}

func (c *capReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += int64(n)
	if cerr := c.x.checkBytes(c.x.usage.Bytes + c.read); cerr != nil {
		return 0, cerr
	}
	return n, err
}

// stripTopLevel makes the single top-level directory the root when the manifest is not at the root but
// inside that directory.
func (w *Workspace) stripTopLevel(id string) error {
	tree := stagingPath(id, "tree")
	if _, err := w.root.Lstat(path.Join(tree, manifest.FileName)); err == nil {
		return nil
	}
	entries, err := fs.ReadDir(w.root.FS(), tree)
	if err != nil {
		return internalError(err, "read staging tree")
	}
	if len(entries) != 1 || !entries[0].IsDir() {
		return nil
	}
	top := path.Join(tree, entries[0].Name())
	if info, err := w.root.Lstat(path.Join(top, manifest.FileName)); err != nil || !info.Mode().IsRegular() {
		return nil
	}
	stripped := stagingPath(id, "stripped")
	if err := w.root.Rename(top, stripped); err != nil {
		return internalError(err, "strip the top-level directory")
	}
	if err := w.root.Remove(tree); err != nil {
		return internalError(err, "strip the top-level directory")
	}
	if err := w.root.Rename(stripped, tree); err != nil {
		return internalError(err, "strip the top-level directory")
	}
	w.events.Infof("stripped the top-level directory %q", entries[0].Name())
	return nil
}

// manifestLimits disables rule M8 for workspace checks: the instance limits are the orchestrator's,
// and the task pipeline applies them when the task is published.
var manifestLimits = manifest.Limits{MaxWorkersPerScan: math.MaxInt32, MaxProcessesPerWorker: math.MaxInt32}

// checkTreeManifest reads and validates scantor.yaml of the folder behind root: the strict schema and
// the semantic rules except the instance limits (M8), the privileged permission (M10) and the existence
// of the entry (M4), which the task pipeline checks when the task is published. expectName applies M9.
// Failures are manifestInvalid with details.errors (BuildError[]).
func checkTreeManifest(root *os.Root, expectName string) (*manifest.Manifest, error) {
	data, err := readManifest(root)
	if err != nil {
		return nil, err
	}
	res, issues := manifest.Check(data, manifest.Options{Limits: manifestLimits, AllowPrivileged: true, ExpectName: expectName})
	if len(issues) > 0 {
		errs := make([]api.BuildError, len(issues))
		msgs := make([]string, len(issues))
		for i, is := range issues {
			errs[i], msgs[i] = is.BuildError(), is.String()
		}
		return nil, manifestInvalid(errs, "the manifest is invalid: %s", strings.Join(msgs, "; "))
	}
	return &res.Manifest, nil
}

func readManifest(root *os.Root) ([]byte, error) {
	info, err := root.Lstat(manifest.FileName)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, manifestInvalid(nil, "%s is missing at the root of the task folder", manifest.FileName)
	case err != nil:
		return nil, internalError(err, "stat %s", manifest.FileName)
	case !info.Mode().IsRegular():
		return nil, manifestInvalid(nil, "%s must be a regular file", manifest.FileName)
	case info.Size() > manifest.MaxBytes:
		return nil, manifestInvalid(nil, "%s is %d bytes; the limit is %d", manifest.FileName, info.Size(), manifest.MaxBytes)
	}
	f, err := root.OpenFile(manifest.FileName, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return nil, internalError(err, "open %s", manifest.FileName)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, manifest.MaxBytes+1))
	if err != nil {
		return nil, internalError(err, "read %s", manifest.FileName)
	}
	return data, nil
}

// manifestInvalid builds the manifestInvalid error; without structured errors the message becomes the
// single error of scantor.yaml.
func manifestInvalid(errs []api.BuildError, format string, args ...any) *Error {
	msg := fmt.Sprintf(format, args...)
	if len(errs) == 0 {
		errs = []api.BuildError{{Phase: api.BuildPhaseStatic, File: manifest.FileName, Message: msg}}
	}
	return &Error{Code: CodeManifestInvalid, Message: msg, Details: map[string]any{"errors": errs}}
}
