package scantor

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/invopop/jsonschema"
)

// schemaMode selects how a type is exported (docs/tasks.md §6.1).
type schemaMode int

const (
	// inputMode is used for configs: a field is required only with `jsonschema:"required"`.
	inputMode schemaMode = iota
	// outputMode is used for results: every field without omitempty/omitzero is required.
	outputMode
)

var (
	secretType  = reflect.TypeFor[Secret]()
	fileRefType = reflect.TypeFor[FileRef]()
	timeType    = reflect.TypeFor[time.Time]()
	urlType     = reflect.TypeFor[url.URL]()
	rawType     = reflect.TypeFor[json.RawMessage]()
)

// annotationKeys are moved to the wrapper when a referenced schema becomes nullable.
var annotationKeys = []string{"title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"}

// reflectSchema exports the JSON Schema of t: invopop reflection, then a walk over the Go type that
// makes pointer fields nullable, converts tag defaults to the field's type and inlines the root
// definition. Configs and results always reflect closed structs (additionalProperties: false).
func reflectSchema(t reflect.Type, mode schemaMode) (root *object, err error) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	names := &typeNamer{byType: map[reflect.Type]string{}, used: map[string]bool{}}
	r := &jsonschema.Reflector{
		Anonymous:                  true,
		RequiredFromJSONSchemaTags: mode == inputMode,
		Mapper:                     mapSpecialType,
		Namer:                      names.name,
	}
	reflected, err := func() (s *jsonschema.Schema, err error) {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("%v", p)
			}
		}()
		return r.ReflectFromType(t), nil
	}()
	if err != nil {
		return nil, fmt.Errorf("cannot export the JSON Schema of %s: %w", t, err)
	}
	raw, err := json.Marshal(reflected)
	if err != nil {
		return nil, fmt.Errorf("cannot encode the JSON Schema of %s: %w", t, err)
	}
	decoded, err := decodeValue(raw)
	if err != nil {
		return nil, fmt.Errorf("cannot decode the JSON Schema of %s: %w", t, err)
	}
	doc, ok := decoded.(*object)
	if !ok {
		return nil, fmt.Errorf("the JSON Schema of %s is not an object", t)
	}
	f := &schemaFixer{defs: doc.getObject("$defs"), names: names, visited: map[reflect.Type]bool{}}
	if err := f.visit(t, doc); err != nil {
		return nil, err
	}
	root = inlineRoot(doc, names.byType[t])
	orderKeywords(root)
	if typ, _ := root.get("type"); typ != "object" {
		return nil, fmt.Errorf("%s does not export a JSON object schema", t)
	}
	if err := checkPatterns(root); err != nil {
		return nil, fmt.Errorf("%s: %w", t, err)
	}
	return root, nil
}

// mapSpecialType returns the fixed schemas of the connector's own types. A fresh schema per call keeps
// field tags (descriptions) from leaking between uses.
func mapSpecialType(t reflect.Type) *jsonschema.Schema {
	switch t {
	case secretType:
		return &jsonschema.Schema{Type: "string", WriteOnly: true}
	case fileRefType:
		props := jsonschema.NewProperties()
		props.Set("id", &jsonschema.Schema{Type: "string"})
		props.Set("name", &jsonschema.Schema{Type: "string"})
		props.Set("size", &jsonschema.Schema{Type: "integer"})
		props.Set("sha256", &jsonschema.Schema{Type: "string"})
		props.Set("contentType", &jsonschema.Schema{Type: "string"})
		return &jsonschema.Schema{
			Type:                 "object",
			Properties:           props,
			Required:             []string{"id", "name", "size", "sha256", "contentType"},
			AdditionalProperties: jsonschema.FalseSchema,
			Extras:               map[string]any{"x-scantor": "file"},
		}
	}
	return nil
}

// typeNamer gives every named type a unique $defs key that is also a plain JSON pointer token, so two
// types with the same name from different packages never share a definition.
type typeNamer struct {
	byType map[reflect.Type]string
	used   map[string]bool
}

var unsafeNameChars = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

