package manifest

import (
	"fmt"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/languages"
)

// ScriptFileName is the exact name of the script manifest at the root of a script folder
// (docs/scripts.md). Its distinct name keeps script folders apart from task folders.
const ScriptFileName = "scantor-script.yaml"

// ScriptSchemaPath is the path of the script manifest schema inside scantor.Schemas.
const ScriptSchemaPath = "schemas/script-manifest.schema.json"

// Fallbacks of the script run resources when neither the run nor the manifest sets them; equal to the
// `default` annotations of schemas/script-manifest.schema.json.
const (
	ScriptDefaultCPUs      = 1
	ScriptDefaultMemoryMiB = 1024
)

// ScriptManifest is the normalised script manifest: the document as written with `entry` defaulted;
// `defaults` keeps the values as written.
type ScriptManifest struct {
	Scantor     int                    `json:"scantor"`
	Name        string                 `json:"name"`
	Language    string                 `json:"language"`
	Description string                 `json:"description,omitempty"`
	Entry       string                 `json:"entry"`
	Defaults    ScriptManifestDefaults `json:"defaults"`
}

// ScriptManifestDefaults are the manifest's default run settings as written; nil means "not set".
type ScriptManifestDefaults struct {
	TimeoutMs *int64                   `json:"timeoutMs,omitempty"`
	Resources *ScriptResourcesDefaults `json:"resources,omitempty"`
}

// ScriptResourcesDefaults are the manifest's resource defaults of a script-run container.
type ScriptResourcesDefaults struct {
	CPUs      *float64 `json:"cpus,omitempty"`
	MemoryMiB *int64   `json:"memoryMiB,omitempty"`
}

// ScriptDefaults are the normalised default run settings of a script. TimeoutMs is nil when the manifest
// sets none: the orchestrator then applies SCANTOR_SCRIPT_RUN_TIMEOUT. Resources carry the fallbacks
// ScriptDefaultCPUs and ScriptDefaultMemoryMiB for the values the manifest leaves out.
type ScriptDefaults struct {
	TimeoutMs *int64        `json:"timeoutMs"`
	Resources api.Resources `json:"resources"`
}

// ScriptResult is a valid script manifest with its derived values.
type ScriptResult struct {
	Manifest ScriptManifest
	// Language is the manifest's language row; its Script is never nil.
	Language languages.Language
	Defaults ScriptDefaults
}

var scriptSchema = &embeddedSchema{path: ScriptSchemaPath}

// scriptRules renames the issues of the steps CheckScript shares with Check.
var scriptRules = map[string]string{"M1": "S1", "M2": "S2"}

// CheckScript parses a script manifest (scantor-script.yaml) and applies rules S1–S6: S1 the size bound
// and YAML parsing of M1, S2 the strict schema schemas/script-manifest.schema.json, S3 a language whose
// languages.json row has a `script` object, S4/S5 the entry rules of M4/M5 with the default entry
// `script.entry`, S6 opts.ExpectName. It returns the result, or nil and every issue of the first
// failing step (S1, then S2, then S3–S6 together). Every issue's File is ScriptFileName, so BuildError
// gives a static-phase error of scantor-script.yaml. Options.Limits and Options.AllowPrivileged do not
// apply to scripts and are ignored.
func CheckScript(data []byte, opts Options) (*ScriptResult, []Issue) {
	var m ScriptManifest
	doc, issues := decode(data, scriptSchema, &m)
	if issues != nil {
		return nil, scriptIssues(issues)
	}
	table, err := languageTable(opts)
	if err != nil {
		return nil, scriptIssues([]Issue{{Rule: "S3", Message: err.Error()}})
	}
	c := checker{doc: doc}
	lang, ok := table.Get(m.Language)
	switch {
	case !ok:
		c.add("S3", "/language", fmt.Sprintf("unknown language %q%s", m.Language, scriptLanguagesHint(table)))
	case !lang.SupportsScripts():
		c.add("S3", "/language", fmt.Sprintf("%s does not support scripts%s", lang.Name, scriptLanguagesHint(table)))
	default:
		c.checkEntry(&m.Entry, lang, scriptEntryRules(lang), opts.IsRegularFile)
	}
	if opts.ExpectName != "" && m.Name != opts.ExpectName {
		c.add("S6", "/name", fmt.Sprintf("name %q does not match script %q; script names are immutable", m.Name, opts.ExpectName))
	}
	if len(c.issues) > 0 {
		return nil, scriptIssues(c.issues)
	}
	return &ScriptResult{Manifest: m, Language: lang, Defaults: scriptDefaults(m.Defaults)}, nil
}

// scriptEntryRules are the entry rules S4/S5 of scantor-script.yaml; lang must support scripts.
func scriptEntryRules(lang languages.Language) entryRules {
	return entryRules{defaultEntry: lang.Script.Entry, sourceRule: "S4", binaryRule: "S5", kind: "script", file: ScriptFileName}
}

// scriptIssues gives the issues of the shared steps their script rule ids and every issue the script
// manifest's file name.
func scriptIssues(issues []Issue) []Issue {
	for i := range issues {
		if rule, ok := scriptRules[issues[i].Rule]; ok {
			issues[i].Rule = rule
		}
		issues[i].File = ScriptFileName
	}
	return issues
}

// scriptLanguagesHint names the languages with script support for messages ("; scripts can be written
// in python"), or "" when there is none.
func scriptLanguagesHint(table *languages.Table) string {
	var names []string
	for _, l := range table.WithScripts() {
		names = append(names, l.Name)
	}
	if len(names) == 0 {
		return ""
	}
	return "; scripts can be written in " + joinOr(names)
}

func scriptDefaults(d ScriptManifestDefaults) ScriptDefaults {
	out := ScriptDefaults{TimeoutMs: d.TimeoutMs, Resources: api.Resources{CPUs: ScriptDefaultCPUs, MemoryMiB: ScriptDefaultMemoryMiB}}
	if r := d.Resources; r != nil {
		if r.CPUs != nil {
			out.Resources.CPUs = *r.CPUs
		}
		if r.MemoryMiB != nil {
			out.Resources.MemoryMiB = *r.MemoryMiB
		}
	}
	return out
}
