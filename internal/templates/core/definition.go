package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/schema"
)

// SchemaDir is the directory of the canonical template schemas in the embedded scantor.Schemas.
const SchemaDir = "schemas/templates"

// Estimate kinds of x-scantor-template.estimate.
const (
	EstimateExact      = "exact"
	EstimateUpperBound = "upperBound"
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9]{0,31}$`)

// Example is x-scantor-template.example.
type Example struct {
	ScanConfig     json.RawMessage `json:"scanConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
}

// Info is the metadata of a canonical schema file (docs/templates.md §1.1). Its JSON form is the
// listTemplates item of the API plus the remaining x-scantor-template keys.
type Info struct {
	Name                 string          `json:"name"`
	Title                string          `json:"title"`
	Description          string          `json:"description"`
	ScanConfigSchema     json.RawMessage `json:"scanConfigSchema"`
	AnalysisConfigSchema json.RawMessage `json:"analysisConfigSchema"`
	Example              Example         `json:"example"`
	Resolves             bool            `json:"resolves"`
	Version              int             `json:"version"`
	Estimate             string          `json:"estimate"`
	DataSources          []string        `json:"dataSources"`
	Uploads              bool            `json:"uploads"`
}

// Definition is a template implementation together with its canonical schema file: the metadata and
// the compiled scan and analysis config schemas.
type Definition struct {
	Template
	info           Info
	scanSchema     *schema.Schema
	analysisSchema *schema.Schema
}

// LoadDefinition pairs t with the embedded schemas/templates/<name>.json.
func LoadDefinition(t Template) (*Definition, error) {
	file := path.Join(SchemaDir, t.Name()+".json")
	raw, err := scantor.Schemas.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("template %s: read %s: %w", t.Name(), file, err)
	}
	return Define(t, raw)
}

// Define pairs t with a canonical schema file and checks that they belong together.
func Define(t Template, file []byte) (*Definition, error) {
	info, scanRaw, analysisRaw, err := parseSchemaFile(file)
	if err != nil {
		return nil, fmt.Errorf("template %s: %w", t.Name(), err)
	}
	if info.Name != t.Name() {
		return nil, fmt.Errorf("template %s: the schema file names the template %q", t.Name(), info.Name)
	}
	scanSchema, err := schema.Compile(scanRaw)
	if err != nil {
		return nil, fmt.Errorf("template %s: $defs.scanConfig: %w", t.Name(), err)
	}
	analysisSchema, err := schema.Compile(analysisRaw)
	if err != nil {
		return nil, fmt.Errorf("template %s: $defs.analysisConfig: %w", t.Name(), err)
	}
	d := &Definition{Template: t, info: info, scanSchema: scanSchema, analysisSchema: analysisSchema}
	if err := d.checkExample(); err != nil {
		return nil, fmt.Errorf("template %s: %w", t.Name(), err)
	}
	return d, nil
}

type schemaFile struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Meta        *struct {
		Name        string   `json:"name"`
		Version     int      `json:"version"`
		Resolves    bool     `json:"resolves"`
		Estimate    string   `json:"estimate"`
		DataSources []string `json:"dataSources"`
		Uploads     bool     `json:"uploads"`
		Example     *Example `json:"example"`
	} `json:"x-scantor-template"`
	Defs map[string]json.RawMessage `json:"$defs"`
}

