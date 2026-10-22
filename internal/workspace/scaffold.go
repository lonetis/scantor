package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path"
	"slices"
	"strings"
	"text/template"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/version"
)

// Scaffold rendering (docs/tasks.md §12.1): scaffolds/<language>/files/ is copied into the task root
// (*.tmpl files are rendered and lose the suffix, so go.mod.tmpl becomes go.mod) and
// scaffolds/<language>/entry/<template><ext>.tmpl is rendered to the default entry. Templates use
// text/template with [[ ]] delimiters, builtins only, and fail on missing keys.
const (
	// DefaultTemplate is the template of a scaffold when none is given.
	DefaultTemplate = "single"
	// CustomTemplate is the scaffold choice with a custom schedule.
	CustomTemplate = "custom"

	templateSuffix    = ".tmpl"
	templateSchemas   = "schemas/templates"
	manifestSchemaURL = "https://raw.githubusercontent.com/lonetis/scantor/%s/schemas/task-manifest.schema.json"
)

// Files of the host OS that never belong to a scaffold (a native macOS build embeds them when present).
var scaffoldJunk = []string{".DS_Store"}

// ScaffoldRequest selects what to render.
type ScaffoldRequest struct {
	Name        string
	Language    string
	Template    string
	Description string
	// Images is the image-reference override for the base image of .devcontainer/devcontainer.json.
	Images version.ImageOverride
}

// ScaffoldData is the data of every scaffold template.
type ScaffoldData struct {
	Name              string
	Description       string
	Language          string
	Template          string
	Version           string
	BaseImage         string
	ManifestSchemaURL string
}

// ScaffoldFile is one rendered file, relative to the task root.
type ScaffoldFile struct {
	Path    string
	Content []byte
}

// ScaffoldResult is the output of the scaffold operation.
type ScaffoldResult struct {
	Workspace Summary `json:"workspace"`
}

// Templates returns the scaffold choices: every template of schemas/templates/ plus "custom", sorted.
func Templates() ([]string, error) {
	entries, err := fs.ReadDir(scantor.Schemas, templateSchemas)
	if err != nil {
		return nil, fmt.Errorf("read embedded %s: %w", templateSchemas, err)
	}
	var names []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".fixtures.json") {
			continue
		}
		names = append(names, strings.TrimSuffix(name, ".json"))
	}
	names = append(names, CustomTemplate)
	slices.Sort(names)
	return names, nil
}

// ManifestSchemaURL returns the schema URL of the manifest modeline for a scantor version: the release
// tag for releases, main for development builds.
func ManifestSchemaURL(v string) string {
	ref := "main"
	if version.IsRelease(v) {
		ref = "v" + v
	}
	return fmt.Sprintf(manifestSchemaURL, ref)
}

// EntryFile returns the file a scaffold renders the entry template to: the language's entry for source
// languages, main.<ext> for binary languages (Go: main.go).
func EntryFile(lang languages.Language) string {
	if lang.IsSource() {
		return lang.Entry
	}
	return "main" + lang.Extensions[0]
}

// RenderScaffold renders the embedded scaffold of req.Language with req.Template into memory and checks
// that the result is a valid manifest. Invalid names, languages, templates and descriptions are
// invalidArgument.
func RenderScaffold(req ScaffoldRequest) ([]ScaffoldFile, error) {
	if err := ValidateTaskName(req.Name); err != nil {
		return nil, err
	}
	table, err := languages.Load()
	if err != nil {
		return nil, internalError(err, "load the language table")
	}
	lang, ok := table.Get(req.Language)
	if !ok {
		return nil, invalidArgument("unknown language %q; use one of %s", printable(req.Language), strings.Join(table.Names(), ", "))
	}
	if req.Template == "" {
		req.Template = DefaultTemplate
	}
	templates, err := Templates()
	if err != nil {
		return nil, internalError(err, "list templates")
	}
	if !slices.Contains(templates, req.Template) {
		return nil, invalidArgument("unknown template %q; use one of %s", printable(req.Template), strings.Join(templates, ", "))
	}
	data := ScaffoldData{
		Name:              req.Name,
		Description:       req.Description,
		Language:          lang.Name,
		Template:          req.Template,
		Version:           version.Version,
		BaseImage:         lang.BaseImageRef(req.Images),
		ManifestSchemaURL: ManifestSchemaURL(version.Version),
	}
	files, err := renderFiles(lang.Scaffold, data)
	if err != nil {
		return nil, err
	}
	entry := EntryFile(lang)
	entryTemplate := path.Join(lang.Scaffold, "entry", req.Template+path.Ext(entry)+templateSuffix)
	content, err := renderTemplate(entryTemplate, data)
	if err != nil {
		return nil, err
	}
	if slices.ContainsFunc(files, func(f ScaffoldFile) bool { return f.Path == entry }) {
		return nil, newError(CodeInternal, "scaffold %s contains the entry %s in files/", lang.Scaffold, entry)
	}
	files = append(files, ScaffoldFile{Path: entry, Content: content})
	slices.SortFunc(files, func(a, b ScaffoldFile) int { return strings.Compare(a.Path, b.Path) })
	if err := checkScaffoldManifest(files); err != nil {
		return nil, err
	}
	return files, nil
}

