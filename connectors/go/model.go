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

// applyDefaults inserts a copy of the default of every missing property, recursively, with the
// semantics of ajv's useDefaults and the platform's ApplyDefaults (docs/tasks.md §6.3): local $ref is
// followed; defaults inside anyOf/oneOf branches, items and additionalProperties are not applied.
func applyDefaults(doc, schema, x any) any {
	s, ok := schema.(*object)
	if !ok {
		return x
	}
	if ref, ok := s.values["$ref"].(string); ok && strings.HasPrefix(ref, "#") {
		if target, err := resolvePointer(doc, ref[1:]); err == nil {
			x = applyDefaults(doc, target, x)
		}
	}
	o, ok := x.(*object)
	props := s.getObject("properties")
	if !ok || props == nil {
		return x
	}
	for _, name := range props.keys {
		ps := props.values[name]
		if v, present := o.get(name); present {
			o.values[name] = applyDefaults(doc, ps, v)
			continue
		}
		if psObj, ok := ps.(*object); ok {
			if def, has := psObj.get("default"); has {
				o.set(name, applyDefaults(doc, ps, cloneValue(def)))
			}
		}
	}
	return o
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