func parseSchemaFile(file []byte) (Info, json.RawMessage, json.RawMessage, error) {
	var f schemaFile
	if err := json.Unmarshal(file, &f); err != nil {
		return Info{}, nil, nil, fmt.Errorf("parse schema file: %w", err)
	}
	if f.Meta == nil {
		return Info{}, nil, nil, errors.New("the schema file has no x-scantor-template")
	}
	m := f.Meta
	switch {
	case !namePattern.MatchString(m.Name):
		return Info{}, nil, nil, fmt.Errorf("invalid template name %q", m.Name)
	case m.Version < 1:
		return Info{}, nil, nil, errors.New("x-scantor-template.version must be ≥ 1")
	case m.Estimate != EstimateExact && m.Estimate != EstimateUpperBound:
		return Info{}, nil, nil, fmt.Errorf("invalid x-scantor-template.estimate %q", m.Estimate)
	case m.Example == nil:
		return Info{}, nil, nil, errors.New("the schema file has no x-scantor-template.example")
	}
	scanRaw, analysisRaw := f.Defs["scanConfig"], f.Defs["analysisConfig"]
	if len(scanRaw) == 0 || len(analysisRaw) == 0 {
		return Info{}, nil, nil, errors.New("the schema file needs $defs.scanConfig and $defs.analysisConfig")
	}
	dataSources := m.DataSources
	if dataSources == nil {
		dataSources = []string{}
	}
	info := Info{
		Name:                 m.Name,
		Title:                f.Title,
		Description:          f.Description,
		ScanConfigSchema:     scanRaw,
		AnalysisConfigSchema: analysisRaw,
		Example:              *m.Example,
		Resolves:             m.Resolves,
		Version:              m.Version,
		Estimate:             m.Estimate,
		DataSources:          slices.Clone(dataSources),
		Uploads:              m.Uploads,
	}
	return info, scanRaw, analysisRaw, nil
}

// checkExample verifies the documentation example against both schemas, so UI cards never show an
// invalid config.
func (d *Definition) checkExample() error {
	if _, issues, err := d.Effective(d.info.Example.ScanConfig); err != nil || len(issues) > 0 {
		return fmt.Errorf("x-scantor-template.example.scanConfig is invalid: %v %v", err, issues)
	}
	if issues, err := d.ValidateAnalysisConfig(d.info.Example.AnalysisConfig); err != nil || len(issues) > 0 {
		return fmt.Errorf("x-scantor-template.example.analysisConfig is invalid: %v %v", err, issues)
	}
	return nil
}

// Info returns the metadata of the schema file.
func (d *Definition) Info() Info {
	info := d.info
	info.DataSources = slices.Clone(info.DataSources)
	return info
}

// ScanConfigSchema returns the compiled $defs.scanConfig.
func (d *Definition) ScanConfigSchema() *schema.Schema { return d.scanSchema }

// AnalysisConfigSchema returns the compiled $defs.analysisConfig.
func (d *Definition) AnalysisConfigSchema() *schema.Schema { return d.analysisSchema }

// Effective fills the canonical defaults into raw (ajv useDefaults semantics), validates the result
// against the canonical scan config schema and, when it is schema-valid, runs the template's
// semantic Validate. It returns the effective config and the issues sorted by path; the error is
// non-nil only when raw is not a JSON value.
func (d *Definition) Effective(raw json.RawMessage) (json.RawMessage, []Issue, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	filled, schemaIssues, err := d.scanSchema.Fill(raw)
	if err != nil {
		return nil, nil, err
	}
	if len(schemaIssues) > 0 {
		return filled, fromSchemaIssues(schemaIssues), nil
	}
	issues := d.Validate(filled)
	slices.SortStableFunc(issues, func(a, b Issue) int {
		switch {
		case a.Path < b.Path:
			return -1
		case a.Path > b.Path:
			return 1
		default:
			return 0
		}
	})
	return filled, issues, nil
}

// ValidateAnalysisConfig validates an analysis config against the canonical analysis config schema.
// The error is non-nil only when raw is not a JSON value.
func (d *Definition) ValidateAnalysisConfig(raw json.RawMessage) ([]Issue, error) {
	instance, err := schema.ParseJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("parse JSON: %w", err)
	}
	return fromSchemaIssues(d.analysisSchema.Validate(instance)), nil
}

func fromSchemaIssues(in []schema.Issue) []Issue {
	if len(in) == 0 {
		return nil
	}
	out := make([]Issue, len(in))
	for i, is := range in {
		out[i] = Issue{Path: is.Path, Message: is.Message}
	}
	return out
}
