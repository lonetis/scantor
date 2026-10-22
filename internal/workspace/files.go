package workspace

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path"
	"slices"
	"strings"
)

// MaxWriteFiles is the maximum number of files of one write-files request (the validated API body).
const MaxWriteFiles = 200

// writeInputOverhead is the JSON framing allowed on top of MaxBytes in a write-files request.
const writeInputOverhead = 1 << 20

// WriteResult is the output of write-files.
type WriteResult struct {
	Written   []string `json:"written"`
	Workspace Summary  `json:"workspace"`
}

// DeleteResult is the output of delete-files. Workspace is null when the whole task folder was removed
// (or, with a warning event, when the remaining folder cannot be packed).
type DeleteResult struct {
	Deleted   []string `json:"deleted"`
	Workspace *Summary `json:"workspace"`
}

// WriteFiles writes the files of a write-files request read from input:
// {"files": {"<path>": "<utf-8>" | {"base64": "…"}}} (docs/editor.md §9.4). Paths follow §9.5, parents are
// created (0755), and each file is written to a temporary file in its directory and renamed into place
// (0644). Caps and every path are checked before the first write. Without create the task folder must
// exist.
func (w *Workspace) WriteFiles(ctx context.Context, task string, create bool, input io.Reader) (*WriteResult, error) {
	files, err := readWriteRequest(input, w.limits.MaxBytes)
	if err != nil {
		return nil, err
	}
	paths := slices.Sorted(maps.Keys(files))
	for _, p := range paths {
		if err := ValidatePath(p); err != nil {
			return nil, err
		}
	}
	if err := checkPathConflicts(paths); err != nil {
		return nil, err
	}
	info, err := w.taskInfo(task)
	if err != nil {
		return nil, err
	}
	if info == nil && !create {
		return nil, notFound("", "the task folder %q does not exist", task)
	}
	if err := w.checkWriteCaps(ctx, task, info != nil, files); err != nil {
		return nil, err
	}
	if info == nil {
		if err := w.root.Mkdir(task, dirMode); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, internalError(err, "create task folder %s", task)
		}
	}
	root, err := w.openTask(task)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	for _, p := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := writeFileAtomic(root, p, files[p]); err != nil {
			return nil, err
		}
	}
	summary, err := w.taskSummary(ctx, task)
	if err != nil {
		werr := AsError(err)
		werr.Message = "the files were written, but " + werr.Message
		return nil, werr
	}
	return &WriteResult{Written: paths, Workspace: summary}, nil
}

// readWriteRequest decodes the write-files request. The input is capped at maxBytes plus the JSON
// framing (the decoded content can never be larger than its encoding).
func readWriteRequest(input io.Reader, maxBytes int64) (map[string][]byte, error) {
	limit := int64(64 << 20)
	if maxBytes > 0 {
		limit = maxBytes + writeInputOverhead
	}
	data, err := io.ReadAll(io.LimitReader(input, limit+1))
	if err != nil {
		return nil, internalError(err, "read the request")
	}
	if int64(len(data)) > limit {
		return nil, limitError(CodeTooLarge, limit, -1, "the request is larger than %d bytes", limit)
	}
	var req struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return nil, invalidArgument("invalid request: %v", err)
	}
	if req.Files == nil {
		return nil, invalidArgument(`invalid request: "files" is required`)
	}
	if len(req.Files) > MaxWriteFiles {
		return nil, invalidArgument("a request writes at most %d files, got %d", MaxWriteFiles, len(req.Files))
	}
	files := make(map[string][]byte, len(req.Files))
	for p, raw := range req.Files {
		content, err := decodeFileContent(raw)
		if err != nil {
			return nil, invalidArgument("invalid content of %q: %v", printable(p), err)
		}
		files[p] = content
	}
	return files, nil
}

