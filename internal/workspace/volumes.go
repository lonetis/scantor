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

// Modes of the volume roots that prepare sets: owned by UID:GID, or, where the filesystem refuses chown
// (NFS under rootless Docker), writable for everyone plus the sticky bit like /tmp (mode 1777), so the init
// and purge helpers remove only directories they own. The helpers open the root for reading (os.OpenRoot),
// so it must stay readable.
const (
	volumeRootMode       = 0o711
	sharedVolumeRootMode = 0o777
	// sharedUserDirMode is the mode of the <userId> directories on a shared volume: there the Docker daemon
	// is rootless and runs as the host user, which has no DAC override on such a filesystem, yet it must open
	// a directory to mount it as a volume subpath.
	sharedUserDirMode = 0o755
)

// PrepareResult is the output of prepare: how each volume root was made usable for UID:GID.
type PrepareResult struct {
	Volumes []PreparedVolume `json:"volumes"`
}

// PreparedVolume is one volume root after prepare. Shared is true when the filesystem refused chown and
// the root is sticky and writable for everyone instead.
type PreparedVolume struct {
	Volume string `json:"volume"`
	Shared bool   `json:"shared"`
}

// InitResult is the output of init: the directories created by this run.
type InitResult struct {
	Created []string `json:"created"`
}

// PurgeResult is the output of purge: the directories removed by this run.
type PurgeResult struct {
	Removed []string `json:"removed"`
}

// PrepareVolumes makes the roots of both volumes usable for the init and purge helpers, which run as
// UID:GID like every other helper (docs/editor.md §9.4 prepare): owner UID:GID, mode 0711. Where the
// filesystem refuses chown (NFS under rootless Docker) the root gets mode 1777 instead and the volume is
// reported as shared; events carry a warning. It runs as root with CHOWN and FOWNER, works on the two
// mount points by path (both are Docker mounts, never symlinks) and reads no content.
func PrepareVolumes(ctx context.Context, opts VolumeOptions, events *Events) (*PrepareResult, error) {
	root := opts.Root
	if root == "" {
		root = DefaultVolumesRoot
	}
	res := &PrepareResult{Volumes: []PreparedVolume{}}
	for _, vol := range []string{volumeWorkspaces, volumeEditorHome} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path := filepath.Join(root, vol)
		info, err := os.Lstat(path)
		if err != nil {
			return nil, internalError(err, "stat the volume %s", vol)
		}
		if !info.IsDir() {
			return nil, newError(CodeInternal, "the volume %s is not a directory", vol)
		}
		shared := false
		if !ownedBy(info, opts.UID, opts.GID) {
			if chownErr := os.Chown(path, opts.UID, opts.GID); chownErr != nil {
				shared = true
				events.Warnf("the volume %s refuses chown to %d:%d (%v); it is sticky and writable for everyone instead (mode 1777)",
					vol, opts.UID, opts.GID, chownErr)
			}
		}
		mode := os.FileMode(volumeRootMode)
		if shared {
			mode = sharedVolumeRootMode | os.ModeSticky
		}
		if err := os.Chmod(path, mode); err != nil {
			return nil, internalError(err, "chmod the volume %s", vol)
		}
		res.Volumes = append(res.Volumes, PreparedVolume{Volume: vol, Shared: shared})
	}
	return res, nil
}

// InitUser creates <userId> in both volumes when missing (owner UID:GID, mode 0700, or 0755 on a shared
// volume: userDirMode) and <userId>/.scantor-staging (0700) in the workspace volume (docs/editor.md §9.4
// init). An existing entry must be a real directory; its owner and mode are fixed. It reads no content.
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
		mode, err := userDirMode(root)
		created := false
		if err == nil {
			created, err = ensureOwnedDir(root, userID, opts, mode, false)
		}
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
	_, err = ensureOwnedDir(user, StagingDir, opts, privateDirMode, true)
	return err
}

// userDirMode is the mode of the <userId> directories of a volume: 0700, or 0755 when prepare made the
// volume root sticky because its filesystem refuses chown (sharedUserDirMode).
func userDirMode(volume *os.Root) (fs.FileMode, error) {
	info, err := volume.Stat(".")
	if err != nil {
		return 0, internalError(err, "stat the volume")
	}
	if info.Mode()&os.ModeSticky != 0 {
		return sharedUserDirMode, nil
	}
	return privateDirMode, nil
}

// ensureOwnedDir creates name below root with mode or checks the existing entry, then sets its owner and
// mode through an open file descriptor. A non-directory entry is an error, or is replaced when replace is
// set (the staging folder, which the user can tamper with in the editor).
func ensureOwnedDir(root *os.Root, name string, opts VolumeOptions, mode fs.FileMode, replace bool) (bool, error) {
	created := false
	info, err := root.Lstat(name)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := root.Mkdir(name, mode); err != nil {
			return false, internalError(err, "create %s", name)
		}
		created = true
	case err != nil:
		return false, internalError(err, "stat %s", name)
	case !info.IsDir() && replace:
		if err := root.Remove(name); err != nil {
			return false, internalError(err, "remove invalid %s", name)
		}
		if err := root.Mkdir(name, mode); err != nil {
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
	info, err = f.Stat()
	if err != nil || !info.IsDir() {
		return false, newError(CodeInternal, "%s is not a directory", name)
	}
	// The helper runs as UID:GID, so its own directories need neither call; skipping them avoids a no-op
	// SETATTR that a network filesystem may refuse.
	if !ownedBy(info, opts.UID, opts.GID) {
		if err := f.Chown(opts.UID, opts.GID); err != nil {
			return false, internalError(err, "chown %s", name)
		}
	}
	if info.Mode().Perm() != mode || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		if err := f.Chmod(mode); err != nil {
			return false, internalError(err, "chmod %s", name)
		}
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
		if err := removeAllOwned(root, userID); err != nil {
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

// removeAllOwned removes name like RemoveAll. The purge helper runs as the owner of the user's files
// without DAC_OVERRIDE, so a directory the user made unwritable or unsearchable in the editor would stop
// it: after a failure, every directory below name gets mode 0700 and the removal is repeated. Symlinks are
// never followed.
func removeAllOwned(root *os.Root, name string) error {
	err := root.RemoveAll(name)
	if err == nil || !errors.Is(err, fs.ErrPermission) {
		return err
	}
	if fixErr := makeDirsWritable(root, name); fixErr != nil {
		return errors.Join(err, fixErr)
	}
	return root.RemoveAll(name)
}

// makeDirsWritable gives every directory at and below name mode 0700, each before it is read.
func makeDirsWritable(root *os.Root, name string) error {
	info, err := root.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() {
		return err
	}
	if err := root.Chmod(name, privateDirMode); err != nil {
		return err
	}
	dir, err := root.Open(name)
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	if closeErr := dir.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			if err := makeDirsWritable(root, filepath.Join(name, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
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
