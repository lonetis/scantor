//go:build !unix

package workspace

import "io/fs"

// ownedBy cannot read owners on this platform, so callers always set them.
func ownedBy(fs.FileInfo, int, int) bool { return false }
