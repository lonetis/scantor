//go:build unix

package node

import (
	"fmt"
	"syscall"
)

// diskFree returns the bytes available to unprivileged users on the filesystem of path
// (statfs Bavail × Bsize). Inside the daemon container, "/" is an overlay whose free space is that of
// the engine's storage filesystem (docs/nodes.md §7.1).
func diskFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	return int64(st.Bavail) * int64(st.Bsize), nil //nolint:gosec // block counts of a real filesystem fit in int64
}