func (n *typeNamer) name(t reflect.Type) string {
	if name, ok := n.byType[t]; ok {
		return name
	}
	base := strings.Trim(unsafeNameChars.ReplaceAllString(t.Name(), "_"), "_")
	if base == "" {
		return ""
	}
	name := base
	for i := 2; n.used[name]; i++ {
		name = base + strconv.Itoa(i)
	}
	n.byType[t] = name
	n.used[name] = true
	return name
}

// inlineRoot replaces a root "$ref" with the referenced definition (the runtime requires the root to be
// an object schema) and drops "$schema", "$id" and unused definitions.
func inlineRoot(doc *object, rootName string) *object {
	defs := doc.getObject("$defs")
	root := doc
	if ref, _ := doc.get("$ref"); ref != nil && defs != nil && rootName != "" && ref == "#/$defs/"+rootName {
		if def := defs.getObject(rootName); def != nil {
			root = def.clone()
			root.remove("$defs")
			if !referenced(defs, root, "#/$defs/"+rootName) {
				defs.remove(rootName)
			}
		}
	}
	root.remove("$schema")
	root.remove("$id")
	root.remove("$ref")
	root.remove("$defs")
	if defs != nil && len(defs.keys) > 0 {
		root.set("$defs", defs)
	}
	return root
}

func referenced(defs, root *object, ref string) bool {
	needle := []byte(strconv.Quote(ref))
	for _, node := range []*object{defs, root} {
		raw, err := json.Marshal(node)
		if err == nil && strings.Contains(string(raw), string(needle)) {
			return true
		}
	}
	return false
}

// keywordOrder is the order in which exported schemas list their keywords (invopop emits them in its
// struct field order), so the raw schemas read naturally in the UI and in describe output.
var keywordOrder = []string{
	"$ref", "type", "title", "description", "format", "x-scantor", "const", "enum",
	"minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "multipleOf",
	"minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "items", "prefixItems",
	"properties", "patternProperties", "additionalProperties", "propertyNames", "required",
	"minProperties", "maxProperties", "anyOf", "oneOf", "allOf", "not",
	"default", "examples", "readOnly", "writeOnly", "deprecated", "$defs",
}

// orderKeywords reorders the keywords of every schema object by keywordOrder (unknown keywords keep
// their relative order after the known ones). Property names are data and keep their order.
func orderKeywords(node any) {
	switch n := node.(type) {
	case *object:
		rank := func(k string) int {
			for i, known := range keywordOrder {
				if k == known {
					return i
				}
			}
			return len(keywordOrder)
		}
		sort.SliceStable(n.keys, func(i, j int) bool { return rank(n.keys[i]) < rank(n.keys[j]) })
		for _, k := range n.keys {
			v := n.values[k]
			switch k {
			case "properties", "patternProperties", "$defs":
				if props, ok := v.(*object); ok {
					for _, name := range props.keys {
						orderKeywords(props.values[name])
					}
				}
			case "default", "examples", "const", "enum":
				// values, not schemas
			default:
				orderKeywords(v)
			}
		}
	case []any:
		for _, v := range n {
			orderKeywords(v)
		}
	}
}

// checkPatterns verifies that every "pattern" compiles, so a bad tag fails the task definition
// instead of every validation.
func checkPatterns(node any) error {
	switch n := node.(type) {
	case *object:
		for _, k := range n.keys {
			v := n.values[k]
			if k == "pattern" {
				if p, ok := v.(string); ok {
					if _, err := compilePattern(p); err != nil {
						return err
					}
				}
				continue
			}
			if err := checkPatterns(v); err != nil {
				return err
			}
		}
	case []any:
		for _, v := range n {
			if err := checkPatterns(v); err != nil {
				return err
			}
		}
	}
	return nil
}

// schemaFixer walks a Go type in parallel with its reflected schema.
type schemaFixer struct {
	defs    *object
	names   *typeNamer
	visited map[reflect.Type]bool
}

func isSpecialType(t reflect.Type) bool {
	switch t {
	case secretType, fileRefType, timeType, urlType, rawType:
		return true
	}
	return t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.Uint8
}

// node returns the schema that describes t: its definition for named types, else the use site.
func (f *schemaFixer) node(t reflect.Type, site *object) *object {
	if name := f.names.byType[t]; name != "" && f.defs != nil {
		if def := f.defs.getObject(name); def != nil {
			return def
		}
	}
	return site
}

