//go:build !unix

package workspace

// oNoFollow is unavailable on this platform; os.Root still confines every open to its directory.
const oNoFollow = 0
