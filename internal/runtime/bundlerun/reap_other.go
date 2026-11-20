//go:build !linux

package bundlerun

// Reap is a no-op outside Linux, where bundle images never run: the run is not handled here.
func Reap([]string) (code int, handled bool) { return 0, false }
