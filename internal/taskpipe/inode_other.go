//go:build !unix

package taskpipe

import "io/fs"

type inodeKey struct{ dev, ino uint64 }

// linkInfo reports no link information on platforms without stat(2) semantics.
func linkInfo(fs.FileInfo) (inodeKey, uint64, bool) { return inodeKey{}, 0, false }
