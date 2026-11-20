package bundlerun

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/schema"
	"github.com/lonetis/scantor/internal/templates"
)

// prepared is a bundle run after its checks (docs/runtime.md §15.7): the effective configs, the merged
// settings, the local files given at upload fields and the run directory.
type prepared struct {
	// taskConfig, scanConfig and analysisConfig are effective (defaults filled) and unmasked; nil when
	// they could not be read. analysisConfig is nil unless --analysis-config was given, and the scan
	// config is then {} unless --scan-config was given too.
	taskConfig, scanConfig, analysisConfig json.RawMessage
	settings                               bundle.Settings
	uploads                                []Upload
	// custom reports a connector schedule, which keeps its own process (processes + 1).
	custom bool
	// outDir and owner are set only for a run (not for --describe). For the default run directory
	// (defaultOut), outDir is its base name until the run claims a free name (claimOutDir).
	outDir     string
	defaultOut bool
	owner      *local.FileOwner
}

// prepare reads the flags, substitutes the upload files, fills and checks the configs and the settings and,
// unless the run only describes, checks the run directory. It writes nothing; every issue is a usage
// error (exit 2).
func (o *Options) prepare() (*prepared, []api.Issue) {
	f, desc := o.Flags, o.Info.Description
	p := &prepared{}
	var issues []api.Issue
	add := func(is ...api.Issue) { issues = append(issues, is...) }
	addPtr := func(is *api.Issue) {
		if is != nil {
			issues = append(issues, *is)
		}
	}

	if f.Limit < 0 {
		addPtr(issue("--"+FlagLimit, "must not be negative"))
	}
	if f.TotalTimeout < 0 {
		addPtr(issue("--"+FlagTotalTimeout, "must not be negative"))
	}
	switch f.LogTails {
	case "", LogTailsFailed, LogTailsAll, LogTailsNone:
	default:
		addPtr(issue("--"+FlagLogTails, "must be %s, %s or %s", LogTailsFailed, LogTailsAll, LogTailsNone))
	}
	stdin := 0
	for _, v := range []string{f.TaskConfig, f.ScanConfig, f.AnalysisConfig, f.Settings} {
		if v == "-" {
			stdin++
		}
	}
	if stdin > 1 {
		addPtr(issue("stdin", "can be the value of one flag only (-)"))
	}

	read := func(flag, value string) (json.RawMessage, bool) {
		raw, is := o.readObject(flag, value)
		addPtr(is)
		return raw, is == nil
	}
	task, taskOK := read(FlagTaskConfig, f.TaskConfig)
	scan, scanOK := read(FlagScanConfig, f.ScanConfig)
	analysis, analysisOK := read(FlagAnalysisConfig, f.AnalysisConfig)
	settings, _ := read(FlagSettings, f.Settings)

	// Upload fields name local files: their ids replace the paths before validation.
	reported := map[string]bool{}
	substitute := func(kind string, raw json.RawMessage, pointers []string) json.RawMessage {
		out, uploads, is := o.substituteUploads(kind, raw, pointers)
		p.uploads = append(p.uploads, uploads...)
		for _, i := range is {
			reported[i.Path] = true
		}
		add(is...)
		return out
	}
	task = substitute("taskConfig", task, desc.UploadPaths.TaskConfig)
	scan = substitute("scanConfig", scan, desc.UploadPaths.ScanConfig)

	effective := func(kind string, schemaDoc, raw json.RawMessage, secrets, uploads []string) (json.RawMessage, bool) {
		filled, is, err := schema.Effective(schemaDoc, raw)
		if err != nil {
			add(api.Issue{Path: "/" + kind, Message: fmt.Sprintf("the bundle's %s schema cannot be used: %v", kind, err)})
			return nil, false
		}
		add(configIssues(kind, is, secrets)...)
		masked := maskedSecrets(kind, filled, secrets)
		foreign := foreignUploads(kind, filled, uploads, p.uploads, reported)
		add(masked...)
		add(foreign...)
		return filled, len(is) == 0 && len(masked) == 0 && len(foreign) == 0
	}
	if taskOK {
		p.taskConfig, _ = effective("taskConfig", desc.Schemas.TaskConfig, task, desc.SecretPaths.TaskConfig, desc.UploadPaths.TaskConfig)
	}
	scanValid := false
	if f.AnalysisConfig != "" {
		// The schedule is skipped: the scan config matters only when it was given.
		if analysisOK {
			p.analysisConfig, _ = effective("analysisConfig", desc.Schemas.AnalysisConfig, analysis, desc.SecretPaths.AnalysisConfig, nil)
		}
		p.scanConfig = json.RawMessage(`{}`)
		if f.ScanConfig != "" {
			p.scanConfig = nil
			if scanOK {
				p.scanConfig, _ = effective("scanConfig", desc.Schemas.ScanConfig, scan, desc.SecretPaths.ScanConfig, desc.UploadPaths.ScanConfig)
			}
		}
	} else {
		p.custom = desc.Schedule.Kind == api.ScheduleKindCustom
		if scanOK {
			p.scanConfig, scanValid = effective("scanConfig", desc.Schemas.ScanConfig, scan, desc.SecretPaths.ScanConfig, desc.UploadPaths.ScanConfig)
		}
	}
	// An unwrapped template checks its scan config itself as well (defaults and Validate), as the
	// scheduler does before it resolves.
	if scanValid && desc.Schedule.Kind == api.ScheduleKindTemplate {
		name := desc.Schedule.Template
		if name == "" {
			name = templates.Single
		}
		if def, ok := templates.Lookup(name); !ok {
			add(api.Issue{Path: "/scanConfig", Message: fmt.Sprintf("the bundle's template %q is unknown to this runtime", name)})
		} else if eff, is, err := def.Effective(p.scanConfig); err != nil {
			add(api.Issue{Path: "/scanConfig", Message: err.Error()})
		} else if len(is) > 0 {
			for _, i := range is {
				add(api.Issue{Path: "/scanConfig" + i.Path, Message: i.Message})
			}
		} else {
			p.scanConfig = eff
		}
	}

	var settingIssues []api.Issue
	p.settings, settingIssues = mergeSettings(o.Info.Settings, settings, f.Processes, o.Info.Limits.MaxProcesses)
	add(settingIssues...)

	if !f.Describe {
		p.outDir, p.defaultOut = o.outDir(), f.Out == ""
		add(o.checkOutDir(p.outDir, !p.defaultOut)...)
		p.owner = o.fileOwner(p.outDir, os.Geteuid())
	}
	return p, issues
}

