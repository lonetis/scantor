//go:build unix

package workspace

import (
	"io/fs"
	"syscall"
)

// ownedBy reports whether info belongs to uid:gid.
func ownedBy(info fs.FileInfo, uid, gid int) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == uid && int(st.Gid) == gid
}
