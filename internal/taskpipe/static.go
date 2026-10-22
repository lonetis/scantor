package taskpipe

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe/dockerfile"
)

// StaticOptions are the inputs of check-static besides the pack.
type StaticOptions struct {
	// ExpectName is the task name the manifest must carry (rule M9); empty skips the rule.
	ExpectName string
	// AllowPrivileged permits `defaults.privileged: true` (rule M10).
	AllowPrivileged bool
}

// StaticResult is the outcome of check-static. Manifest is nil when the manifest step failed.
type StaticResult struct {
	Manifest *manifest.Result
	Errors   []api.BuildError
	// Warnings are rendered as "<file>:<line>: <message> (<rule>)".
	Warnings []string
	// External are the literal external image references of the Dockerfile (rule D5).
	External []dockerfile.ImageRef
}

// OK reports whether the static checks passed.
func (s *StaticResult) OK() bool { return len(s.Errors) == 0 }

// CheckStatic runs check-static on a pack (docs/tasks.md §9.3): the manifest rules M1–M10, the required
// files of §2 and the Dockerfile policy, in that order, collecting every error of a step before it
// stops.
func CheckStatic(p *Pack, opts StaticOptions, cfg Config) *StaticResult {
	res := &StaticResult{}
	if !res.manifest(p, opts, cfg) {
		return res
	}
	if !res.requiredFiles(p) {
		return res
	}
	res.dockerfile(p, cfg)
	return res
}

func (s *StaticResult) fail(file string, line int, msg string) {
	s.Errors = append(s.Errors, api.BuildError{Phase: api.BuildPhaseStatic, File: file, Line: line, Message: truncateMessage(msg)})
}

func (s *StaticResult) manifest(p *Pack, opts StaticOptions, cfg Config) bool {
	data, err := p.ReadFile(manifest.FileName, manifest.MaxBytes+1)
	var tooLarge *FileTooLargeError
	switch {
	case errors.As(err, &tooLarge):
		s.fail(manifest.FileName, 0, fmt.Sprintf("the manifest is %d bytes; the limit is %d (M1)", tooLarge.Size, manifest.MaxBytes))
		return false
	case errors.Is(err, ErrNotRegular):
		s.fail(manifest.FileName, 0, missingManifestMessage(p))
		return false
	case err != nil:
		s.fail(manifest.FileName, 0, err.Error())
		return false
	}
	result, issues := manifest.Check(data, manifest.Options{
		Limits:          cfg.ManifestLimits,
		ExpectName:      opts.ExpectName,
		AllowPrivileged: opts.AllowPrivileged,
		IsRegularFile:   p.IsRegularFile,
	})
	for _, is := range issues {
		be := is.BuildError()
		be.Message = truncateMessage(be.Message)
		s.Errors = append(s.Errors, be)
	}
	s.Manifest = result
	return len(issues) == 0
}

func missingManifestMessage(p *Pack) string {
	if _, ok := p.Lookup(manifest.FileName); ok {
		return "scantor.yaml must be a regular file"
	}
	if _, ok := p.Lookup("scantor.yml"); ok {
		return "scantor.yaml is missing: rename scantor.yml to scantor.yaml"
	}
	return "scantor.yaml is missing: every task needs a manifest at its root"
}

// requiredFiles checks the Dockerfile of docs/tasks.md §2. The entry of source languages, written or
// defaulted, is checked by manifest rule M4.
func (s *StaticResult) requiredFiles(p *Pack) bool {
	e, ok := p.Lookup(DockerfileName)
	switch {
	case !ok:
		s.fail(DockerfileName, 0, "Dockerfile is missing: every task needs a Dockerfile at its root (FROM ${SCANTOR_BASE})")
	case e.Kind != KindFile:
		s.fail(DockerfileName, 0, "Dockerfile must be a regular file")
	}
	return s.OK()
}

func (s *StaticResult) dockerfile(p *Pack, cfg Config) {
	data, err := p.ReadFile(DockerfileName, dockerfile.MaxBytes+1)
	var tooLarge *FileTooLargeError
	if errors.As(err, &tooLarge) {
		s.fail(DockerfileName, 0, fmt.Sprintf("the Dockerfile is %d bytes; the limit is %d KiB (D1)", tooLarge.Size, dockerfile.MaxBytes>>10))
		return
	}
	if err != nil {
		s.fail(DockerfileName, 0, err.Error())
		return
	}
	policy := dockerfile.Check(data, dockerfile.Options{
		ForbiddenHosts:  cfg.ForbiddenHosts(),
		HasDockerignore: p.IsRegularFile(DockerignoreName),
	})
	for _, is := range policy.Errors {
		s.fail(DockerfileName, is.Line, is.Text())
	}
	for _, is := range policy.Warnings {
		s.Warnings = append(s.Warnings, warningText(is))
	}
	s.External = policy.External
}

func warningText(is dockerfile.Issue) string {
	if is.Rule == "W3" {
		return DockerignoreName + ": " + is.Text()
	}
	if is.Line > 0 {
		return fmt.Sprintf("%s:%d: %s", DockerfileName, is.Line, is.Text())
	}
	return DockerfileName + ": " + is.Text()
}

// hostOfURL returns the lower-case host name (without port) of an absolute URL, or "".
func hostOfURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// hostOfHostPort returns the lower-case host name of "host[:port]", or "".
func hostOfHostPort(hostPort string) string {
	if hostPort == "" {
		return ""
	}
	return hostOfURL("//" + hostPort)
}
