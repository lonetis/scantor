//go:build unix

package workspace

import "syscall"

// oNoFollow makes an open fail on a symlink in the last path component.
const oNoFollow = syscall.O_NOFOLLOW
