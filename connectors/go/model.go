package scantor

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// model is the native model of one config or result type: its exported JSON Schema plus strict
// decoding and validated encoding. The connector is the authoritative validator of every value user
// code consumes or produces, so values are checked against the same schema describe exports.
type model struct {
	typ    reflect.Type
	schema *object
}

type modelKey struct {
	typ  reflect.Type
	mode schemaMode
}

var models sync.Map // modelKey → *model

// modelFor returns the cached model of t.
func modelFor(t reflect.Type, mode schemaMode) (*model, error) {
	key := modelKey{typ: t, mode: mode}
	if m, ok := models.Load(key); ok {
		return m.(*model), nil
	}
	schema, err := reflectSchema(t, mode)
	if err != nil {
		return nil, err
	}
	m, _ := models.LoadOrStore(key, &model{typ: t, schema: schema})
	return m.(*model), nil
}

// decode parses raw JSON into a new value of the model's type: schema defaults are filled in (the
// platform sends effective configs, but a config like {} must mean the same everywhere), the result
// is validated (types, bounds, unknown keys) and decoded with DisallowUnknownFields. what names the
// value in messages.
func (m *model) decode(raw []byte, what string) (any, error) {
	x, err := decodeValue(raw)
	if err != nil {
		return nil, validationError(fmt.Sprintf("%s is not valid JSON: %v", what, err), nil)
	}
	x = applyDefaults(m.schema, m.schema, x)
	if issues := validateSchema(m.schema, x); len(issues) > 0 {
		return nil, validationError(what+" is invalid", issues)
	}
	filled, err := marshalJSON(x)
	if err != nil {
		return nil, validationError(fmt.Sprintf("%s cannot be encoded: %v", what, err), nil)
	}
	ptr := reflect.New(m.typ)
	dec := json.NewDecoder(bytes.NewReader(filled))
	dec.DisallowUnknownFields()
	if err := dec.Decode(ptr.Interface()); err != nil {
		return nil, validationError(what+" is invalid", []issue{decodeIssue(err)})
	}
	return ptr.Elem().Interface(), nil
}

// decodeInto is decode for a caller-provided pointer.
func (m *model) decodeInto(raw []byte, target any, what string) error {
	v, err := m.decode(raw, what)
	if err != nil {
		return err
	}
	reflect.ValueOf(target).Elem().Set(reflect.ValueOf(v))
	return nil
}

// encode serialises v in JSON mode and validates it against the model's schema. nil slices and maps
// count as empty (encoding/json writes them as null).
func (m *model) encode(v any, what string) (*object, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, validationError(fmt.Sprintf("%s is not representable in JSON: %v", what, err), nil)
	}
	x, err := decodeValue(raw)
	if err != nil {
		return nil, validationError(fmt.Sprintf("%s is not representable in JSON: %v", what, err), nil)
	}
	x = normalizeNulls(m.schema, m.schema, x)
	o, ok := x.(*object)
	if !ok {
		return nil, validationError(what+" must be a JSON object", nil)
	}
	if issues := validateSchema(m.schema, o); len(issues) > 0 {
		return nil, validationError(what+" is invalid", issues)
	}
	return o, nil
}

// maxDefaultsDepth bounds the schema traversal of applyDefaults for reference cycles that do not
// consume instance depth (the bound of internal/schema).
const maxDefaultsDepth = 128

// applyDefaults inserts a copy of the default of every missing property, recursively, and returns x
// (objects and arrays are filled in place). The semantics are those of ajv's useDefaults and the
// platform's internal/schema.ApplyDefaults (docs/tasks.md §6.3): wherever properties is evaluated
// against an object, a missing property with a default gets a deep copy of it, and the property's
// subschema is then evaluated against the (possibly inserted) value. Evaluation follows properties,
// items, present prefixItems entries, additionalProperties (for keys not listed in properties), allOf
// and local $ref. Defaults inside anyOf, oneOf, not and if/then/else are never applied, missing tuple
// items are never filled, and null values are kept.
func applyDefaults(doc, schema, x any) any {
	fillDefaults(doc, schema, x, 0)
	return x
}

func fillDefaults(doc, schema, x any, depth int) {
	s, ok := schema.(*object)
	if !ok || depth > maxDefaultsDepth {
		return
	}
	if ref, ok := s.values["$ref"].(string); ok && strings.HasPrefix(ref, "#") {
		if target, err := resolvePointer(doc, ref[1:]); err == nil {
			fillDefaults(doc, target, x, depth+1)
		}
	}
	if all, ok := s.values["allOf"].([]any); ok {
		for _, sub := range all {
			fillDefaults(doc, sub, x, depth+1)
		}
	}
	switch v := x.(type) {
	case *object:
		props := s.getObject("properties")
		if props != nil {
			for _, name := range props.keys {
				ps, ok := props.values[name].(*object)
				if !ok {
					continue
				}
				if _, present := v.get(name); !present {
					if def, has := ps.get("default"); has {
						v.set(name, cloneValue(def))
					}
				}
				if value, present := v.get(name); present {
					fillDefaults(doc, ps, value, depth+1)
				}
			}
		}
		if additional, ok := s.values["additionalProperties"].(*object); ok {
			for _, name := range v.keys {
				if props != nil {
					if _, listed := props.get(name); listed {
						continue
					}
				}
				fillDefaults(doc, additional, v.values[name], depth+1)
			}
		}
	case []any:
		prefix, _ := s.values["prefixItems"].([]any)
		items, hasItems := s.values["items"].(*object)
		for i, item := range v {
			if i < len(prefix) {
				fillDefaults(doc, prefix[i], item, depth+1)
			} else if hasItems {
				fillDefaults(doc, items, item, depth+1)
			}
		}
	}
}

// cloneValue deep-copies a decoded JSON value.
func cloneValue(v any) any {
	switch x := v.(type) {
	case *object:
		c := newObject()
		for _, k := range x.keys {
			c.set(k, cloneValue(x.values[k]))
		}
		return c
	case []any:
		c := make([]any, len(x))
		for i := range x {
			c[i] = cloneValue(x[i])
		}
		return c
	}
	return v
}

// validationError builds a validation Error whose message summarises the first issue.
func validationError(message string, issues []issue) *Error {
	if len(issues) > 0 {
		first := issues[0]
		where := first.Path
		if where == "" {
			where = "/"
		}
		message = fmt.Sprintf("%s: %s %s", message, where, first.Message)
		if len(issues) > 1 {
			message += fmt.Sprintf(" (and %d more)", len(issues)-1)
		}
	}
	return &Error{Type: "validation", Message: message, issues: issues}
}

// decodeIssue maps an encoding/json error to an issue with an instance path where possible.
func decodeIssue(err error) issue {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return issue{
			Path:    "/" + strings.ReplaceAll(typeErr.Field, ".", "/"),
			Message: fmt.Sprintf("cannot be decoded as %s", typeErr.Type),
		}
	}
	msg := err.Error()
	if field, ok := strings.CutPrefix(msg, "json: unknown field "); ok {
		return issue{Path: "", Message: "must NOT have additional property " + strings.ReplaceAll(field, `"`, "'")}
	}
	return issue{Path: "", Message: strings.TrimPrefix(msg, "json: ")}
}