// configIssues turns the schema issues of a config into issues below /<kind>, with the offending property in
// the path for unknown and missing properties, as the platform reports them. An issue at or below a secret
// path gets a message without the value: the messages of pattern, format and others quote it.
func configIssues(kind string, issues []schema.Issue, secrets []string) []api.Issue {
	var out []api.Issue
	for _, i := range issues {
		base := "/" + kind + i.Path
		switch {
		case i.Keyword == schema.KeywordInstance:
			out = append(out, api.Issue{Path: "/" + kind, Message: i.Message})
		case !valueFreeKeywords[i.Keyword] && underSecret(i.Path, secrets):
			out = append(out, api.Issue{Path: base, Message: secretIssueMessage(i.Keyword)})
		case i.Keyword == "additionalProperties" && len(i.Properties) > 0:
			for _, prop := range i.Properties {
				out = append(out, api.Issue{Path: base + "/" + schema.EscapePointer(prop), Message: "is not allowed (unknown property)"})
			}
		case i.Keyword == "required" && len(i.Properties) > 0:
			for _, prop := range i.Properties {
				out = append(out, api.Issue{Path: base + "/" + schema.EscapePointer(prop), Message: "is required"})
			}
		default:
			out = append(out, api.Issue{Path: base, Message: i.Message})
		}
	}
	return out
}

// spec is the local-mode spec of the run (docs/runtime.md §15.7 step 5).
func (o *Options) spec(p *prepared) *local.Spec {
	l := o.Info.Limits
	totalMs := o.Flags.TotalTimeout.Milliseconds()
	if o.Flags.TotalTimeout > 0 {
		totalMs = max(totalMs, 1)
	}
	return &local.Spec{
		V: local.SpecVersion, RunID: RunID, Entry: o.Info.Entry,
		TaskConfig: p.taskConfig, ScanConfig: p.scanConfig, AnalysisConfig: p.analysisConfig,
		Limit: o.Flags.Limit, Processes: p.settings.Processes, TimeoutMs: p.settings.TimeoutMs,
		MaxAttempts: p.settings.MaxAttempts, Backoff: p.settings.Backoff, MaxAnalysesPerProcess: p.settings.MaxAnalysesPerProcess,
		TotalTimeoutMs: totalMs,
		DataSources:    dataSources(o.Config.DataSources),
		Uploads:        localUploads(p.uploads),
		Resolved:       map[string]api.Resolution{},
		Limits: local.SpecLimits{
			MaxAnalysisConfigBytes: l.MaxAnalysisConfigBytes, MaxResultBytes: l.MaxResultBytes, MaxFileBytes: l.MaxFileBytes,
			MaxFilesPerAnalysis: l.MaxFilesPerAnalysis, LogTailBytes: l.LogTailBytes, LogTailEarlierBytes: l.LogTailEarlierBytes,
		},
		OutDir: p.outDir,
	}
}

// dataSources fills the data sources the recipient did not set with the compiled-in defaults.
func dataSources(set api.DataSources) api.DataSources {
	if set.Tranco == "" {
		set.Tranco = templates.DefaultTrancoURL
	}
	if set.Crux == "" {
		set.Crux = templates.DefaultCruxURL
	}
	if set.CruxCache == "" {
		set.CruxCache = templates.DefaultCruxCacheURL
	}
	return set
}
