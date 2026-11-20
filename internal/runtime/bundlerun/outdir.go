package bundlerun

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/local"
)

// Run directory names (docs/runtime.md §15.8).
const (
	// ResultsDir holds the run directories of bundle runs below the work directory.
	ResultsDir = "results"
	// StampLayout names a run directory after the UTC start time.
	StampLayout = "20060102T150405Z"
	// maxCollisionSuffix bounds the -2, -3, … suffixes of a default run directory.
	maxCollisionSuffix = 1000
	// mountInfoPath lists the mounts of the runtime's mount namespace (proc(5)).
	mountInfoPath = "/proc/self/mountinfo"
)

// virtualFileSystems are the file systems whose content never reaches the host's disk: a run directory on
// one of them would be lost with the container, like one on its root file system.
var virtualFileSystems = map[string]bool{
	"proc": true, "sysfs": true, "devpts": true, "mqueue": true, "cgroup": true, "cgroup2": true, "tmpfs": true,
	"devtmpfs": true, "ramfs": true, "securityfs": true, "debugfs": true, "tracefs": true, "pstore": true,
	"bpf": true, "configfs": true, "hugetlbfs": true, "binfmt_misc": true, "fusectl": true, "nsfs": true,
}

// outDir resolves the run directory: --out, where a relative path is relative to the work directory, or
// else the base name of the default run directory, results/<UTC stamp> below the work directory, which the
// run claims when it starts (claimOutDir).
func (o *Options) outDir() string {
	if o.Flags.Out != "" {
		return o.workPath(o.Flags.Out)
	}
	return filepath.Join(o.WorkDir, ResultsDir, o.Now().UTC().Format(StampLayout))
}

// checkOutDir checks that the results would outlive the container: the nearest existing ancestor of dir
// lies on a mount (onMount). A directory the recipient named (--out) must also not exist or be an empty
// directory; the default run directory is claimed fresh when the run starts, so only its mount matters.
func (o *Options) checkOutDir(dir string, named bool) []api.Issue {
	ancestor := nearestExisting(dir)
	fi, err := os.Stat(ancestor)
	if err != nil {
		return []api.Issue{*issue("--out", "cannot inspect %s: %v", ancestor, unwrapPathError(err))}
	}
	var issues []api.Issue
	if mounted, err := o.onMount(ancestor, fi); err != nil {
		issues = append(issues, *issue("--out", "cannot inspect the root file system: %v", err))
	} else if !mounted {
		issues = append(issues, *issue("--out", "%s is inside the container, so the results would be lost: mount a folder at %s, for example docker run --rm -v \"$PWD:%s\" %s", dir, o.WorkDir, o.WorkDir, o.Info.Image))
	}
	if !named || ancestor != dir {
		return issues
	}
	if !fi.IsDir() {
		return append(issues, *issue("--out", "%s exists and is not a directory", dir))
	}
	if empty, err := emptyDir(dir); err != nil {
		issues = append(issues, *issue("--out", "cannot read %s: %v", dir, unwrapPathError(err)))
	} else if !empty {
		issues = append(issues, notEmpty(dir))
	}
	return issues
}

// notEmpty is the issue of a run directory with files in it.
func notEmpty(dir string) api.Issue {
	return *issue("--"+FlagOut, "%s is not empty; every run needs a new or empty directory", dir)
}

// onMount reports whether path (an existing file with info fi) lies on a mount, a bind mount or a volume:
// on another device than the root file system, or else below a mount point other than / that is not a
// virtual file system. The second test matters with the vfs storage driver, which keeps the root file
// system and the volumes on one device; without /proc/self/mountinfo (not Linux) only the first applies.
func (o *Options) onMount(path string, fi os.FileInfo) (bool, error) {
	root, rootErr := o.RootDevice()
	if dev, ok := device(fi); rootErr == nil && (!ok || dev != root) {
		return true, nil
	}
	if points, err := o.MountPoints(); err == nil {
		for _, p := range points {
			if p != "/" && within(p, path) {
				return true, nil
			}
		}
	}
	return false, rootErr
}

// mountPoints returns the mount points of /proc/self/mountinfo except / and those of virtual file systems.
func mountPoints() ([]string, error) {
	data, err := os.ReadFile(mountInfoPath)
	if err != nil {
		return nil, err
	}
	return parseMountInfo(string(data)), nil
}

