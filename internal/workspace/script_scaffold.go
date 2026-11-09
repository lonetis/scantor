package workspace

import (
	"fmt"
	"slices"
	"strings"

	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/version"
)

// scriptManifestSchemaURL is the schema of the scantor-script.yaml modeline.
const scriptManifestSchemaURL = "https://raw.githubusercontent.com/lonetis/scantor/%s/schemas/script-manifest.schema.json"

// ScriptScaffoldRequest selects the script scaffold to render (docs/scripts.md): the languages.json row's
// `script.scaffold` directory, without a template choice.
type ScriptScaffoldRequest struct {
	Name        string
	Description string
	Language    string
	// Images is the image-reference override for the base image the scaffold mentions.
	Images version.ImageOverride
}

// ScriptManifestSchemaURL returns the schema URL of the script manifest modeline for a scantor version.
func ScriptManifestSchemaURL(v string) string {
	return fmt.Sprintf(scriptManifestSchemaURL, repositoryRef(v))
}

// RenderScriptScaffold renders the embedded script scaffold of req.Language into memory: every file of
// <script.scaffold>/files/ (*.tmpl rendered like task scaffolds), and checks the rendered
// scantor-script.yaml with manifest.CheckScript including the existence of the entry. Invalid names,
// languages without script support and invalid descriptions are invalidArgument.
func RenderScriptScaffold(req ScriptScaffoldRequest) ([]ScaffoldFile, error) {
	if err := ValidateScriptName(req.Name); err != nil {
		return nil, err
	}
	table, err := languages.Load()
	if err != nil {
		return nil, internalError(err, "load the language table")
	}
	lang, ok := table.Get(req.Language)
	if !ok || !lang.SupportsScripts() {
		var names []string
		for _, l := range table.WithScripts() {
			names = append(names, l.Name)
		}
		return nil, invalidArgument("language %q does not support scripts; use one of %s", printable(req.Language), strings.Join(names, ", "))
	}
	data := ScaffoldData{
		Name:              req.Name,
		Description:       req.Description,
		Language:          lang.Name,
		Version:           version.Version,
		BaseImage:         lang.BaseImageRef(req.Images),
		ManifestSchemaURL: ScriptManifestSchemaURL(version.Version),
		GuideURL:          fmt.Sprintf(repositoryFileURL, repositoryRef(version.Version), lang.Script.Guide),
	}
	files, err := renderFiles(lang.Script.Scaffold, data)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(files, func(a, b ScaffoldFile) int { return strings.Compare(a.Path, b.Path) })
	if err := checkScriptScaffoldManifest(files, table); err != nil {
		return nil, err
	}
	return files, nil
}

// checkScriptScaffoldManifest validates the rendered scantor-script.yaml (rules S1–S5, including the
// existence of the entry).
func checkScriptScaffoldManifest(files []ScaffoldFile, table *languages.Table) error {
	idx := slices.IndexFunc(files, func(f ScaffoldFile) bool { return f.Path == manifest.ScriptFileName })
	if idx < 0 {
		return newError(CodeInternal, "the script scaffold has no %s", manifest.ScriptFileName)
	}
	_, issues := manifest.CheckScript(files[idx].Content, manifest.Options{
		Languages: table,
		IsRegularFile: func(p string) bool {
			return slices.ContainsFunc(files, func(f ScaffoldFile) bool { return f.Path == p })
		},
	})
	if len(issues) == 0 {
		return nil
	}
	msgs := make([]string, len(issues))
	for i, is := range issues {
		msgs[i] = is.Message
	}
	return invalidArgument("the script scaffold manifest is invalid: %s", strings.Join(msgs, "; "))
}
