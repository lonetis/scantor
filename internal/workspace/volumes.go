package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Volume directories as the init and purge helpers see them: the whole scantor-workspaces volume at
// <root>/workspaces and the whole scantor-editor-home volume at <root>/editor-home (docs/editor.md §9.2).
const (
	DefaultVolumesRoot = "/volumes"
	volumeWorkspaces   = "workspaces"
	volumeEditorHome   = "editor-home"
)

// Owner of the per-user directories: editors and helpers run as 1000:1000 (docs/editor.md §3).
const (
	DefaultUID = 1000
	DefaultGID = 1000
)

// VolumeOptions locate the volumes and set the owner of the per-user directories.
type VolumeOptions struct {
	Root string
	UID  int
	GID  int
}

// InitResult is the output of init: the directories created by this run.
type InitResult struct {
	Created []string `json:"created"`
}

// PurgeResult is the output of purge: the directories removed by this run.
type PurgeResult struct {
	Removed []string `json:"removed"`
}

// InitUser creates <userId> in both volumes when missing (owner UID:GID, mode 0700) and
// <userId>/.scantor-staging in the workspace volume (docs/editor.md §9.4 init). An existing entry must
// be a real directory; its owner and mode are fixed. It reads no content.
func InitUser(ctx context.Context, opts VolumeOptions, userID string) (*InitResult, error) {
	if err := ValidateUserID(userID); err != nil {
		return nil, err
	}
	res := &InitResult{Created: []string{}}
	for _, vol := range []string{volumeWorkspaces, volumeEditorHome} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		root, err := openVolume(opts.Root, vol)
		if err != nil {
			return nil, err
		}
		created, err := ensureOwnedDir(root, userID, opts, false)
		if err == nil && vol == volumeWorkspaces {
			err = ensureStaging(root, userID, opts)
		}
		if err := closeRoot(root, err); err != nil {
			return nil, err
		}
		if created {
			res.Created = append(res.Created, vol+"/"+userID)
		}
	}
	return res, nil
}

func ensureStaging(volume *os.Root, userID string, opts VolumeOptions) error {
	user, err := volume.OpenRoot(userID)
	if err != nil {
		return internalError(err, "open %s", userID)
	}
	defer user.Close()
	_, err = ensureOwnedDir(user, StagingDir, opts, true)
	return err
}

// ensureOwnedDir creates name below root (0700) or checks the existing entry, then sets its owner and
// mode through an open file descriptor. A non-directory entry is an error, or is replaced when replace is
// set (the staging folder, which the user can tamper with in the editor).
func ensureOwnedDir(root *os.Root, name string, opts VolumeOptions, replace bool) (bool, error) {
	created := false
	info, err := root.Lstat(name)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := root.Mkdir(name, privateDirMode); err != nil {
			return false, internalError(err, "create %s", name)
		}
		created = true
	case err != nil:
		return false, internalError(err, "stat %s", name)
	case !info.IsDir() && replace:
		if err := root.Remove(name); err != nil {
			return false, internalError(err, "remove invalid %s", name)
		}
		if err := root.Mkdir(name, privateDirMode); err != nil {
			return false, internalError(err, "create %s", name)
		}
	case !info.IsDir():
		return false, newError(CodeInternal, "%s exists and is not a directory", name)
	}
	f, err := root.OpenFile(name, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return false, internalError(err, "open %s", name)
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.IsDir() {
		return false, newError(CodeInternal, "%s is not a directory", name)
	}
	if err := f.Chown(opts.UID, opts.GID); err != nil {
		return false, internalError(err, "chown %s", name)
	}
	if err := f.Chmod(privateDirMode); err != nil {
		return false, internalError(err, "chmod %s", name)
	}
	return created, nil
}

// PurgeUser removes <userId> from both volumes (docs/editor.md §9.4 purge). RemoveAll never follows
// symlinks. It reads no content.
func PurgeUser(ctx context.Context, opts VolumeOptions, userID string) (*PurgeResult, error) {
	if err := ValidateUserID(userID); err != nil {
		return nil, err
	}
	res := &PurgeResult{Removed: []string{}}
	for _, vol := range []string{volumeWorkspaces, volumeEditorHome} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		root, err := openVolume(opts.Root, vol)
		if err != nil {
			return nil, err
		}
		_, statErr := root.Lstat(userID)
		if err := root.RemoveAll(userID); err != nil {
			err = internalError(err, "remove %s/%s", vol, userID)
			return nil, closeRoot(root, err)
		}
		if err := closeRoot(root, nil); err != nil {
			return nil, err
		}
		if statErr == nil {
			res.Removed = append(res.Removed, vol+"/"+userID)
		}
	}
	return res, nil
}

func openVolume(root, vol string) (*os.Root, error) {
	if root == "" {
		root = DefaultVolumesRoot
	}
	r, err := os.OpenRoot(filepath.Join(root, vol))
	if err != nil {
		return nil, internalError(err, "open the volume %s", vol)
	}
	return r, nil
}
