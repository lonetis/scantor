// Package workspace implements the workspace helper operations (`scantor workspace <op>`,
// docs/editor.md §9) and the scaffold renderer shared with `scantor init` (docs/tasks.md §12).
//
// A helper runs in a throwaway container that sees exactly one user's workspace (the volume subpath
// <userId> mounted at /workspace), or no volume at all for the --archive operations, and no network
// except for git. The orchestrator never touches workspace content itself; every file operation is one
// helper run. Inputs arrive on stdin, the result is one JSON document on stdout (the tar.gz pack for
// snapshot), and diagnostics are NDJSON events on stderr (Events).
//
// Layout of a workspace (docs/editor.md §9.6):
//
//	/workspace/<task>/                       one folder per task (the task name is a slug)
//	/workspace/.scantor-staging/<id>/tree/   output of extract, git-clone and git-pull
//	/workspace/.scantor-staging/<id>/old/    the previous task folder while commit swaps it
//	/workspace/.scantor-staging/.tmp-<id>/   scratch space of one pack (its spool)
//
// Every path is validated (ValidatePath), every existing path component is checked with lstat so writes
// never pass through a symlink, and task folders are accessed through os.Root, so nothing outside the
// folder is reachable even when the user planted symlinks in the editor (docs/security.md WS-3).
package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// StagingMaxAge is the age after which leftover staging directories are deleted by any helper run.
const StagingMaxAge = time.Hour

// Directory and file modes of task folders (docs/editor.md §9.5).
const (
	dirMode  fs.FileMode = 0o755
	fileMode fs.FileMode = 0o644
	execMode fs.FileMode = 0o755
	// privateDirMode protects the staging area and the per-user directories.
	privateDirMode fs.FileMode = 0o700
)

// Workspace is one user's workspace as a helper sees it (the directory mounted at /workspace).
type Workspace struct {
	dir    string
	root   *os.Root
	limits Limits
	events *Events
	now    func() time.Time
}

// Open opens the workspace directory dir. It first deletes staging directories older than
// StagingMaxAge, so staging left behind by crashed requests disappears on its own.
func Open(dir string, limits Limits, events *Events) (*Workspace, error) {
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, internalError(err, "the workspace %s does not exist", dir)
	case err != nil:
		return nil, internalError(err, "stat workspace %s", dir)
	case !info.IsDir():
		return nil, newError(CodeInternal, "the workspace %s is not a directory", dir)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, internalError(err, "open workspace %s", dir)
	}
	w := &Workspace{dir: dir, root: root, limits: limits, events: events, now: time.Now}
	w.collectStaging()
	return w, nil
}

// Close releases the workspace.
func (w *Workspace) Close() error { return w.root.Close() }

// closeRoot closes r and returns err, or the close failure when err is nil.
func closeRoot(r *os.Root, err error) error {
	if cerr := r.Close(); cerr != nil && err == nil {
		return internalError(cerr, "close %s", r.Name())
	}
	return err
}

// Limits returns the caps of this run.
func (w *Workspace) Limits() Limits { return w.limits }

// collectStaging deletes staging directories older than StagingMaxAge. Failures are reported as warnings:
// they never fail the operation that triggered the collection.
func (w *Workspace) collectStaging() {
	info, err := w.root.Lstat(StagingDir)
	if err != nil || !info.IsDir() {
		return
	}
	entries, err := fs.ReadDir(w.root.FS(), StagingDir)
	if err != nil {
		w.events.Warnf("list %s: %v", StagingDir, err)
		return
	}
	cutoff := w.now().Add(-StagingMaxAge)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			w.events.Warnf("stat staging %s: %v", e.Name(), err)
			continue
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		if err := w.root.RemoveAll(path.Join(StagingDir, e.Name())); err != nil {
			w.events.Warnf("remove stale staging %s: %v", e.Name(), err)
			continue
		}
		w.events.Infof("removed stale staging %s", e.Name())
	}
}

// taskInfo returns the lstat information of the task folder, or nil when it does not exist. A task
// folder that is not a real directory (for example a symlink planted in the editor) is invalidPath.
func (w *Workspace) taskInfo(task string) (fs.FileInfo, error) {
	if err := ValidateTaskName(task); err != nil {
		return nil, err
	}
	info, err := w.root.Lstat(task)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, nil
	case err != nil:
		return nil, internalError(err, "stat task folder %s", task)
	case !info.IsDir():
		return nil, pathError(task, "the task folder %q is not a directory", task)
	}
	return info, nil
}

