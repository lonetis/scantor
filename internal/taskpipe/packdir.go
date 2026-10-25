package taskpipe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
)

// PackDir packs the task folder dir (docs/tasks.md §9.2). Content problems are returned as PackErrors;
// any other error is a platform failure (for example a full temporary directory).
func PackDir(ctx context.Context, dir string, limits PackLimits) (*Pack, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, PackErrors{{Message: fmt.Sprintf("cannot read the task folder: %v", err)}}
	}
	if !info.IsDir() {
		return nil, PackErrors{{Message: fmt.Sprintf("%s is not a directory", dir)}}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, PackErrors{{Message: fmt.Sprintf("cannot open the task folder: %v", err)}}
	}
	defer root.Close()

	w := &dirWalker{ctx: ctx, root: root, limits: limits, included: map[string]bool{}, pending: map[string]bool{}, links: map[inodeKey]*linkUse{}}
	if w.files, err = LoadFileSet(root); err != nil {
		return nil, err
	}
	if err := fs.WalkDir(root.FS(), ".", w.visit); err != nil {
		var pe *PackError
		if errors.As(err, &pe) {
			w.errs = append(w.errs, pe)
		} else {
			return nil, err
		}
	}
	w.checkHardLinks()
	if len(w.errs) > 0 {
		return nil, w.errs
	}
	sortSources(w.sources)
	return writePack(ctx, w.sources, limits)
}

type dirWalker struct {
	ctx    context.Context
	root   *os.Root
	limits PackLimits
	files  *FileSet
	// included holds the directories that are part of the pack; pending holds excluded directories the
	// walk descended into because an exception may re-include something below them.
	included map[string]bool
	pending  map[string]bool
	sources  []source
	// estimate is the sum of file sizes, a lower bound of the tar size used to stop early.
	estimate int64
	links    map[inodeKey]*linkUse
	errs     PackErrors
}

// linkUse counts how many names of a multiply linked file the pack contains.
type linkUse struct {
	path  string
	nlink uint64
	seen  uint64
}

func (w *dirWalker) visit(p string, d fs.DirEntry, walkErr error) error {
	if p == "." {
		return walkErr
	}
	if err := w.ctx.Err(); err != nil {
		return err
	}
	isDir := d != nil && d.IsDir()
	if walkErr != nil {
		w.errs.add(p, "cannot read: %v", walkErr)
		return skip(isDir)
	}
	if hardExcluded(p) {
		return skip(isDir)
	}
	if msg := checkPath(p); msg != "" {
		w.errs.add(p, "%s", msg)
		return skip(isDir)
	}
	inclusion, err := w.files.Classify(p, isDir)
	if err != nil {
		return err
	}
	switch mode := d.Type(); {
	case mode.IsDir():
		switch inclusion {
		case ExcludedDescend:
			w.pending[p] = true
			return nil
		case Excluded:
			return fs.SkipDir
		}
		w.included[p] = true
		return w.add(source{Entry: Entry{Path: p, Kind: KindDir, Mode: modeDir}})
	case inclusion != Included:
		return nil
	case mode&fs.ModeSymlink != 0:
		target, err := w.root.Readlink(p)
		if err != nil {
			w.errs.add(p, "cannot read the symlink: %v", err)
			return nil
		}
		if msg := checkLink(p, target); msg != "" {
			w.errs.add(p, "%s", msg)
			return nil
		}
		return w.add(source{Entry: Entry{Path: p, Kind: KindSymlink, Mode: modeSymlink, Link: target}})
	case mode.IsRegular():
		info, err := d.Info()
		if err != nil {
			w.errs.add(p, "cannot read: %v", err)
			return nil
		}
		w.trackLinks(p, info)
		w.estimate += info.Size()
		if w.limits.MaxBytes > 0 && w.estimate > w.limits.MaxBytes {
			return capError(CapBytes, w.limits.MaxBytes)
		}
		return w.add(source{Entry: Entry{Path: p, Kind: KindFile, Mode: fileMode(info.Mode().Perm()), Size: info.Size()}, open: w.opener(p, info)})
	default:
		w.errs.add(p, "is a %s; a task may contain only regular files, directories and symlinks", describeMode(mode))
		return nil
	}
}

// add appends an entry together with the pending directories above it.
func (w *dirWalker) add(s source) error {
	for _, dir := range ancestors(s.Path) {
		if !w.included[dir] && w.pending[dir] {
			w.included[dir] = true
			w.sources = append(w.sources, source{Entry: Entry{Path: dir, Kind: KindDir, Mode: modeDir}})
		}
	}
	w.sources = append(w.sources, s)
	if w.limits.MaxFiles > 0 && len(w.sources) > w.limits.MaxFiles {
		return filesCapError(w.limits.MaxFiles)
	}
	return nil
}

// opener opens the file at p through the root (no escape through symlinks) and verifies that it is
// still the file the walk saw.
func (w *dirWalker) opener(p string, walked fs.FileInfo) func() (io.ReadCloser, int64, error) {
	return func() (io.ReadCloser, int64, error) {
		f, err := w.root.Open(p)
		if err != nil {
			return nil, 0, &PackError{Path: p, Message: fmt.Sprintf("cannot read: %v", err)}
		}
		info, err := f.Stat()
		if err != nil {
			_ = f.Close()
			return nil, 0, &PackError{Path: p, Message: fmt.Sprintf("cannot read: %v", err)}
		}
		if !info.Mode().IsRegular() || !os.SameFile(info, walked) {
			_ = f.Close()
			return nil, 0, &PackError{Path: p, Message: "the file changed while it was packed"}
		}
		return f, info.Size(), nil
	}
}

func (w *dirWalker) trackLinks(p string, info fs.FileInfo) {
	key, nlink, ok := linkInfo(info)
	if !ok || nlink <= 1 {
		return
	}
	use := w.links[key]
	if use == nil {
		use = &linkUse{path: p, nlink: nlink}
		w.links[key] = use
	}
	use.seen++
}

// checkHardLinks reports regular files whose hard links are not all part of the pack: such a link
// points at a file outside the packed folder.
func (w *dirWalker) checkHardLinks() {
	for _, use := range w.links {
		if use.seen < use.nlink {
			w.errs.add(use.path, "is a hard link to a file outside the task folder (or to a file .dockerignore excludes); copy the file instead")
		}
	}
}

func skip(isDir bool) error {
	if isDir {
		return fs.SkipDir
	}
	return nil
}

func describeMode(m fs.FileMode) string {
	switch {
	case m&fs.ModeNamedPipe != 0:
		return "named pipe"
	case m&fs.ModeSocket != 0:
		return "socket"
	case m&fs.ModeCharDevice != 0:
		return "character device"
	case m&fs.ModeDevice != 0:
		return "device"
	default:
		return strings.TrimSpace("special file " + m.String())
	}
}
