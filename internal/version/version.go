// Package version holds the build identity of the scantor binary and the single rule that turns an
// image name into an image reference (docs/architecture.md §4.2).
//
// Version, Commit and ImagePrefix are set at build time with
//
//	-ldflags "-X github.com/lonetis/scantor/internal/version.Version=1.4.0
//	          -X github.com/lonetis/scantor/internal/version.Commit=<sha>
//	          -X github.com/lonetis/scantor/internal/version.ImagePrefix=ghcr.io/lonetis/"
//
// Development builds keep the defaults (Version "dev", empty prefix), so they reference
// scantor-base-<base>:dev and scantor:dev.
package version

import (
	"regexp"
	"runtime"
)

// Build identity, overridden with -ldflags -X.
var (
	// Version is the scantor version: a release version (X.Y.Z), a git describe string for builds from
	// main, or "dev".
	Version = "dev"
	// Commit is the git commit the binary was built from (empty for local builds).
	Commit = ""
	// ImagePrefix is the registry prefix of scantor images ("ghcr.io/lonetis/" for releases, empty for
	// development builds). It always ends in "/" when it is not empty.
	ImagePrefix = ""
)

// ImageOverride is the SCANTOR_IMAGE_PREFIX / SCANTOR_IMAGE_TAG pair as read by a component's
// LoadConfig. A zero value means "no override".
type ImageOverride struct {
	Prefix string
	Tag    string
}

// Active reports whether the override replaces the compiled-in pair: only a non-empty tag activates it.
func (o ImageOverride) Active() bool { return o.Tag != "" }

// ImageRef returns the reference "<prefix><image>:<tag>" of a scantor image (for example
// "scantor-base-python" or "scantor"). The compiled-in pair (ImagePrefix, Version) is the default;
// when override.Tag is non-empty the pair (override.Prefix, override.Tag) replaces it as a whole.
// This is the only function that builds image references of scantor images.
func ImageRef(image string, override ImageOverride) string {
	prefix, tag := ImagePrefix, Version
	if override.Active() {
		prefix, tag = override.Prefix, override.Tag
	}
	return prefix + image + ":" + tag
}

var releasePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// IsRelease reports whether v is a release version "X.Y.Z" (no prefix, no suffix).
func IsRelease(v string) bool { return releasePattern.MatchString(v) }

// UserAgent returns "<component>/<Version>", for example "scantor-node/1.4.0".
func UserAgent(component string) string { return component + "/" + Version }

// Info is the build identity reported by `scantor version`.
type Info struct {
	Version     string `json:"version"`
	Commit      string `json:"commit"`
	ImagePrefix string `json:"imagePrefix"`
	Go          string `json:"go"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
}

// Current returns the build identity of the running binary.
func Current() Info {
	return Info{
		Version:     Version,
		Commit:      Commit,
		ImagePrefix: ImagePrefix,
		Go:          runtime.Version(),
		OS:          runtime.GOOS,
		Arch:        runtime.GOARCH,
	}
}
