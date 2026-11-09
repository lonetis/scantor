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

// ScriptStaticOptions are the inputs of the static checks of a script folder besides the pack.
type ScriptStaticOptions struct {
	// ExpectName is the script name the manifest must carry (rule S6); empty skips the rule.
	ExpectName string
}

// StaticResult is the outcome of check-static. Manifest (task) or Script (script) is nil when the
// manifest step failed; the other one is always nil.
type StaticResult struct {
	Manifest *manifest.Result
	Script   *manifest.ScriptResult
	Errors   []api.BuildError
	// Warnings are rendered as "<file>:<line>: <message> (<rule>)".
	Warnings []string
	// External are the literal external image references of the Dockerfile (rule D5).
	External []dockerfile.ImageRef
}

// OK reports whether the static checks passed.
func (s *StaticResult) OK() bool { return len(s.Errors) == 0 }

// folderKind is what the static checks of a task folder and of a script folder do differently: the
// manifest file, its checker and the wording of messages. Everything else is shared.
type folderKind struct {
	// noun names the folder kind in messages ("task", "script").
	noun string
	// manifestFile is the manifest at the folder's root.
	manifestFile string
	// sizeRule is the rule of the manifest size bound (M1, S1).
	sizeRule string
	// missing explains a manifest that is absent or not a regular file.
	missing func(p *Pack) string
}

var (
	taskFolder   = folderKind{noun: "task", manifestFile: manifest.FileName, sizeRule: "M1", missing: missingManifestMessage}
	scriptFolder = folderKind{noun: "script", manifestFile: manifest.ScriptFileName, sizeRule: "S1", missing: missingScriptManifestMessage}
)

// CheckStatic runs check-static on a pack (docs/tasks.md §9.3): the manifest rules M1–M10, the required
// files of §2 and the Dockerfile policy, in that order, collecting every error of a step before it
// stops.
func CheckStatic(p *Pack, opts StaticOptions, cfg Config) *StaticResult {
	res := &StaticResult{}
	res.check(p, cfg, taskFolder, func(data []byte) []manifest.Issue {
		result, issues := manifest.Check(data, manifest.Options{
			Limits:          cfg.ManifestLimits,
			ExpectName:      opts.ExpectName,
			AllowPrivileged: opts.AllowPrivileged,
			IsRegularFile:   p.IsRegularFile,
		})
		res.Manifest = result
		return issues
	})
	return res
}

// CheckScriptStatic runs the static checks of a script folder on a pack (docs/scripts.md): the script
// manifest rules S1–S6 of scantor-script.yaml, the required files and the Dockerfile policy of tasks,
// in that order, collecting every error of a step before it stops.
func CheckScriptStatic(p *Pack, opts ScriptStaticOptions, cfg Config) *StaticResult {
	res := &StaticResult{}
	res.check(p, cfg, scriptFolder, func(data []byte) []manifest.Issue {
		result, issues := manifest.CheckScript(data, manifest.Options{ExpectName: opts.ExpectName, IsRegularFile: p.IsRegularFile})
		res.Script = result
		return issues
	})
	return res
}

// check runs the three steps; checkManifest validates the manifest's content and records the result.
func (s *StaticResult) check(p *Pack, cfg Config, kind folderKind, checkManifest func(data []byte) []manifest.Issue) {
	if !s.manifest(p, kind, checkManifest) {
		return
	}
	if !s.requiredFiles(p, kind) {
		return
	}
	s.dockerfile(p, cfg)
}

func (s *StaticResult) fail(file string, line int, msg string) {
	s.Errors = append(s.Errors, api.BuildError{Phase: api.BuildPhaseStatic, File: file, Line: line, Message: truncateMessage(msg)})
}

func (s *StaticResult) manifest(p *Pack, kind folderKind, checkManifest func(data []byte) []manifest.Issue) bool {
	data, err := p.ReadFile(kind.manifestFile, manifest.MaxBytes+1)
	var tooLarge *FileTooLargeError
	switch {
	case errors.As(err, &tooLarge):
		s.fail(kind.manifestFile, 0, fmt.Sprintf("the manifest is %d bytes; the limit is %d (%s)", tooLarge.Size, manifest.MaxBytes, kind.sizeRule))
		return false
	case errors.Is(err, ErrNotRegular):
		s.fail(kind.manifestFile, 0, kind.missing(p))
		return false
	case err != nil:
		s.fail(kind.manifestFile, 0, err.Error())
		return false
	}
	issues := checkManifest(data)
	for _, is := range issues {
		be := is.BuildError()
		be.Message = truncateMessage(be.Message)
		s.Errors = append(s.Errors, be)
	}
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

func missingScriptManifestMessage(p *Pack) string {
	const name = manifest.ScriptFileName
	if _, ok := p.Lookup(name); ok {
		return name + " must be a regular file"
	}
	if _, ok := p.Lookup("scantor-script.yml"); ok {
		return name + " is missing: rename scantor-script.yml to " + name
	}
	if p.IsRegularFile(manifest.FileName) {
		return name + " is missing: this folder has a task manifest (scantor.yaml); every script needs " + name + " at its root"
	}
	return name + " is missing: every script needs a manifest at its root"
}

// requiredFiles checks the Dockerfile of docs/tasks.md §2, which scripts need too. The entry of source
// languages, written or defaulted, is checked by the manifest rules (M4, S4).
func (s *StaticResult) requiredFiles(p *Pack, kind folderKind) bool {
	e, ok := p.Lookup(DockerfileName)
	switch {
	case !ok:
		s.fail(DockerfileName, 0, fmt.Sprintf("Dockerfile is missing: every %s needs a Dockerfile at its root (FROM ${SCANTOR_BASE})", kind.noun))
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