func (f *schemaFixer) visit(t reflect.Type, schema any) error {
	site, ok := schema.(*object)
	if !ok || isSpecialType(t) {
		return nil
	}
	node := f.node(t, site)
	if node != site {
		if f.visited[t] {
			return nil
		}
		f.visited[t] = true
	}
	switch t.Kind() {
	case reflect.Struct:
		return f.visitStruct(t, node)
	case reflect.Slice, reflect.Array:
		return f.visitElem(t.Elem(), node, "items")
	case reflect.Map:
		return f.visitElem(t.Elem(), node, "additionalProperties")
	}
	return nil
}

func (f *schemaFixer) visitElem(elem reflect.Type, node *object, key string) error {
	sub, ok := node.get(key)
	if !ok {
		return nil
	}
	nullable := false
	for elem.Kind() == reflect.Pointer {
		elem, nullable = elem.Elem(), true
	}
	if err := f.visit(elem, sub); err != nil {
		return err
	}
	if nullable {
		node.set(key, makeNullable(sub))
	}
	return nil
}

func (f *schemaFixer) visitStruct(t reflect.Type, node *object) error {
	props := node.getObject("properties")
	if props == nil {
		return nil
	}
	for _, fld := range schemaFields(t) {
		prop, ok := props.get(fld.name)
		if !ok {
			continue
		}
		ft := fld.field.Type
		nullable := false
		for ft.Kind() == reflect.Pointer {
			ft, nullable = ft.Elem(), true
		}
		if err := f.visit(ft, prop); err != nil {
			return err
		}
		if obj, ok := prop.(*object); ok {
			if err := applyDefault(obj, fld.field, ft, nullable); err != nil {
				return fmt.Errorf("%s.%s: %w", t, fld.field.Name, err)
			}
		}
		if nullable {
			props.set(fld.name, makeNullable(prop))
		}
	}
	return nil
}

type schemaField struct {
	name  string
	field reflect.StructField
}

// schemaFields lists the JSON properties of a struct with the naming and embedding rules that
// invopop/jsonschema and encoding/json apply.
func schemaFields(t reflect.Type) []schemaField {
	var out []schemaField
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		jsonTags := strings.Split(f.Tag.Get("json"), ",")
		if jsonTags[0] == "-" || strings.Split(f.Tag.Get("jsonschema"), ",")[0] == "-" {
			continue
		}
		embedded := f.Type
		if embedded.Kind() == reflect.Pointer {
			embedded = embedded.Elem()
		}
		inline := false
		for _, opt := range jsonTags[1:] {
			inline = inline || opt == "inline"
		}
		if (f.Anonymous && jsonTags[0] == "" && embedded.Kind() == reflect.Struct) || inline {
			out = append(out, schemaFields(embedded)...)
			continue
		}
		if !f.Anonymous && f.PkgPath != "" {
			continue
		}
		name := f.Name
		if jsonTags[0] != "" {
			name = jsonTags[0]
		}
		out = append(out, schemaField{name: name, field: f})
	}
	return out
}

// applyDefault sets "default" from the field's `default=` tags converted to the field's type. invopop
// keeps array defaults as strings and cannot express null or empty collections; the connector
// accepts default=null on pointer fields, default=[] on slices and default={} on structs and maps.
func applyDefault(prop *object, f reflect.StructField, t reflect.Type, nullable bool) error {
	var values []string
	for _, tag := range splitTag(f.Tag.Get("jsonschema")) {
		if v, ok := strings.CutPrefix(tag, "default="); ok {
			values = append(values, v)
		}
	}
	if len(values) == 0 {
		return nil
	}
	if nullable && len(values) == 1 && values[0] == "null" {
		prop.set("default", nil)
		return nil
	}
	value, err := convertDefault(t, values)
	if err != nil {
		return err
	}
	prop.set("default", value)
	return nil
}