// parseMountInfo returns the mount points of mountinfo lines (proc(5): the fifth field, octal-escaped, and
// the file system type after the "-" separator) except / and those of virtual file systems.
func parseMountInfo(data string) []string {
	var points []string
	for line := range strings.Lines(data) {
		fields := strings.Fields(line)
		sep := slices.Index(fields, "-")
		if sep < 6 || sep+1 >= len(fields) || virtualFileSystems[fields[sep+1]] {
			continue
		}
		if p := unescapeMountInfo(fields[4]); p != "/" {
			points = append(points, p)
		}
	}
	return points
}

// unescapeMountInfo decodes the octal escapes (\040 for a space, …) of a mountinfo path.
func unescapeMountInfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func emptyDir(dir string) (bool, error) {
	f, err := os.Open(dir) //nolint:gosec // the run directory the recipient names
	if err != nil {
		return false, err
	}
	defer f.Close()
	if _, err := f.Readdirnames(1); errors.Is(err, io.EOF) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	return false, nil
}

// nearestExisting returns path when it exists, else its nearest existing ancestor.
func nearestExisting(path string) string {
	for {
		if _, err := os.Lstat(path); err == nil {
			return path
		}
		parent := filepath.Dir(path)
		if parent == path {
			return path
		}
		path = parent
	}
}

// createOutDir creates dir and its missing parents and gives the created directories to owner (best effort).
func createOutDir(dir string, owner *local.FileOwner) error {
	var missing []string
	for d := dir; ; {
		if _, err := os.Lstat(d); err == nil {
			break
		}
		missing = append(missing, d)
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // the recipient reads the results
		return unwrapPathError(err)
	}
	if owner != nil {
		for _, d := range missing {
			_ = os.Lchown(d, owner.UID, owner.GID)
		}
	}
	return nil
}

// claimOutDir creates the default run directory: base, or base-2, base-3, … when that name exists. Every
// name is claimed with an exclusive mkdir, so runs that start in the same second in the same folder never
// share a directory. The missing parents and the claimed directory are given to owner (best effort).
func claimOutDir(base string, owner *local.FileOwner) (string, error) {
	if err := createOutDir(filepath.Dir(base), owner); err != nil {
		return "", err
	}
	for n := 1; n <= maxCollisionSuffix; n++ {
		dir := base
		if n > 1 {
			dir += "-" + strconv.Itoa(n)
		}
		err := os.Mkdir(dir, 0o755) //nolint:gosec // the recipient reads the results
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", unwrapPathError(err)
		}
		if owner != nil {
			_ = os.Lchown(dir, owner.UID, owner.GID)
		}
		return dir, nil
	}
	return "", fmt.Errorf("it and every name up to %s-%d exist", filepath.Base(base), maxCollisionSuffix)
}

// fileOwner is the owner of the files of a run when the runtime runs as root (euid 0): the owner of the
// work directory, or of the nearest existing ancestor of a run directory outside it, so the results on a
// rootful Linux host belong to the user who mounted the folder. Otherwise nil: the files belong to the
// runtime's user anyway.
func (o *Options) fileOwner(dir string, euid int) *local.FileOwner {
	if euid != 0 {
		return nil
	}
	ref := o.WorkDir
	if !within(o.WorkDir, dir) {
		ref = nearestExisting(dir)
	}
	fi, err := os.Stat(ref)
	if err != nil {
		return nil
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return &local.FileOwner{UID: int(st.Uid), GID: int(st.Gid)}
}

// device returns the device of a file.
func device(fi os.FileInfo) (uint64, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true //nolint:gosec // int32 on darwin, uint64 on linux
}

// rootDevice returns the device of the root file system.
func rootDevice() (uint64, error) {
	fi, err := os.Stat("/")
	if err != nil {
		return 0, err
	}
	dev, ok := device(fi)
	if !ok {
		return 0, errors.New("no device number")
	}
	return dev, nil
}

// within reports whether path lies in dir (or is dir).
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// displayPath shows a path below the work directory relative to it, as the recipient sees it from the
// mounted folder; other paths stay absolute.
func (o *Options) displayPath(path string) string {
	if within(o.WorkDir, path) {
		if rel, err := filepath.Rel(o.WorkDir, path); err == nil {
			return rel
		}
	}
	return path
}
