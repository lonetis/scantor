//go:build !unix

package node

import "errors"

// diskFree is not available on this platform; the node daemon runs on linux.
func diskFree(string) (int64, error) {
	return 0, errors.New("free disk space cannot be measured on this platform")
}
