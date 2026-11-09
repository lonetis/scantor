package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
)

// ScriptsDir is the folder below the workspace root that holds the script folders (docs/scripts.md). Its
// leading dot fails the task-name rule, so it can never collide with a task folder.
const ScriptsDir = ".scripts"

// FolderKind is the kind of a folder a helper operation addresses.
type FolderKind string

// Folder kinds: `--task <name>` and `--script <name>`.
const (
	KindTask   FolderKind = "task"
	KindScript FolderKind = "script"
)

// Folder addresses one task or script folder of a workspace by kind and name.
type Folder struct {
	Kind FolderKind
	Name string
}

// TaskFolder addresses the task folder name.
func TaskFolder(name string) Folder { return Folder{Kind: KindTask, Name: name} }

// ScriptFolder addresses the script folder name.
func ScriptFolder(name string) Folder { return Folder{Kind: KindScript, Name: name} }

// ParseFolderKind accepts "task" and "script" (the --kind flag of extract).
func ParseFolderKind(s string) (FolderKind, error) {
	switch FolderKind(s) {
	case KindTask, KindScript:
		return FolderKind(s), nil
	}
	return "", invalidArgument(`invalid kind %q: use "task" or "script"`, printable(s))
}

// Rel is the one mapping from a folder to its workspace-relative path: <name> for a task,
// .scripts/<name> for a script.
func (f Folder) Rel() string {
	if f.Kind == KindScript {
		return path.Join(ScriptsDir, f.Name)
	}
	return f.Name
}

// Validate checks the kind and the name (task and script names follow the same rules).
func (f Folder) Validate() error {
	switch f.Kind {
	case KindTask, KindScript:
		return validateName(string(f.Kind), f.Name)
	}
	return newError(CodeInternal, "unknown folder kind %q", f.Kind)
}

// describe names the folder in messages: `task folder "echo"`.
func (f Folder) describe() string {
	return fmt.Sprintf("%s folder %q", f.Kind, f.Name)
}

// folderInfo returns the lstat information of the folder, or nil when it does not exist. A folder, or a
// parent of it (.scripts), that is not a real directory (for example a symlink planted in the editor) is
// invalidPath.
func (w *Workspace) folderInfo(f Folder) (fs.FileInfo, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	rel := f.Rel()
	if err := noSymlinkParents(w.root, rel); err != nil {
		return nil, err
	}
	info, err := w.root.Lstat(rel)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, nil
	case err != nil:
		return nil, internalError(err, "stat %s", f.describe())
	case !info.IsDir():
		return nil, pathError(rel, "the %s is not a directory", f.describe())
	}
	return info, nil
}

// openFolder opens the existing folder as a root; notFound when it does not exist.
func (w *Workspace) openFolder(f Folder) (*os.Root, error) {
	info, err := w.folderInfo(f)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, notFound("", "the %s does not exist", f.describe())
	}
	root, err := w.root.OpenRoot(f.Rel())
	if err != nil {
		return nil, internalError(err, "open %s", f.describe())
	}
	return root, nil
}

// folderParent creates the parent of a folder that is about to be created (.scripts for scripts), never
// through a symlink.
func (w *Workspace) folderParent(f Folder) error {
	return mkdirAllNoFollow(w.root, path.Dir(f.Rel()))
}