// openTask opens the existing task folder as a root; notFound when it does not exist.
func (w *Workspace) openTask(task string) (*os.Root, error) {
	info, err := w.taskInfo(task)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, notFound("", "the task folder %q does not exist", task)
	}
	root, err := w.root.OpenRoot(task)
	if err != nil {
		return nil, internalError(err, "open task folder %s", task)
	}
	return root, nil
}

// stagingArea ensures the staging area exists. A staging entry that is not a real
// directory (replaced in the editor) is removed and recreated.
func (w *Workspace) stagingArea() error {
	info, err := w.root.Lstat(StagingDir)
	switch {
	case err == nil && info.IsDir():
		return nil
	case err == nil:
		if err := w.root.Remove(StagingDir); err != nil {
			return internalError(err, "remove invalid %s", StagingDir)
		}
	case !errors.Is(err, fs.ErrNotExist):
		return internalError(err, "stat %s", StagingDir)
	}
	if err := w.root.Mkdir(StagingDir, privateDirMode); err != nil && !errors.Is(err, fs.ErrExist) {
		return internalError(err, "create %s", StagingDir)
	}
	return nil
}

// stagingPath returns the workspace-relative path of a staging id.
func stagingPath(id string, parts ...string) string {
	return path.Join(append([]string{StagingDir, id}, parts...)...)
}

// createStaging creates staging/<id>/tree for a new extraction or checkout; exists when the id is taken.
func (w *Workspace) createStaging(id string) error {
	if err := ValidateStagingID(id); err != nil {
		return err
	}
	if err := w.stagingArea(); err != nil {
		return err
	}
	if err := w.root.Mkdir(stagingPath(id), privateDirMode); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return newError(CodeExists, "the staging id %q is already in use", id)
		}
		return internalError(err, "create staging %s", id)
	}
	if err := w.root.Mkdir(stagingPath(id, "tree"), dirMode); err != nil {
		return internalError(err, "create staging tree %s", id)
	}
	return nil
}

// ScratchDir creates a private directory for temporary files of this run in the staging area and
// returns its absolute path and a function that removes it. A crashed run's directory is collected like
// any stale staging directory.
func (w *Workspace) ScratchDir() (string, func() error, error) {
	if err := w.stagingArea(); err != nil {
		return "", nil, err
	}
	id, err := randomID()
	if err != nil {
		return "", nil, err
	}
	rel := stagingPath(scratchPrefix + id)
	if err := w.root.Mkdir(rel, privateDirMode); err != nil {
		return "", nil, internalError(err, "create the scratch directory")
	}
	remove := func() error {
		if err := w.root.RemoveAll(rel); err != nil {
			return internalError(err, "remove the scratch directory")
		}
		return nil
	}
	return w.abs(rel), remove, nil
}

// scratchPrefix starts the names of scratch directories in the staging area. It cannot collide with a
// staging id, which starts with a letter or digit and has no '.'.
const scratchPrefix = ".tmp-"

// removeStaging deletes staging/<id>; a missing directory is not an error.
func (w *Workspace) removeStaging(id string) error {
	if err := w.root.RemoveAll(stagingPath(id)); err != nil {
		return internalError(err, "remove staging %s", id)
	}
	return nil
}

// discardOnError removes staging/<id> when *errp is set, so a failed extract or checkout never leaves
// a half-filled staging directory behind.
func (w *Workspace) discardOnError(id string, errp *error) {
	if *errp == nil {
		return
	}
	if err := w.removeStaging(id); err != nil {
		w.events.Warnf("%v", err)
	}
}

// openStagingTree opens staging/<id>/tree[/<from>] as a root; notFound when missing.
func (w *Workspace) openStagingTree(id, from string) (*os.Root, string, error) {
	if err := ValidateStagingID(id); err != nil {
		return nil, "", err
	}
	rel := stagingPath(id, "tree")
	if from != "" {
		rel = path.Join(rel, from)
	}
	if err := w.noSymlinkComponents(rel); err != nil {
		return nil, "", err
	}
	info, err := w.root.Lstat(rel)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, "", notFound(from, "staging %q has no %s", id, describeFrom(from))
	case err != nil:
		return nil, "", internalError(err, "stat staging %s", id)
	case !info.IsDir():
		return nil, "", pathError(from, "%s of staging %q is not a directory", describeFrom(from), id)
	}
	root, err := w.root.OpenRoot(rel)
	if err != nil {
		return nil, "", internalError(err, "open staging %s", id)
	}
	return root, rel, nil
}

func describeFrom(from string) string {
	if from == "" {
		return "tree"
	}
	return fmt.Sprintf("folder %q", from)
}

// noSymlinkComponents checks every existing component of the workspace-relative path rel with lstat
// and fails with invalidPath at the first symlink.
func (w *Workspace) noSymlinkComponents(rel string) error {
	return noSymlinkComponents(w.root, rel)
}