// renderFiles renders scaffolds/<language>/files/.
func renderFiles(dir string, data ScaffoldData) ([]ScaffoldFile, error) {
	base := path.Join(dir, "files")
	var files []ScaffoldFile
	err := fs.WalkDir(scantor.Scaffolds, base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "read embedded scaffold %s", p)
		}
		if d.IsDir() || slices.Contains(scaffoldJunk, d.Name()) {
			return nil
		}
		rel := strings.TrimPrefix(p, base+"/")
		if !strings.HasSuffix(rel, templateSuffix) {
			content, err := fs.ReadFile(scantor.Scaffolds, p)
			if err != nil {
				return internalError(err, "read embedded scaffold %s", p)
			}
			files = append(files, ScaffoldFile{Path: rel, Content: content})
			return nil
		}
		content, err := renderTemplate(p, data)
		if err != nil {
			return err
		}
		files = append(files, ScaffoldFile{Path: strings.TrimSuffix(rel, templateSuffix), Content: content})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, newError(CodeInternal, "the embedded scaffold %s is empty", dir)
	}
	return files, nil
}

func renderTemplate(name string, data ScaffoldData) ([]byte, error) {
	src, err := fs.ReadFile(scantor.Scaffolds, name)
	if err != nil {
		return nil, internalError(err, "read embedded scaffold template %s", name)
	}
	tmpl, err := template.New(path.Base(name)).Delims("[[", "]]").Option("missingkey=error").Parse(string(src))
	if err != nil {
		return nil, internalError(err, "parse scaffold template %s", name)
	}
	var out bytes.Buffer
	if err := tmpl.Execute(&out, data); err != nil {
		return nil, internalError(err, "render scaffold template %s", name)
	}
	return out.Bytes(), nil
}

// checkScaffoldManifest validates the rendered scantor.yaml (schema and semantic rules, including the
// existence of the entry). Instance limits and the privileged permission do not apply to a scaffold.
func checkScaffoldManifest(files []ScaffoldFile) error {
	idx := slices.IndexFunc(files, func(f ScaffoldFile) bool { return f.Path == manifest.FileName })
	if idx < 0 {
		return newError(CodeInternal, "the scaffold has no %s", manifest.FileName)
	}
	_, issues := manifest.Check(files[idx].Content, manifest.Options{
		Limits:          manifest.Limits{MaxWorkersPerScan: math.MaxInt32, MaxProcessesPerWorker: math.MaxInt32},
		AllowPrivileged: true,
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
	return invalidArgument("the scaffold manifest is invalid: %s", strings.Join(msgs, "; "))
}

// scaffoldUsage counts the rendered files and the directories that hold them.
func scaffoldUsage(files []ScaffoldFile) treeUsage {
	var u treeUsage
	dirs := map[string]bool{}
	for _, f := range files {
		u.add(int64(len(f.Content)))
		for dir := path.Dir(f.Path); dir != "." && !dirs[dir]; dir = path.Dir(dir) {
			dirs[dir] = true
			u.add(0)
		}
	}
	return u
}

// writeScaffold writes rendered files below root: directories 0755, files 0644, never through a symlink
// and never over an existing file.
func writeScaffold(root *os.Root, files []ScaffoldFile) error {
	for _, f := range files {
		if err := mkdirAllNoFollow(root, path.Dir(f.Path)); err != nil {
			return err
		}
		out, err := root.OpenFile(f.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, fileMode)
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				return newError(CodeExists, "%s already exists", f.Path)
			}
			return internalError(err, "create %s", f.Path)
		}
		if _, err := out.Write(f.Content); err != nil {
			_ = out.Close() // the write error is the one to report
			return internalError(err, "write %s", f.Path)
		}
		if err := out.Chmod(fileMode); err != nil {
			_ = out.Close() // the chmod error is the one to report
			return internalError(err, "chmod %s", f.Path)
		}
		if err := out.Close(); err != nil {
			return internalError(err, "close %s", f.Path)
		}
	}
	return nil
}

