package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
)

// Values of commit --expect besides a pack hash.
const (
	ExpectAny    = "any"
	ExpectAbsent = "absent"
)

// CommitOptions are the flags of commit.
type CommitOptions struct {
	Staging string
	// From is the folder below the staging tree to commit ("" or "." = the tree itself).
	From string
	Task string
	// Expect is the workspace hash the orchestrator based its conflict decision on: a pack hash,
	// "absent" (no task folder) or "any" (force).
	Expect string
}

// CommitResult is the output of commit.
type CommitResult struct {
	Task               string  `json:"task"`
	Changed            bool    `json:"changed"`
	PreviousPackSHA256 *string `json:"previousPackSha256"`
	Workspace          Summary `json:"workspace"`
}

// Commit replaces the task folder atomically with a staged tree (docs/editor.md §9.6). The source is
// validated with the archive rules (regular files and directories only, path rules, caps; .git/ and
// .scantor/ are dropped at any depth) and its modes are normalised. When the current folder differs from
// both the expected hash and the new content, the commit fails with workspaceDirty. Otherwise the current
// folder is renamed into staging/<id>/old, the source is renamed into its place (one filesystem, so each
// rename is atomic) and the old folder is deleted.
//
// Without From the whole staging directory is removed afterwards. With From (git imports, which may
// commit several candidates of one checkout) the rest of the staging tree is kept for further commits;
// the orchestrator ends with discard.
func (w *Workspace) Commit(ctx context.Context, opts CommitOptions) (*CommitResult, error) {
	if err := ValidateTaskName(opts.Task); err != nil {
		return nil, err
	}
	if err := validateExpect(opts.Expect); err != nil {
		return nil, err
	}
	from, err := subtreePath(opts.From)
	if err != nil {
		return nil, err
	}
	src, srcRel, err := w.openStagingTree(opts.Staging, from)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	staged, err := normaliseTree(ctx, src, w.limits)
	if err != nil {
		return nil, err
	}
	next, err := w.summarizeDir(ctx, w.abs(srcRel))
	if err != nil {
		return nil, err
	}
	current, curBytes, err := w.currentState(ctx, opts.Task, opts.Expect)
	if err != nil {
		return nil, err
	}
	if opts.Expect != ExpectAny && opts.Expect != current && current != next.PackSHA256 {
		e := newError(CodeWorkspaceDirty, "the task folder %q changed since the decision (current %s, expected %s)", opts.Task, current, opts.Expect)
		e.Details = map[string]any{"current": current, "expected": opts.Expect}
		return nil, e
	}
	res := &CommitResult{Task: opts.Task, Workspace: next}
	if current != ExpectAbsent && current != "" {
		prev := current
		res.PreviousPackSHA256 = &prev
	}
	if current == next.PackSHA256 {
		w.events.Infof("the task folder %q already has this content", opts.Task)
		return res, w.finishStaging(opts.Staging, opts.From)
	}
	wsBytes, err := w.workspaceBytes(ctx)
	if err != nil {
		return nil, err
	}
	if err := w.checkWorkspaceCap(wsBytes - curBytes + staged.Bytes); err != nil {
		return nil, err
	}
	if err := w.swap(opts.Staging, srcRel, opts.Task, current != ExpectAbsent); err != nil {
		return nil, err
	}
	res.Changed = true
	w.events.Infof("committed %d files and directories (%d bytes) to %q", staged.Entries, staged.Bytes, opts.Task)
	return res, w.finishStaging(opts.Staging, opts.From)
}

func validateExpect(expect string) error {
	if expect == ExpectAny || expect == ExpectAbsent || sha256Pattern.MatchString(expect) {
		return nil
	}
	return invalidArgument(`invalid --expect %q: use a pack hash, "absent" or "any"`, printable(expect))
}

// currentState returns the pack hash of the task folder ("absent" when it does not exist) and the bytes
// it occupies. With expect "any" a folder that cannot be packed does not block the commit (its hash is
// "").
func (w *Workspace) currentState(ctx context.Context, task, expect string) (string, int64, error) {
	root, err := w.openTask(task)
	if err != nil {
		if werr := AsError(err); werr.Code == CodeNotFound {
			return ExpectAbsent, 0, nil
		}
		return "", 0, err
	}
	defer root.Close()
	u, err := measure(ctx, root, nil)
	if err != nil {
		return "", 0, err
	}
	sum, err := w.summarizeDir(ctx, w.abs(task))
	if err != nil {
		var werr *Error
		if expect == ExpectAny && errors.As(err, &werr) && werr.Code != CodeInternal {
			w.events.Warnf("the current task folder cannot be packed (%v); replacing it", werr)
			return "", u.Bytes, nil
		}
		return "", 0, err
	}
	return sum.PackSHA256, u.Bytes, nil
}

