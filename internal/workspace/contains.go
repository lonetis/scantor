package workspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// holdsTree reports whether the folder dst already holds every entry of the tree src: the same type,
// the same execute bit and the same content (docs/editor.md §9.6). .git/ and .scantor/ are left out, and
// entries only dst has (local files such as an installed node_modules/) do not count.
//
// Callers compare the pack hashes first: two folders with the same pack hash have the same
// .dockerignore and the same packed entries, so only the entries the pack leaves out (README.md or docs/
// listed in .dockerignore) are compared here. Without this, a pull or an upload that changes only such
// files would report no change and never reach the workspace.
func holdsTree(ctx context.Context, src, dst *os.Root) (bool, error) {
	// Without a usable .dockerignore every entry is compared (the pack reports the problem).
	files, ignoreErr := taskpipe.LoadFileSet(src)
	held := true
	err := fs.WalkDir(src.FS(), ".", func(p string, d fs.DirEntry, err error) error {
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
			return skipEntry(d)
		}
		if ignoreErr == nil && !d.IsDir() {
			if inclusion, err := files.Classify(p, false); err == nil && inclusion == taskpipe.Included {
				return nil // part of the pack, which is equal
			}
		}
		same, err := sameEntry(src, dst, p)
		if err != nil {
			return err
		}
		if !same {
			held = false
			return fs.SkipAll
		}
		return nil
	})
	return held, err
}

// sameEntry compares the entry p of src with the one of dst, without following symlinks.
func sameEntry(src, dst *os.Root, p string) (bool, error) {
	a, err := src.Lstat(p)
	if err != nil {
		return false, internalError(err, "stat %s", p)
	}
	b, err := dst.Lstat(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	case err != nil:
		return false, internalError(err, "stat %s", p)
	case a.Mode().Type() != b.Mode().Type():
		return false, nil
	}
	switch m := a.Mode(); {
	case m.IsDir():
		return true, nil
	case m&fs.ModeSymlink != 0:
		at, err := src.Readlink(p)
		if err != nil {
			return false, internalError(err, "read the symlink %s", p)
		}
		bt, err := dst.Readlink(p)
		if err != nil {
			return false, internalError(err, "read the symlink %s", p)
		}
		return at == bt, nil
	case m.IsRegular():
		if a.Size() != b.Size() || (m&0o111 != 0) != (b.Mode()&0o111 != 0) {
			return false, nil
		}
		return sameContent(src, dst, p)
	default:
		return false, nil
	}
}

func sameContent(src, dst *os.Root, p string) (bool, error) {
	fa, err := src.Open(p)
	if err != nil {
		return false, internalError(err, "open %s", p)
	}
	defer fa.Close()
	fb, err := dst.Open(p)
	if err != nil {
		return false, internalError(err, "open %s", p)
	}
	defer fb.Close()
	bufA, bufB := make([]byte, 32<<10), make([]byte, 32<<10)
	for {
		na, errA := io.ReadFull(fa, bufA)
		nb, errB := io.ReadFull(fb, bufB)
		if na != nb || !bytes.Equal(bufA[:na], bufB[:nb]) {
			return false, nil
		}
		doneA := errors.Is(errA, io.EOF) || errors.Is(errA, io.ErrUnexpectedEOF)
		doneB := errors.Is(errB, io.EOF) || errors.Is(errB, io.ErrUnexpectedEOF)
		switch {
		case errA != nil && !doneA:
			return false, internalError(errA, "read %s", p)
		case errB != nil && !doneB:
			return false, internalError(errB, "read %s", p)
		case doneA || doneB:
			return doneA == doneB, nil
		}
	}
}
