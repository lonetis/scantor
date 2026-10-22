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
func (r *Result) ExitCode() int {
	if r.OK {
		return 0
	}
	for _, be := range r.Errors {
		if be.Phase == api.BuildPhasePush || be.Phase == api.BuildPhasePlatform {
			return 3
		}
	}
	return 2
}