// swap moves the task folder out of the way and the source into its place, restoring the old folder when
// the second rename fails.
func (w *Workspace) swap(id, srcRel, task string, exists bool) error {
	old := stagingPath(id, "old")
	if err := w.root.RemoveAll(old); err != nil {
		return internalError(err, "clear %s", old)
	}
	if exists {
		if err := w.root.Rename(task, old); err != nil {
			return internalError(err, "move the task folder %s aside", task)
		}
	}
	if err := w.root.Rename(srcRel, task); err != nil {
		if exists {
			if rerr := w.root.Rename(old, task); rerr != nil {
				w.events.Warnf("restore the task folder %s: %v", task, rerr)
			}
		}
		if errors.Is(err, fs.ErrExist) {
			return newError(CodeWorkspaceDirty, "the task folder %q was created concurrently", task)
		}
		return internalError(err, "move the staged tree into %s", task)
	}
	if err := w.root.RemoveAll(old); err != nil {
		w.events.Warnf("remove the previous task folder: %v", err)
	}
	return nil
}

// finishStaging removes staging/<id> after a commit without --from.
func (w *Workspace) finishStaging(id, from string) error {
	if from != "" {
		return nil
	}
	return w.removeStaging(id)
}

// normaliseTree applies the archive rules to a staged tree (git checkouts, extracted uploads) before it
// becomes a task folder: .git/ and .scantor/ are removed at any depth; only regular files and directories
// remain (a symlink is invalidPath: symlinks are not supported in imported tasks); the path rules and the
// entry and byte caps hold; modes are normalised (files 0644 or 0755, directories 0755). It returns the
// usage of the tree.
func normaliseTree(ctx context.Context, root *os.Root, limits Limits) (treeUsage, error) {
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
		if isHardExcluded(p) {
			if err := root.RemoveAll(p); err != nil {
				return internalError(err, "remove %s", p)
			}
			return skipEntry(d)
		}
		if err := ValidatePath(p); err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return internalError(err, "stat %s", p)
		}
		switch m := info.Mode(); {
		case m&fs.ModeSymlink != 0:
			return pathError(p, "%q is a symlink; symlinks are not supported in imported tasks", printable(p))
		case m.IsDir():
			u.add(0)
			if err := checkTaskCaps(limits, u); err != nil {
				return err
			}
			return chmodIfNeeded(root, p, m, dirMode)
		case m.IsRegular():
			u.add(info.Size())
			if err := checkTaskCaps(limits, u); err != nil {
				return err
			}
			want := fileMode
			if m&0o111 != 0 {
				want = execMode
			}
			return chmodIfNeeded(root, p, m, want)
		default:
			return pathError(p, "%q is not a regular file or directory", printable(p))
		}
	})
	return u, err
}

// skipEntry skips the rest of a directory the walk just removed.
func skipEntry(d fs.DirEntry) error {
	if d.IsDir() {
		return fs.SkipDir
	}
	return nil
}

func chmodIfNeeded(root *os.Root, p string, have, want fs.FileMode) error {
	if have.Perm() == want {
		return nil
	}
	if err := root.Chmod(p, want); err != nil {
		return internalError(err, "chmod %s", p)
	}
	return nil
}

// Discard removes staging/<id> (docs/editor.md §9.4 discard); a missing directory is not an error.
func (w *Workspace) Discard(id string) error {
	if err := ValidateStagingID(id); err != nil {
		return err
	}
	return w.removeStaging(id)
}

// Snapshot writes the deterministic pack of the task folder to out, or only computes its summary when
// out is nil (docs/editor.md §9.4 snapshot). The caps are MaxFiles, MaxBytes and MaxPackBytes.
func (w *Workspace) Snapshot(ctx context.Context, task string, out io.Writer) (PackSummary, error) {
	return w.snapshot(ctx, task, out, w.limits)
}

// randomID returns a random staging id.
func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", internalError(err, "random id")
	}
	return hex.EncodeToString(b[:]), nil
}
