package worker

import "golang.org/x/sys/unix"

// freeSpace returns the free bytes (available to unprivileged users) of the filesystem holding path
// (docs/runtime.md §7.1: the node's Docker data filesystem inside a container).
func freeSpace(path string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil //nolint:gosec,unconvert // block counts fit int64; Bsize differs per OS
}
