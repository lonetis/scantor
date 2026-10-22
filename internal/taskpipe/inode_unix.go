//go:build unix

package taskpipe

import (
	"io/fs"
	"syscall"
)

type inodeKey struct{ dev, ino uint64 }

// linkInfo returns the identity and link count of a file, when the platform reports them.
func linkInfo(info fs.FileInfo) (inodeKey, uint64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return inodeKey{}, 0, false
	}
	//nolint:gosec,unconvert // device and inode numbers are only compared; their width differs per platform
	return inodeKey{dev: uint64(st.Dev), ino: uint64(st.Ino)}, uint64(st.Nlink), true
}
