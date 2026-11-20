package taskpipe

import (
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
)

// Result is the BuildResult of docs/tasks.md §9.8, the payload of the final `result` event. Fields of
// phases that did not run are null; Errors and Warnings are never null.
type Result struct {
	OK               bool               `json:"ok"`
	Pack             *Summary           `json:"pack"`
	Manifest         *manifest.Manifest `json:"manifest"`
	SettingsDefaults *api.ScanSettings  `json:"settingsDefaults"`
	Language         *string            `json:"language"`
	Privileged       *bool              `json:"privileged"`
	BaseImage        *api.ImageRef      `json:"baseImage"`
	// Image is the built (and with --push, pushed) image of a successful build; null otherwise.
	Image       *Image           `json:"image"`
	Description *api.Description `json:"description"`
	Errors      []api.BuildError `json:"errors"`
	Warnings    []string         `json:"warnings"`
	DurationsMs map[string]int64 `json:"durationsMs"`
}

// ScriptResult is the result of `scantor script build` (docs/scripts.md), the payload of its final
// `result` event: the frame of Result with the script manifest in place of the task fields. Fields of
// phases that did not run are null; Errors and Warnings are never null.
type ScriptResult struct {
	OK       bool                     `json:"ok"`
	Pack     *Summary                 `json:"pack"`
	Manifest *manifest.ScriptManifest `json:"manifest"`
	// Entry is the manifest's entry, defaulted from the language's script.entry.
	Entry *string `json:"entry"`
	// Defaults are the manifest's run settings with the resource fallbacks filled in; a null timeoutMs
	// leaves the timeout to the orchestrator.
	Defaults  *manifest.ScriptDefaults `json:"defaults"`
	BaseImage *api.ImageRef            `json:"baseImage"`
	// Image is the built (or reused) local image of a successful build; null otherwise.
	Image       *Image           `json:"image"`
	Errors      []api.BuildError `json:"errors"`
	Warnings    []string         `json:"warnings"`
	DurationsMs map[string]int64 `json:"durationsMs"`
}

// BundleResult is the result of `scantor task bundle` (docs/tasks.md §9.11), the payload of its final
// `result` event. Bundle is null unless the archive was written completely; Errors and Warnings are
// never null.
type BundleResult struct {
	OK          bool             `json:"ok"`
	Bundle      *BundleArchive   `json:"bundle"`
	Errors      []api.BuildError `json:"errors"`
	Warnings    []string         `json:"warnings"`
	DurationsMs map[string]int64 `json:"durationsMs"`
}

// BundleArchive describes a written bundle archive: the image name it loads as, the image's platform
// and size, the archive's size and SHA-256 (of the gzip bytes written to the output) and the version of
// the runtime baked into it.
type BundleArchive struct {
	Image          string       `json:"image"`
	Platform       api.Platform `json:"platform"`
	ImageBytes     int64        `json:"imageBytes"`
	Bytes          int64        `json:"bytes"`
	SHA256         string       `json:"sha256"`
	ScantorVersion string       `json:"scantorVersion"`
}

// Image is the image of a build result. Repository, Tag and Digest are set after a push.
type Image struct {
	Ref        string       `json:"ref"`
	ID         string       `json:"id"`
	Repository string       `json:"repository,omitempty"`
	Tag        string       `json:"tag,omitempty"`
	Digest     string       `json:"digest,omitempty"`
	Bytes      int64        `json:"bytes"`
	Platform   api.Platform `json:"platform"`
}

func newResult() *Result {
	return &Result{Errors: []api.BuildError{}, Warnings: []string{}, DurationsMs: map[string]int64{}}
}

// ExitCode returns the exit code of docs/tasks.md §9.9: 0 on success, 3 when a push or platform error
// occurred, 2 for every other (task content) error.
func (r *Result) ExitCode() int { return exitCode(r.OK, r.Errors) }

// ExitCode returns the exit code of a script build, with the meaning of Result.ExitCode: 0 on success,
// 3 when a platform error occurred, 2 for every other (script content) error.
func (r *ScriptResult) ExitCode() int { return exitCode(r.OK, r.Errors) }

// ExitCode returns the exit code of a bundle step, with the meaning of Result.ExitCode: 0 on success,
// 3 when a platform error occurred, 2 for build errors (build timeout, image size, forbidden labels).
func (r *BundleResult) ExitCode() int { return exitCode(r.OK, r.Errors) }

func exitCode(ok bool, errs []api.BuildError) int {
	if ok {
		return 0
	}
	for _, be := range errs {
		if be.Phase == api.BuildPhasePush || be.Phase == api.BuildPhasePlatform {
			return 3
		}
	}
	return 2
}