// Scaffold renders the scaffold into the task folder req.Name, which must not exist or be empty
// (docs/editor.md §9.4 scaffold). The files are written to a staging tree first and renamed into
// place, so a crash never leaves a half-written folder.
func (w *Workspace) Scaffold(ctx context.Context, req ScaffoldRequest) (*ScaffoldResult, error) {
	files, err := RenderScaffold(req)
	if err != nil {
		return nil, err
	}
	info, err := w.taskInfo(req.Name)
	if err != nil {
		return nil, err
	}
	if info != nil {
		entries, err := fs.ReadDir(w.root.FS(), req.Name)
		if err != nil {
			return nil, internalError(err, "read task folder %s", req.Name)
		}
		if len(entries) > 0 {
			return nil, newError(CodeExists, "the task folder %q already exists and is not empty", req.Name)
		}
	}
	u := scaffoldUsage(files)
	if err := checkTaskCaps(w.limits, u); err != nil {
		return nil, err
	}
	wsBytes, err := w.workspaceBytes(ctx)
	if err != nil {
		return nil, err
	}
	if err := w.checkWorkspaceCap(wsBytes + u.Bytes); err != nil {
		return nil, err
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	if err := w.createStaging(id); err != nil {
		return nil, err
	}
	defer func() {
		if err := w.removeStaging(id); err != nil {
			w.events.Warnf("%v", err)
		}
	}()
	tree, _, err := w.openStagingTree(id, "")
	if err != nil {
		return nil, err
	}
	if err := closeRoot(tree, writeScaffold(tree, files)); err != nil {
		return nil, err
	}
	if err := w.root.Chmod(stagingPath(id, "tree"), dirMode); err != nil {
		return nil, internalError(err, "chmod staging tree")
	}
	if info != nil {
		if err := w.root.Remove(req.Name); err != nil {
			return nil, newError(CodeExists, "the task folder %q is no longer empty", req.Name)
		}
	}
	if err := w.root.Rename(stagingPath(id, "tree"), req.Name); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return nil, newError(CodeExists, "the task folder %q was created concurrently", req.Name)
		}
		return nil, internalError(err, "move the scaffold into %s", req.Name)
	}
	summary, err := w.taskSummary(ctx, req.Name)
	if err != nil {
		return nil, err
	}
	w.events.Infof("scaffolded %s (%s, template %s): %d files", req.Name, req.Language, req.Template, len(files))
	return &ScaffoldResult{Workspace: summary}, nil
}

// RenderInto renders the scaffold into the local directory dir for `scantor init`: dir must not exist or
// be empty; it is created with its parents. It returns the written paths.
func RenderInto(dir string, req ScaffoldRequest) ([]string, error) {
	files, err := RenderScaffold(req)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.MkdirAll(dir, dirMode); err != nil {
			return nil, internalError(err, "create %s", dir)
		}
	case err != nil:
		return nil, internalError(err, "stat %s", dir)
	case !info.IsDir():
		return nil, newError(CodeExists, "%s exists and is not a directory", dir)
	default:
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, internalError(err, "read %s", dir)
		}
		if len(entries) > 0 {
			return nil, newError(CodeExists, "%s already exists and is not empty", dir)
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, internalError(err, "open %s", dir)
	}
	defer root.Close()
	if err := writeScaffold(root, files); err != nil {
		return nil, err
	}
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	return paths, nil
}