func convertDefault(t reflect.Type, values []string) (any, error) {
	if t == timeType || t == secretType {
		return values[0], nil
	}
	switch t.Kind() {
	case reflect.Slice, reflect.Array:
		if len(values) == 1 && values[0] == "[]" {
			return []any{}, nil
		}
		elem := t.Elem()
		nullable := false
		for elem.Kind() == reflect.Pointer {
			elem, nullable = elem.Elem(), true
		}
		out := make([]any, 0, len(values))
		for _, v := range values {
			if nullable && v == "null" {
				out = append(out, nil)
				continue
			}
			item, err := convertScalar(elem, v)
			if err != nil {
				return nil, err
			}
			out = append(out, item)
		}
		return out, nil
	case reflect.Struct, reflect.Map:
		if len(values) == 1 && values[0] == "{}" {
			return newObject(), nil
		}
		return nil, fmt.Errorf("default %q: only default={} is supported for objects", strings.Join(values, ","))
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("default is given %d times", len(values))
	}
	return convertScalar(t, values[0])
}

func convertScalar(t reflect.Type, v string) (any, error) {
	switch t.Kind() {
	case reflect.String:
		return v, nil
	case reflect.Bool:
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("default %q is not a boolean", v)
		}
		return b, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if _, ok := new(big.Int).SetString(v, 10); !ok {
			return nil, fmt.Errorf("default %q is not an integer", v)
		}
		return json.Number(v), nil
	case reflect.Float32, reflect.Float64:
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			return nil, fmt.Errorf("default %q is not a number", v)
		}
		return json.Number(v), nil
	}
	return nil, fmt.Errorf("default %q is not supported for %s fields", v, t.Kind())
}

// splitTag splits a jsonschema tag on commas that are not escaped with a backslash (the rule of
// invopop/jsonschema, which lets patterns and descriptions contain "\,").
func splitTag(tag string) []string {
	var out []string
	var cur strings.Builder
	for i := 0; i < len(tag); i++ {
		c := tag[i]
		if c == '\\' && i+1 < len(tag) && tag[i+1] == ',' {
			cur.WriteByte(',')
			i++
			continue
		}
		if c == ',' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(out, cur.String())
}

// makeNullable allows null in addition to schema: `type: [X, "null"]` for typed schemas, else
// `anyOf: [X, {type: null}]` with the annotations hoisted to the wrapper (both forms are in the
// supported subset).
func makeNullable(schema any) any {
	o, ok := schema.(*object)
	if !ok {
		return schema
	}
	switch t := o.values["type"].(type) {
	case string:
		o.set("type", []any{t, "null"})
		addNullToEnum(o)
		return o
	case []any:
		for _, v := range t {
			if v == "null" {
				return o
			}
		}
		o.set("type", append(t, "null"))
		addNullToEnum(o)
		return o
	}
	if len(o.keys) == 0 {
		return o
	}
	wrapper := newObject()
	inner := o.clone()
	for _, k := range annotationKeys {
		if v, ok := inner.get(k); ok {
			wrapper.set(k, v)
			inner.remove(k)
		}
	}
	null := newObject()
	null.set("type", "null")
	wrapper.set("anyOf", []any{inner, null})
	return wrapper
}

func addNullToEnum(o *object) {
	enum, ok := o.values["enum"].([]any)
	if !ok || containsJSON(enum, nil) {
		return
	}
	o.set("enum", append(enum, nil))
}

// normalizeNulls replaces null where the schema expects a non-nullable array or object with [] or {}:
// encoding/json writes nil slices and maps as null, which user code means as "empty".
func normalizeNulls(doc, schema, x any) any {
	s, ok := schema.(*object)
	if !ok {
		return x
	}
	if ref, ok := s.values["$ref"].(string); ok && strings.HasPrefix(ref, "#") {
		if target, err := resolvePointer(doc, ref[1:]); err == nil {
			x = normalizeNulls(doc, target, x)
		}
	}
	switch v := x.(type) {
	case nil:
		switch s.values["type"] {
		case "array":
			return []any{}
		case "object":
			return newObject()
		}
	case *object:
		props := s.getObject("properties")
		additional := s.values["additionalProperties"]
		for _, k := range v.keys {
			if props != nil {
				if ps, ok := props.get(k); ok {
					v.values[k] = normalizeNulls(doc, ps, v.values[k])
					continue
				}
			}
			if additional != nil {
				v.values[k] = normalizeNulls(doc, additional, v.values[k])
			}
		}
	case []any:
		if items, ok := s.get("items"); ok {
			for i := range v {
				v[i] = normalizeNulls(doc, items, v[i])
			}
		}
	}
	return x
}
