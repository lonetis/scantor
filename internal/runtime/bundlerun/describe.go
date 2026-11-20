package bundlerun

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/version"
)

// HardeningFlags are the docker run flags of the hardened bundle run (docs/runtime.md §15.7, the guide): no
// capabilities beyond those the runtime needs to give the results to the folder's owner, no privilege
// escalation and a bound on processes. NET_RAW is for tasks that need it only; --network none for tasks
// without network access.
const HardeningFlags = "--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --security-opt no-new-privileges --pids-limit 4096"

// Description is the -o json output of --describe.
type Description struct {
	Bundle         DescribedBundle `json:"bundle"`
	TaskConfig     json.RawMessage `json:"taskConfig"`
	ScanConfig     json.RawMessage `json:"scanConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
	Settings       bundle.Settings `json:"settings"`
	Schemas        DescribedSchema `json:"schemas"`
	SecretPaths    api.SecretPaths `json:"secretPaths"`
	UploadPaths    api.UploadPaths `json:"uploadPaths"`
	Recommended    Recommended     `json:"recommended"`
	Issues         []api.Issue     `json:"issues"`
}

// DescribedBundle identifies the bundle.
type DescribedBundle struct {
	Image          string       `json:"image"`
	Ref            string       `json:"ref"`
	Language       string       `json:"language"`
	Platform       api.Platform `json:"platform"`
	Schedule       api.Schedule `json:"schedule"`
	ScantorVersion string       `json:"scantorVersion"`
}

// DescribedSchema holds the config schemas a recipient writes configs for.
type DescribedSchema struct {
	TaskConfig json.RawMessage `json:"taskConfig"`
	ScanConfig json.RawMessage `json:"scanConfig"`
}

// Recommended are the container limits of the run: those of a worker with the run's processes (one more
// for a custom schedule, whose process runs beside them), and the docker run flags with the hardening.
type Recommended struct {
	CPUs        float64 `json:"cpus"`
	MemoryBytes int64   `json:"memoryBytes"`
	DockerFlags string  `json:"dockerFlags"`
}

// recommended returns the recommended limits of a run with these settings.
func recommended(settings bundle.Settings, custom bool) Recommended {
	processes := settings.Processes
	if custom {
		processes++
	}
	memory, nanoCPUs := container.WorkerResources(processes, settings.Resources)
	cpus := float64(nanoCPUs) / 1e9
	return Recommended{
		CPUs: cpus, MemoryBytes: memory,
		DockerFlags: fmt.Sprintf("%s --cpus %s --memory %dm", HardeningFlags, strconv.FormatFloat(cpus, 'f', -1, 64), memory>>20),
	}
}

// describe prints the bundle, the effective configs (secrets masked) and settings, the secret and upload
// paths, the schemas, the recommended limits and the issues. It writes no files and returns 2 when there
// are issues, else 0.
func (o *Options) describe(p *prepared, issues []api.Issue) int {
	m := masker{paths: o.Info.Description.SecretPaths}
	d := Description{
		Bundle: DescribedBundle{
			Image: o.Info.Image, Ref: o.Info.Ref, Language: o.Info.Language, Platform: o.Info.Platform,
			Schedule: o.Info.Description.Schedule, ScantorVersion: version.Version,
		},
		TaskConfig:     m.taskConfig(p.taskConfig),
		ScanConfig:     m.scanConfig(p.scanConfig),
		AnalysisConfig: m.analysisConfig(p.analysisConfig),
		Settings:       p.settings,
		Schemas:        DescribedSchema{TaskConfig: o.Info.Description.Schemas.TaskConfig, ScanConfig: o.Info.Description.Schemas.ScanConfig},
		SecretPaths:    o.Info.Description.SecretPaths,
		UploadPaths:    o.Info.Description.UploadPaths,
		Recommended:    recommended(p.settings, p.custom),
		Issues:         issues,
	}
	if d.Issues == nil {
		d.Issues = []api.Issue{}
	}
	code := local.ExitOK
	if len(issues) > 0 {
		code = local.ExitValidation
	}
	var err error
	if o.JSON {
		err = writeJSON(o.Stdout, d)
	} else {
		err = o.describeHuman(o.Stdout, d)
	}
	if err != nil {
		return local.ExitPlatform
	}
	return code
}

func (o *Options) describeHuman(w io.Writer, d Description) error {
	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	block := func(title string, raw json.RawMessage) {
		if raw == nil {
			line("%s: (none)", title)
			return
		}
		line("%s:", title)
		var buf bytes.Buffer
		if err := json.Indent(&buf, raw, "  ", "  "); err != nil {
			line("  %s", raw)
			return
		}
		line("  %s", buf.String())
	}
	paths := func(list []string) string {
		if len(list) == 0 {
			return "none"
		}
		return strings.Join(list, ", ")
	}
	line("bundle:   %s (%s)", d.Bundle.Ref, d.Bundle.Image)
	line("language: %s", d.Bundle.Language)
	line("platform: %s", platformText(d.Bundle.Platform))
	line("schedule: %s", scheduleText(d.Bundle.Schedule))
	line("")
	block("task config (effective)", d.TaskConfig)
	block("scan config (effective)", d.ScanConfig)
	if d.AnalysisConfig == nil {
		line("analysis config: not given (the schedule makes the analysis configs; --analysis-config runs one)")
	} else {
		block("analysis config (effective)", d.AnalysisConfig)
	}
	s := d.Settings
	line("settings: processes %d, timeoutMs %d, maxAttempts %d, backoff {initialMs %d, factor %s, maxMs %d, jitter %t}, maxAnalysesPerProcess %d",
		s.Processes, s.TimeoutMs, s.MaxAttempts, s.Backoff.InitialMs, strconv.FormatFloat(s.Backoff.Factor, 'f', -1, 64), s.Backoff.MaxMs, s.Backoff.Jitter, s.MaxAnalysesPerProcess)
	line("")
	line("secret paths (shown as %s): task config %s; scan config %s; analysis config %s; result %s", secretMask,
		paths(d.SecretPaths.TaskConfig), paths(d.SecretPaths.ScanConfig), paths(d.SecretPaths.AnalysisConfig), paths(d.SecretPaths.Result))
	line("upload paths (give the path of a file in the mounted folder): task config %s; scan config %s",
		paths(d.UploadPaths.TaskConfig), paths(d.UploadPaths.ScanConfig))
	line("")
	block("task config schema", d.Schemas.TaskConfig)
	block("scan config schema", d.Schemas.ScanConfig)
	line("")
	line("recommended: %s cpus, %d MiB memory per container", strconv.FormatFloat(d.Recommended.CPUs, 'f', -1, 64), d.Recommended.MemoryBytes>>20)
	line("  docker run --rm -v \"$PWD:%s\" %s %s", o.WorkDir, d.Recommended.DockerFlags, d.Bundle.Image)
	line("  add --cap-add NET_RAW only for tasks that need it, and --network none for tasks without network access;")
	line("  the task can read the mounted folder, so run it in a folder of its own")
	if len(d.Issues) > 0 {
		line("")
		line("issues:")
		for _, is := range d.Issues {
			line("  %s: %s", is.Path, is.Message)
		}
	}
	_, err := io.WriteString(w, terminalSafeBlock(b.String()))
	return err
}

// terminalSafeBlock is terminalSafe for text of several lines.
func terminalSafeBlock(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = terminalSafe(l)
	}
	return strings.Join(lines, "\n")
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
