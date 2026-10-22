package protocol

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	scantor "github.com/lonetis/scantor"
)

// SchemaDir is the directory of the protocol schemas inside scantor.Schemas.
const SchemaDir = "schemas/protocol"

const schemaBaseURL = "https://scantor.dev/schemas/protocol/"

// Validator validates protocol lines against the embedded JSON Schemas (schemas/protocol).
type Validator struct {
	connectorToRuntime *jsonschema.Schema
	runtimeToConnector *jsonschema.Schema
	byType             map[string]*jsonschema.Schema
}

var (
	validatorOnce sync.Once
	validator     *Validator
	validatorErr  error
)

// DefaultValidator returns a validator over the embedded schemas, compiled once.
func DefaultValidator() (*Validator, error) {
	validatorOnce.Do(func() { validator, validatorErr = NewValidator(scantor.Schemas) })
	return validator, validatorErr
}

// NewValidator compiles the protocol schemas found under schemas/protocol in fsys.
func NewValidator(fsys fs.FS) (*Validator, error) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	entries, err := fs.ReadDir(fsys, SchemaDir)
	if err != nil {
		return nil, fmt.Errorf("read protocol schemas: %w", err)
	}
	var types []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".schema.json") {
			continue
		}
		data, err := fs.ReadFile(fsys, path.Join(SchemaDir, name))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
		if err := c.AddResource(schemaBaseURL+name, doc); err != nil {
			return nil, fmt.Errorf("add %s: %w", name, err)
		}
		if t := strings.TrimSuffix(name, ".schema.json"); newMessage(t) != nil {
			types = append(types, t)
		}
	}
	v := &Validator{byType: map[string]*jsonschema.Schema{}}
	if v.connectorToRuntime, err = c.Compile(schemaBaseURL + "message.schema.json#/$defs/connectorToRuntime"); err != nil {
		return nil, fmt.Errorf("compile connectorToRuntime: %w", err)
	}
	if v.runtimeToConnector, err = c.Compile(schemaBaseURL + "message.schema.json#/$defs/runtimeToConnector"); err != nil {
		return nil, fmt.Errorf("compile runtimeToConnector: %w", err)
	}
	for _, t := range types {
		if v.byType[t], err = c.Compile(schemaBaseURL + t + ".schema.json"); err != nil {
			return nil, fmt.Errorf("compile %s: %w", t, err)
		}
	}
	return v, nil
}

// SchemaError is a line that does not validate against its schema.
type SchemaError struct {
	Type string
	Err  error
}

func (e *SchemaError) Error() string {
	return fmt.Sprintf("%s message does not match its schema: %v", e.Type, e.Err)
}

func (e *SchemaError) Unwrap() error { return e.Err }

// ValidateLine validates one line (with or without its newline) for direction d. It checks the
// direction's union schema and, for known types, the type's own schema (which yields a precise
// message).
func (v *Validator) ValidateLine(d Direction, line []byte) error {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(bytes.TrimSuffix(line, []byte("\n"))))
	if err != nil {
		return &SyntaxError{Err: err}
	}
	typ := ""
	if obj, ok := doc.(map[string]any); ok {
		typ, _ = obj["type"].(string)
	}
	if typ != "" && !Allowed(d, typ) {
		if newMessage(typ) == nil {
			return &UnknownTypeError{Type: typ}
		}
		return &SchemaError{Type: typ, Err: errors.New("message type not allowed in this direction")}
	}
	if s, ok := v.byType[typ]; ok {
		if err := s.Validate(doc); err != nil {
			return &SchemaError{Type: typ, Err: err}
		}
	}
	union := v.connectorToRuntime
	if d == RuntimeToConnector {
		union = v.runtimeToConnector
	}
	if err := union.Validate(doc); err != nil {
		return &SchemaError{Type: typ, Err: err}
	}
	return nil
}

// ValidateMessage marshals msg and validates it for direction d.
func (v *Validator) ValidateMessage(d Direction, msg Message) error {
	b, err := Marshal(msg)
	if err != nil {
		return err
	}
	return v.ValidateLine(d, b)
}