// decodeFileContent accepts a UTF-8 string or {"base64": "…"}.
func decodeFileContent(raw json.RawMessage) ([]byte, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return []byte(text), nil
	}
	var obj struct {
		Base64 *string `json:"base64"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&obj); err != nil || obj.Base64 == nil {
		return nil, errors.New(`expected a string or {"base64": "…"}`)
	}
	data, err := base64.StdEncoding.DecodeString(*obj.Base64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64: %w", err)
	}
	return data, nil
}

// checkPathConflicts rejects a request that writes both a file and a path below it ("a" and "a/b").
func checkPathConflicts(sorted []string) error {
	set := make(map[string]bool, len(sorted))
	for _, p := range sorted {
		set[p] = true
	}
	for _, p := range sorted {
		for dir := path.Dir(p); dir != "."; dir = path.Dir(dir) {
			if set[dir] {
				return pathError(p, "%q is below %q, which the request writes as a file", printable(p), printable(dir))
			}
		}
	}
	return nil
}

// checkWriteCaps checks every target and the caps before anything is written: every existing component
// is a real directory, the task folder after the write stays within MaxFiles entries and MaxBytes (both
// as the pack counts them, so .git/ and .scantor/ do not count), and the workspace within
// MaxWorkspaceBytes.
func (w *Workspace) checkWriteCaps(ctx context.Context, task string, exists bool, files map[string][]byte) error {
	var taskUsage treeUsage
	var replaced, added int64
	newDirs := map[string]bool{}
	var root *os.Root
	if exists {
		var err error
		if root, err = w.openTask(task); err != nil {
			return err
		}
		defer root.Close()
		if taskUsage, err = measure(ctx, root, isHardExcluded); err != nil {
			return err
		}
	}
	for p, content := range files {
		size := int64(len(content))
		added += size
		var old fs.FileInfo
		if root != nil {
			var err error
			if old, err = existingTarget(root, p); err != nil {
				return err
			}
		}
		if old != nil {
			replaced += old.Size()
		}
		if isHardExcluded(p) {
			continue
		}
		if old != nil {
			taskUsage.Bytes += size - old.Size()
			continue
		}
		taskUsage.add(size)
		for dir := path.Dir(p); dir != "." && !newDirs[dir]; dir = path.Dir(dir) {
			if root != nil {
				if _, err := root.Lstat(dir); err == nil {
					break
				}
			}
			newDirs[dir] = true
			taskUsage.add(0)
		}
	}
	if err := checkTaskCaps(w.limits, taskUsage); err != nil {
		return err
	}
	wsBytes, err := w.workspaceBytes(ctx)
	if err != nil {
		return err
	}
	return w.checkWorkspaceCap(wsBytes - replaced + added)
}

// existingTarget checks the components of p in root: no symlinks, every parent a directory, and the
// target, when it exists, a regular file (returned) rather than a directory or a special file.
func existingTarget(root *os.Root, p string) (fs.FileInfo, error) {
	if err := noSymlinkComponents(root, p); err != nil {
		return nil, err
	}
	prefix := ""
	segments := strings.Split(p, "/")
	for i, seg := range segments {
		prefix = path.Join(prefix, seg)
		info, err := root.Lstat(prefix)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil, nil
		case err != nil:
			return nil, internalError(err, "stat %s", prefix)
		case i < len(segments)-1 && !info.IsDir():
			return nil, pathError(p, "%q is not a directory", printable(prefix))
		case i == len(segments)-1 && info.IsDir():
			return nil, pathError(p, "%q is a directory", printable(p))
		case i == len(segments)-1 && !info.Mode().IsRegular():
			return nil, pathError(p, "%q is not a regular file", printable(p))
		case i == len(segments)-1:
			return info, nil
		}
	}
	return nil, nil
}

// writeFileAtomic creates the parents of p (0755), writes content to a temporary file in the same
// directory and renames it over p (0644). It never writes through a symlink.
func writeFileAtomic(root *os.Root, p string, content []byte) error {
	if _, err := existingTarget(root, p); err != nil {
		return err
	}
	dir := path.Dir(p)
	if err := mkdirAllNoFollow(root, dir); err != nil {
		return err
	}
	tmp, f, err := createTemp(root, dir)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = root.Remove(tmp) // best effort: the temporary file is not part of the result
		}
	}()
	if _, err := f.Write(content); err != nil {
		_ = f.Close() // the write error is the one to report
		return internalError(err, "write %s", p)
	}
	if err := f.Chmod(fileMode); err != nil {
		_ = f.Close() // the chmod error is the one to report
		return internalError(err, "chmod %s", p)
	}
	if err := f.Close(); err != nil {
		return internalError(err, "close %s", p)
	}
	if err := root.Rename(tmp, p); err != nil {
		return internalError(err, "rename %s", p)
	}
	committed = true
	return nil
}

// mkdirAllNoFollow creates dir and its missing parents (0755) below root, failing with invalidPath at an
// existing component that is a symlink or not a directory.
func mkdirAllNoFollow(root *os.Root, dir string) error {
	if dir == "." || dir == "" {
		return nil
	}
	prefix := ""
	for seg := range strings.SplitSeq(dir, "/") {
		prefix = path.Join(prefix, seg)
		info, err := root.Lstat(prefix)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := root.Mkdir(prefix, dirMode); err != nil && !errors.Is(err, fs.ErrExist) {
				return internalError(err, "create %s", prefix)
			}
			if err := root.Chmod(prefix, dirMode); err != nil {
				return internalError(err, "chmod %s", prefix)
			}
		case err != nil:
			return internalError(err, "stat %s", prefix)
		case info.Mode()&fs.ModeSymlink != 0:
			return pathError(prefix, "%q is a symlink; operations never follow symlinks", printable(prefix))
		case !info.IsDir():
			return pathError(prefix, "%q is not a directory", printable(prefix))
		}
	}
	return nil
}

// createTemp creates a new temporary file in dir (O_EXCL, never following a symlink).
func createTemp(root *os.Root, dir string) (string, *os.File, error) {
	for range 10 {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", nil, internalError(err, "random name")
		}
		name := path.Join(dir, ".scantor-tmp-"+hex.EncodeToString(b[:]))
		f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, fileMode)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", nil, internalError(err, "create a temporary file in %s", dir)
		}
		return name, f, nil
	}
	return "", nil, newError(CodeInternal, "could not create a temporary file in %s", dir)
}

// maxDeletedReported bounds the paths delete-files reports. A deleted directory is always reported first,
// so paths below it that are not listed were deleted too.
const maxDeletedReported = DefaultMaxEntries

// DeleteFiles deletes p from the task folder (docs/editor.md §9.4 delete-files). A directory needs
// recursive unless it is empty; a symlink is removed itself, never followed, and no component of p may
// be a symlink. p == "" with recursive removes the whole task folder; deleting a task folder that does
// not exist succeeds with nothing deleted, so a retried task deletion is idempotent.
func (w *Workspace) DeleteFiles(ctx context.Context, task, p string, recursive bool) (*DeleteResult, error) {
	if p == "" {
		return w.deleteTask(ctx, task, recursive)
	}
	if err := ValidatePath(p); err != nil {
		return nil, err
	}
	root, err := w.openTask(task)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := noSymlinkParents(root, p); err != nil {
		return nil, err
	}
	info, err := root.Lstat(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, notFound(p, "%q does not exist", printable(p))
	case err != nil:
		return nil, internalError(err, "stat %s", p)
	}
	deleted := []string{p}
	if info.IsDir() {
		below, err := listTree(ctx, root, p, maxDeletedReported-1)
		if err != nil {
			return nil, err
		}
		if len(below) > 0 && !recursive {
			return nil, invalidArgument("%q is a non-empty directory; delete it recursively", printable(p))
		}
		deleted = append(deleted, below...)
		if err := root.RemoveAll(p); err != nil {
			return nil, internalError(err, "remove %s", p)
		}
	} else if err := root.Remove(p); err != nil {
		return nil, internalError(err, "remove %s", p)
	}
	res := &DeleteResult{Deleted: deleted}
	summary, err := w.taskSummary(ctx, task)
	if err != nil {
		var werr *Error
		if !errors.As(err, &werr) || werr.Code == CodeInternal {
			return nil, err
		}
		w.events.Warnf("the task folder cannot be packed after the deletion: %v", werr)
		return res, nil
	}
	res.Workspace = &summary
	return res, nil
}

// deleteTask removes the whole task folder (task deletion); workspace is null.
func (w *Workspace) deleteTask(ctx context.Context, task string, recursive bool) (*DeleteResult, error) {
	if !recursive {
		return nil, invalidArgument("deleting the whole task folder needs recursive")
	}
	root, err := w.openTask(task)
	if err != nil {
		if werr := AsError(err); werr.Code == CodeNotFound {
			w.events.Infof("the task folder %q does not exist", task)
			return &DeleteResult{Deleted: []string{}}, nil
		}
		return nil, err
	}
	deleted, err := listTree(ctx, root, ".", maxDeletedReported)
	closeErr := root.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, internalError(closeErr, "close task folder %s", task)
	}
	if err := w.root.RemoveAll(task); err != nil {
		return nil, internalError(err, "remove task folder %s", task)
	}
	return &DeleteResult{Deleted: deleted}, nil
}

// listTree returns up to limit paths below dir (exclusive) in walk order (lexical, every directory before
// its contents), lstat-only.
func listTree(ctx context.Context, root *os.Root, dir string, limit int) ([]string, error) {
	out := []string{}
	err := fs.WalkDir(root.FS(), dir, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "walk %s", p)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if p == dir {
			return nil
		}
		if len(out) >= limit {
			return fs.SkipAll
		}
		out = append(out, p)
		return nil
	})
	return out, err
}
