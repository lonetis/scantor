// Package schema validates JSON instances against JSON Schemas (draft 2020-12) and fills defaults with
// the semantics of ajv's `useDefaults: true`, so effective configs computed by the CLI (`scantor dev
// run`) equal those computed by the orchestrator at scan start (docs/tasks.md §6.3).
//
// Default semantics, matching ajv 8 (ajv/dist/2020, useDefaults: true): wherever a `properties`
// keyword is evaluated against an object, every property that is missing from the object and has a
// `default` gets a deep copy of that default; the property's subschema is then evaluated against the
// (possibly inserted) value, so nested defaults are filled too. Evaluation follows `properties`,
// `items`, `prefixItems`, `additionalProperties` (for keys not listed in `properties`), `allOf` and local
// `$ref`. Defaults inside `anyOf`, `oneOf`, `not` and `if`/`then`/`else` are never applied, missing tuple
// items are never filled, and `null` values are kept.
//
// Validation uses santhosh-tekuri/jsonschema/v6 with format assertions and never loads remote
// references.
package schema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// Issue is one validation failure: the JSON pointer of the offending instance value ("" is the root)
// and a human-readable message. Keyword and Properties are diagnostics for callers that map issues to
// source positions; they are not serialised.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	// Keyword is the failing keyword ("required", "additionalProperties", "not", "pattern", …).
	Keyword string `json:"-"`
	// Properties are the offending property names of additionalProperties and the missing ones of
	// required.
	Properties []string `json:"-"`
}

// String renders "<path>: <message>", or just the message for the root.
func (i Issue) String() string {
	if i.Path == "" {
		return i.Message
	}
	return i.Path + ": " + i.Message
}

// Schema is a compiled JSON Schema plus its document, which ApplyDefaults walks.
type Schema struct {
	doc      any
	compiled *jsonschema.Schema
}

const resourceURL = "mem:///schema.json"

var printer = message.NewPrinter(language.English)

// Compile parses and compiles a JSON Schema document. Schemas without `$schema` are treated as draft
// 2020-12. Remote references are rejected.
func Compile(raw []byte) (*Schema, error) {
	doc, err := ParseJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("parse schema: %w", err)
	}
	return CompileValue(doc)
}

// CompileValue compiles a schema document that was already decoded (numbers as json.Number, see
// ParseJSON).
func CompileValue(doc any) (*Schema, error) {
	switch doc.(type) {
	case map[string]any, bool:
	default:
		return nil, errors.New("compile schema: the schema must be an object or a boolean")
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	c.UseLoader(noRemoteLoader{})
	if err := c.AddResource(resourceURL, doc); err != nil {
		return nil, fmt.Errorf("compile schema: %w", err)
	}
	compiled, err := c.Compile(resourceURL)
	if err != nil {
		return nil, fmt.Errorf("compile schema: %w", err)
	}
	return &Schema{doc: doc, compiled: compiled}, nil
}

type noRemoteLoader struct{}

func (noRemoteLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("remote schema references are not allowed (%s)", url)
}

// ParseJSON decodes exactly one JSON value, keeping numbers as json.Number so integers never lose
// precision.
func ParseJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

// Validate validates instance (decoded with ParseJSON or built from Go maps, slices and scalars) and
// returns the failures sorted by path, or nil.
func (s *Schema) Validate(instance any) []Issue {
	err := s.compiled.Validate(instance)
	if err == nil {
		return nil
	}
	var verr *jsonschema.ValidationError
	if !errors.As(err, &verr) {
		return []Issue{{Message: err.Error()}}
	}
	var issues []Issue
	collectLeaves(verr, &issues)
	sort.SliceStable(issues, func(i, j int) bool { return issues[i].Path < issues[j].Path })
	return dedupe(issues)
}

func collectLeaves(e *jsonschema.ValidationError, out *[]Issue) {
	if len(e.Causes) == 0 {
		is := Issue{Path: pointer(e.InstanceLocation), Message: e.ErrorKind.LocalizedString(printer)}
		switch k := e.ErrorKind.(type) {
		case *kind.AdditionalProperties:
			is.Keyword, is.Properties = "additionalProperties", k.Properties
		case *kind.Required:
			is.Keyword, is.Properties = "required", k.Missing
		case *kind.Not:
			is.Keyword = "not"
		default:
			if kw := e.ErrorKind.KeywordPath(); len(kw) > 0 {
				is.Keyword = kw[len(kw)-1]
			}
		}
		*out = append(*out, is)
		return
	}
	for _, c := range e.Causes {
		collectLeaves(c, out)
	}
}

func dedupe(issues []Issue) []Issue {
	out := issues[:0]
	for i, is := range issues {
		if i > 0 && is.Path == issues[i-1].Path && is.Message == issues[i-1].Message {
			continue
		}
		out = append(out, is)
	}
	return out
}

// pointer encodes path segments as an RFC 6901 JSON pointer.
func pointer(segments []string) string {
	var b strings.Builder
	for _, s := range segments {
		b.WriteByte('/')
		b.WriteString(strings.NewReplacer("~", "~0", "/", "~1").Replace(s))
	}
	return b.String()
}

// Fill parses raw (a JSON value), fills defaults, validates the result and returns it re-encoded. The
// error is non-nil only when raw is not valid JSON; validation failures are returned as issues together
// with the filled value.
func (s *Schema) Fill(raw []byte) (json.RawMessage, []Issue, error) {
	instance, err := ParseJSON(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("parse JSON: %w", err)
	}
	instance = s.ApplyDefaults(instance)
	issues := s.Validate(instance)
	out, err := json.Marshal(instance)
	if err != nil {
		return nil, nil, fmt.Errorf("encode JSON: %w", err)
	}
	return out, issues, nil
}
