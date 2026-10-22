package scantor

import (
	"fmt"
	"io"
	"iter"
	"reflect"
)

// Test hooks for the external test package (which may import the template packages).

// Task is an opaque task definition for tests.
type Task = task

func NewTask[TC, SC, AC, R any](
	schedule func(ctx Context, scanConfig SC, taskConfig TC) iter.Seq2[AC, error],
	run func(ctx Context, analysisConfig AC, taskConfig TC) (R, error),
) *Task {
	return newTask(schedule, run)
}

func ServeStreams(t *Task, in io.Reader, out io.Writer, stderr io.Writer) int {
	return serve(t, in, out, stderr)
}

func ServeProcess(t *Task) int { return serveProcess(t) }

func TemplateName(t *Task) string { return t.template }

// ReflectSchema returns the exported schema of t as JSON (input mode for configs, output mode for
// results).
func ReflectSchema(t reflect.Type, output bool) ([]byte, error) {
	mode := inputMode
	if output {
		mode = outputMode
	}
	s, err := reflectSchema(t, mode)
	if err != nil {
		return nil, err
	}
	return marshalJSON(s)
}

// DecodeConfig decodes raw with the native input model of t.
func DecodeConfig(t reflect.Type, raw []byte) (any, error) {
	m, err := modelFor(t, inputMode)
	if err != nil {
		return nil, err
	}
	return m.decode(raw, "config")
}

// ErrorIssues returns the issue paths of a validation error.
func ErrorIssues(err error) []string {
	e, ok := err.(*Error)
	if !ok {
		return nil
	}
	paths := make([]string, len(e.issues))
	for i, is := range e.issues {
		paths[i] = is.Path
	}
	return paths
}

// ProtocolValidator returns a function that validates one connector → runtime line against
// message.schema.json#/$defs/connectorToRuntime; docs maps schema file names to their raw JSON.
func ProtocolValidator(docs map[string][]byte) (func(line []byte) error, error) {
	registry := schemaRegistry{}
	for name, raw := range docs {
		doc, err := decodeValue(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		registry[name] = doc
	}
	root := registry["message.schema.json"]
	union, err := resolvePointer(root, "/$defs/connectorToRuntime")
	if err != nil {
		return nil, err
	}
	return func(line []byte) error {
		instance, err := decodeValue(line)
		if err != nil {
			return err
		}
		v := &validator{registry: registry}
		v.check(root, union, instance, "")
		if len(v.issues) > 0 {
			return fmt.Errorf("%+v", v.issues)
		}
		return nil
	}, nil
}

// ValidateAgainst validates instance (raw JSON) against schema (raw JSON) with local references.
func ValidateAgainst(schema, instance []byte) error {
	s, err := decodeValue(schema)
	if err != nil {
		return err
	}
	x, err := decodeValue(instance)
	if err != nil {
		return err
	}
	if issues := validateSchema(s, x); len(issues) > 0 {
		return fmt.Errorf("%+v", issues)
	}
	return nil
}