// noSymlinkComponents checks every existing component of rel below root with lstat: a symlink, or a
// component that is not a directory but has more components below it, is invalidPath; the first missing
// component ends the check.
func noSymlinkComponents(root *os.Root, rel string) error {
	if rel == "" {
		return nil
	}
	return checkComponents(root, rel, strings.Count(rel, "/")+1)
}

// noSymlinkParents checks the parents of p below root like noSymlinkComponents; p itself may be
// anything (list and delete-files act on a symlink itself).
func noSymlinkParents(root *os.Root, p string) error {
	return checkComponents(root, p, strings.Count(p, "/"))
}

// checkComponents checks the first n components of rel.
func checkComponents(root *os.Root, rel string, n int) error {
	segments := strings.Split(rel, "/")
	for i := range n {
		prefix := strings.Join(segments[:i+1], "/")
		info, err := root.Lstat(prefix)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil
		case err != nil:
			return internalError(err, "stat %s", prefix)
		case info.Mode()&fs.ModeSymlink != 0:
			return pathError(prefix, "%q is a symlink; operations never follow symlinks", printable(prefix))
		case i < len(segments)-1 && !info.IsDir():
			return pathError(rel, "%q is not a directory", printable(prefix))
		}
	}
	return nil
}

// treeUsage is the size of a tree as the caps count it: Entries are the files, directories and symlinks
// below the root (the pack's SCANTOR_TASK_MAX_FILES unit), Bytes the sizes of the regular files.
type treeUsage struct {
	Entries int
	Bytes   int64
}

// add counts one more entry of size bytes.
func (u *treeUsage) add(bytes int64) {
	u.Entries++
	u.Bytes += bytes
}

// measure walks root with lstat only (symlinks are never followed). skip reports paths to leave out
// together with everything below them; nil skips nothing.
func measure(ctx context.Context, root *os.Root, skip func(p string) bool) (treeUsage, error) {
	var u treeUsage
	err := fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "walk %s", p)
		}
		if p == "." {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if skip != nil && skip(p) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		var size int64
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return internalError(err, "stat %s", p)
			}
			size = info.Size()
		}
		u.add(size)
		return nil
	})
	return u, err
}

// isStaging reports whether a workspace-relative path is the staging area.
func isStaging(p string) bool { return p == StagingDir }

// workspaceBytes returns the bytes of the whole workspace without the staging area.
func (w *Workspace) workspaceBytes(ctx context.Context) (int64, error) {
	u, err := measure(ctx, w.root, isStaging)
	return u.Bytes, err
}

// checkWorkspaceCap fails with workspaceFull when after > MaxWorkspaceBytes.
func (w *Workspace) checkWorkspaceCap(after int64) error {
	if limit := w.limits.MaxWorkspaceBytes; limit > 0 && after > limit {
		return limitError(CodeWorkspaceFull, limit, after, "the workspace would grow to %d bytes; the limit is %d", after, limit)
	}
	return nil
}

// checkTaskCaps fails when a task folder would exceed MaxFiles entries or MaxBytes.
func checkTaskCaps(limits Limits, u treeUsage) error {
	if limits.MaxFiles > 0 && u.Entries > limits.MaxFiles {
		return limitError(CodeTooManyFiles, int64(limits.MaxFiles), int64(u.Entries), "the task folder would have %d files and directories; the limit is %d", u.Entries, limits.MaxFiles)
	}
	if limits.MaxBytes > 0 && u.Bytes > limits.MaxBytes {
		return limitError(CodeTooLarge, limits.MaxBytes, u.Bytes, "the task folder would have %d bytes; the limit is %d", u.Bytes, limits.MaxBytes)
	}
	return nil
}

// taskSummary returns the pack summary of an existing task folder.
func (w *Workspace) taskSummary(ctx context.Context, task string) (Summary, error) {
	s, err := w.snapshot(ctx, task, nil, Limits{})
	return s.Summary(), err
}

// snapshot packs the existing task folder (a real directory, never a symlink) into out (nil: hash only).
func (w *Workspace) snapshot(ctx context.Context, task string, out io.Writer, limits Limits) (PackSummary, error) {
	info, err := w.taskInfo(task)
	if err != nil {
		return PackSummary{}, err
	}
	if info == nil {
		return PackSummary{}, notFound("", "the task folder %q does not exist", task)
	}
	return w.packDir(ctx, w.abs(task), out, limits)
}

// abs returns the absolute path of a workspace-relative path (for code that works on paths: the pack
// and git).
func (w *Workspace) abs(rel string) string {
	return filepath.Join(w.dir, filepath.FromSlash(rel))
}
