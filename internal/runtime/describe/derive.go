package describe

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"math/big"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/canonical"
	"github.com/lonetis/scantor/internal/schema"
	"github.com/lonetis/scantor/internal/templates"
)

// Limits of the describe output (docs/tasks.md §7, §9.10, docs/protocol.md §9).
const (
	SchemaURL      = "https://json-schema.org/draft/2020-12/schema"
	MaxSchemaBytes = protocol.MaxSchemaBytes
	MaxOutputBytes = protocol.MaxDescriptionBytes
	MaxPaths       = 256
	MaxPathDepth   = 16
	MaxWarnings    = protocol.MaxWarnings
	MaxWarningLen  = protocol.MaxWarningLength
	// walkDepth bounds the schema walk; recursion is cut by the $ref cycle guard first.
	walkDepth = 64
)

// The four task types in output order.
const (
	TaskConfig     = "taskConfig"
	ScanConfig     = "scanConfig"
	AnalysisConfig = "analysisConfig"
	Result         = "result"
)

var typeNames = []string{TaskConfig, ScanConfig, AnalysisConfig, Result}

// Input is what the connector reported: its hello and its description.
type Input struct {
	ProtocolVersion int
	Connector       protocol.ConnectorInfo
	Description     protocol.Description
}

// Derive turns a connector description into the describe output (docs/tasks.md §7 steps 1–6). It returns
// the description and the describe errors; with errors the description must not be used.
func Derive(in Input) (*api.Description, []string) {
	d := &deriver{}
	return d.derive(in)
}

type deriver struct {
	errs     []string
	warnings []string
	// sources are the documents the schemas were decoded from, whose key order the output keeps.
	sources map[string]json.RawMessage
	// connectorWarnings are the warnings of the description, which come first in the output.
	connectorWarnings []string
}

func (d *deriver) errorf(format string, args ...any) {
	d.errs = append(d.errs, fmt.Sprintf(format, args...))
}

func (d *deriver) derive(in Input) (*api.Description, []string) {
	desc := in.Description
	d.connectorWarnings = desc.Warnings
	schemas := map[string]any{}
	raw := map[string]json.RawMessage{
		TaskConfig: desc.Schemas.TaskConfig, ScanConfig: desc.Schemas.ScanConfig,
		AnalysisConfig: desc.Schemas.AnalysisConfig, Result: desc.Schemas.Result,
	}
	d.sources = maps.Clone(raw)
	for _, name := range typeNames {
		v, err := schema.ParseJSON(raw[name])
		if err != nil {
			d.errorf("the %s schema is not valid JSON: %v", name, err)
			continue
		}
		schemas[name] = v
	}
	if len(d.errs) > 0 {
		return nil, d.errs
	}

	// Step 2: canonical schemas of unwrapped templates.
	sched := api.Schedule{Kind: desc.Schedule.Kind, Template: desc.Schedule.Template}
	switch sched.Kind {
	case api.ScheduleKindCustom:
		sched.Template = ""
	case api.ScheduleKindTemplate:
		d.applyTemplate(sched.Template, schemas)
	default:
		d.errorf("unknown schedule kind %q", sched.Kind)
	}

	// Steps 3–5 per type.
	out := &api.Description{
		ProtocolVersion: in.ProtocolVersion,
		Connector:       api.ConnectorInfo{Language: in.Connector.Language, Version: in.Connector.Version},
		Schedule:        sched,
	}
	encoded := map[string]json.RawMessage{}
	paths := map[string]pathSet{}
	for _, name := range typeNames {
		s, ok := schemas[name].(map[string]any)
		if !ok {
			d.errorf("the %s schema must be a JSON object", name)
			continue
		}
		s = normalise(s)
		if t, _ := s["type"].(string); t != "object" {
			d.errorf("the %s schema root must be type object", name)
		}
		if name != Result {
			if ap, ok := s["additionalProperties"]; !ok || ap != false {
				d.errorf("the %s root allows unknown keys; config roots must reject them (additionalProperties: false)", name)
			}
		}
		c := &checker{d: d, name: name, root: s}
		c.walk(s, "#", "", 0, map[string]bool{}, false)
		paths[name] = c.paths
		b, err := marshalOrdered(s, readKeyOrder(d.sources[name]))
		if err != nil {
			d.errorf("the %s schema cannot be encoded: %v", name, err)
			continue
		}
		if len(b) > MaxSchemaBytes {
			d.errorf("the %s schema is %d bytes; the limit is %d", name, len(b), MaxSchemaBytes)
		}
		encoded[name] = b
	}
	out.Schemas = api.TypeSchemas{TaskConfig: encoded[TaskConfig], ScanConfig: encoded[ScanConfig], AnalysisConfig: encoded[AnalysisConfig], Result: encoded[Result]}
	out.SecretPaths = api.SecretPaths{
		TaskConfig: d.limit(TaskConfig, "secret", paths[TaskConfig].secrets), ScanConfig: d.limit(ScanConfig, "secret", paths[ScanConfig].secrets),
		AnalysisConfig: d.limit(AnalysisConfig, "secret", paths[AnalysisConfig].secrets), Result: d.limit(Result, "secret", paths[Result].secrets),
	}
	out.UploadPaths = api.UploadPaths{
		TaskConfig: d.limit(TaskConfig, "upload", paths[TaskConfig].uploads), ScanConfig: d.limit(ScanConfig, "upload", paths[ScanConfig].uploads),
	}
	out.FileRefPaths = d.limit(Result, "file reference", paths[Result].files)

	// Step 6: warnings (connector warnings first).
	out.Warnings = mergeWarnings(desc.Warnings, d.warnings)
	if len(d.errs) > 0 {
		return nil, d.errs
	}
	if b, err := json.Marshal(out); err == nil && len(b) > MaxOutputBytes {
		d.errorf("the description is %d bytes; the limit is %d", len(b), MaxOutputBytes)
		return nil, d.errs
	}
	return out, nil
}

// applyTemplate substitutes the canonical template schemas (docs/tasks.md §7 step 2).
func (d *deriver) applyTemplate(name string, schemas map[string]any) {
	def, ok := templates.Lookup(name)
	if !ok {
		d.errorf("the task uses template %q, which this runtime does not implement", name)
		return
	}
	info := def.Info()
	canonScan, err1 := schema.ParseJSON(info.ScanConfigSchema)
	canonAnalysis, err2 := schema.ParseJSON(info.AnalysisConfigSchema)
	if err1 != nil || err2 != nil {
		d.errorf("the canonical schemas of template %s cannot be read", name)
		return
	}
	if name == templates.Single {
		// Without a schedule the scan config must be empty; the task's own analysis config is kept,
		// since every analysis receives {} filled with its defaults.
		if props := properties(schemas[ScanConfig]); len(props) > 0 {
			d.errorf("a task without a schedule (template single) cannot declare a scan config, but it has %s", strings.Join(slices.Sorted(maps.Keys(props)), ", "))
		}
		schemas[ScanConfig] = canonScan
		d.sources[ScanConfig] = info.ScanConfigSchema
		d.checkEmptyAnalysisConfig(schemas[AnalysisConfig])
		return
	}
	d.warnings = append(d.warnings, CompareTemplate(name, ScanConfig, schemas[ScanConfig], canonScan)...)
	d.warnings = append(d.warnings, CompareTemplate(name, AnalysisConfig, schemas[AnalysisConfig], canonAnalysis)...)
	schemas[ScanConfig], schemas[AnalysisConfig] = canonScan, canonAnalysis
	d.sources[ScanConfig], d.sources[AnalysisConfig] = info.ScanConfigSchema, info.AnalysisConfigSchema
}

// checkEmptyAnalysisConfig warns when the analysis config of a task without a schedule rejects {} filled
// with its defaults, the config every analysis of such a task gets (docs/tasks.md §5.1). The Python and
// TypeScript/JavaScript connectors report this themselves; their warning is not repeated.
func (d *deriver) checkEmptyAnalysisConfig(s any) {
	for _, w := range d.connectorWarnings {
		if strings.Contains(w, "analysis config {}") {
			return
		}
	}
	m, ok := s.(map[string]any)
	if !ok {
		return // reported by the schema checks
	}
	doc := maps.Clone(m)
	delete(doc, "$id")
	delete(doc, "$schema")
	compiled, err := schema.CompileValue(doc)
	if err != nil {
		return // reported by the default checks of the walk
	}
	if issues := compiled.Validate(compiled.ApplyDefaults(map[string]any{})); len(issues) > 0 {
		d.warnings = append(d.warnings, "the task has no schedule, so every analysis gets the analysis config {} (filled with its defaults), "+
			"which the analysis config rejects ("+issues[0].String()+"); give its fields defaults or add a schedule")
	}
}

// CompareTemplate returns a message for every field where a connector's exported config schema (got,
// decoded with schema.ParseJSON) differs from the canonical schema of template (want): property names,
// required sets, type sets (nullable unions normalised), defaults and enums. describe reports them as
// warnings; the conformance harness requires none (docs/tasks.md §7 step 2, docs/protocol.md §12 D5).
func CompareTemplate(template, typ string, got, want any) []string {
	var out []string
	add := func(format string, args ...any) {
		out = append(out, fmt.Sprintf("%s of template %s: ", typ, template)+fmt.Sprintf(format, args...))
	}
	gp, wp := properties(got), properties(want)
	for _, name := range slices.Sorted(maps.Keys(wp)) {
		g, ok := gp[name]
		if !ok {
			add("the task's model lacks the canonical field %q", name)
			continue
		}
		gs, ws := resolve(got, g), resolve(want, wp[name])
		switch {
		case !slices.Equal(typeSet(got, gs), typeSet(want, ws)):
			add("field %q has type %v; the canonical type is %v", name, typeSet(got, gs), typeSet(want, ws))
		case !sameJSON(field(gs, "default"), field(ws, "default")):
			add("field %q has a different default than the canonical schema", name)
		case !sameJSON(enumOf(got, gs), enumOf(want, ws)):
			add("field %q has different enum values than the canonical schema", name)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(gp)) {
		if _, ok := wp[name]; !ok {
			add("field %q is not part of the canonical schema", name)
		}
	}
	if !slices.Equal(stringSet(field(got, "required")), stringSet(field(want, "required"))) {
		add("the required fields differ from the canonical schema")
	}
	return out
}

func properties(s any) map[string]any {
	m, _ := s.(map[string]any)
	props, _ := m["properties"].(map[string]any)
	return props
}

func field(s any, key string) any {
	m, _ := s.(map[string]any)
	return m[key]
}

// resolve follows a local $ref of s within root (one level is enough for field comparisons).
func resolve(root, s any) any {
	m, ok := s.(map[string]any)
	if !ok {
		return s
	}
	ref, ok := m["$ref"].(string)
	if !ok {
		return s
	}
	if target, ok := lookupRef(root, ref); ok {
		return target
	}
	return s
}

// lookupRef resolves a local JSON pointer reference ("#/$defs/X").
func lookupRef(root any, ref string) (any, bool) {
	if !strings.HasPrefix(ref, "#") {
		return nil, false
	}
	cur := root
	for _, seg := range strings.Split(strings.TrimPrefix(ref, "#"), "/")[1:] {
		seg = strings.ReplaceAll(strings.ReplaceAll(seg, "~1", "/"), "~0", "~")
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[seg]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// typeSet returns the sorted JSON types a field accepts, with nullable unions normalised.
func typeSet(root, s any) []string {
	set := map[string]bool{}
	var add func(s any, depth int)
	add = func(s any, depth int) {
		if depth > 8 {
			return
		}
		s = resolve(root, s)
		m, ok := s.(map[string]any)
		if !ok {
			return
		}
		switch t := m["type"].(type) {
		case string:
			set[t] = true
		case []any:
			for _, x := range t {
				if str, ok := x.(string); ok {
					set[str] = true
				}
			}
		}
		for _, k := range []string{"anyOf", "oneOf"} {
			if branches, ok := m[k].([]any); ok {
				for _, b := range branches {
					add(b, depth+1)
				}
			}
		}
		if c, ok := m["const"]; ok && m["type"] == nil {
			set[jsonType(c)] = true
		}
		if e, ok := m["enum"].([]any); ok && m["type"] == nil {
			for _, v := range e {
				set[jsonType(v)] = true
			}
		}
	}
	add(s, 0)
	if set["integer"] && set["number"] {
		delete(set, "integer")
	}
	return slices.Sorted(maps.Keys(set))
}

func jsonType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case json.Number, float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// enumOf returns the enum values of a field, ignoring a null member of a nullable enum.
func enumOf(root, s any) any {
	s = resolve(root, s)
	m, _ := s.(map[string]any)
	if e, ok := m["enum"].([]any); ok {
		out := make([]any, 0, len(e))
		for _, v := range e {
			if v != nil {
				out = append(out, v)
			}
		}
		return out
	}
	for _, k := range []string{"anyOf", "oneOf"} {
		if branches, ok := m[k].([]any); ok {
			for _, b := range branches {
				if e := enumOf(root, b); e != nil {
					return e
				}
			}
		}
	}
	return nil
}

func stringSet(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// sameJSON compares two decoded JSON values canonically (1 == 1.0).
func sameJSON(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ab, err1 := json.Marshal(a)
	bb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return reflect.DeepEqual(a, b)
	}
	ca, err1 := canonical.Transform(ab)
	cb, err2 := canonical.Transform(bb)
	return err1 == nil && err2 == nil && string(ca) == string(cb)
}

// normalise sets $schema, drops $id and drops every default that carries a secret (docs/tasks.md §6.5,
// §7 step 3).
func normalise(s map[string]any) map[string]any {
	delete(s, "$id")
	s["$schema"] = SchemaURL
	dropSecretDefaults(s, s, 0)
	return s
}

var (
	// instanceKeywords hold instance values, not subschemas.
	instanceKeywords = map[string]bool{"default": true, "examples": true, "const": true, "enum": true}
	// namedSubschemas map names to subschemas; the map itself is not a schema, so a property named
	// "default" is a subschema like any other.
	namedSubschemas = map[string]bool{"properties": true, "patternProperties": true, "$defs": true, "definitions": true, "dependentSchemas": true}
)

// dropSecretDefaults removes `default` from every schema node below v whose default carries a secret
// (carriesSecret). Connectors export such defaults masked (pydantic: "**********") or as null, and
// filling them in would make that value the secret. Every keyword is searched, also those outside the
// supported subset.
func dropSecretDefaults(root map[string]any, v any, depth int) {
	if depth > walkDepth {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		if def, ok := t["default"]; ok && carriesSecret(root, t, def, 0, map[string]bool{}) {
			delete(t, "default")
		}
		for k, child := range t {
			switch {
			case instanceKeywords[k]:
			case namedSubschemas[k]:
				named, _ := child.(map[string]any)
				for _, sub := range named {
					dropSecretDefaults(root, sub, depth+1)
				}
			default:
				dropSecretDefaults(root, child, depth+1)
			}
		}
	case []any:
		for _, child := range t {
			dropSecretDefaults(root, child, depth+1)
		}
	}
}

// carriesSecret reports whether value, as an instance of schema s, is or contains a writeOnly value: s
// itself, one of its anyOf/oneOf branches or a $ref target is writeOnly (pydantic puts writeOnly into a
// branch of `SecretStr | None`), or a property, additional property or array item of value is. refs holds
// the references already followed for this value, so cycles and shared definitions are visited once.
func carriesSecret(root map[string]any, s, value any, depth int, refs map[string]bool) bool {
	m, ok := s.(map[string]any)
	if !ok || depth > walkDepth {
		return false
	}
	if m["writeOnly"] == true {
		return true
	}
	if ref, ok := m["$ref"].(string); ok && !refs[ref] {
		refs[ref] = true
		if target, ok := lookupRef(root, ref); ok && carriesSecret(root, target, value, depth+1, refs) {
			return true
		}
	}
	for _, k := range []string{"anyOf", "oneOf"} {
		branches, _ := m[k].([]any)
		for _, b := range branches {
			if carriesSecret(root, b, value, depth+1, refs) {
				return true
			}
		}
	}
	switch inst := value.(type) {
	case map[string]any:
		props, _ := m["properties"].(map[string]any)
		for name, child := range inst {
			sub, listed := props[name]
			if !listed {
				sub = m["additionalProperties"]
			}
			if carriesSecret(root, sub, child, depth+1, map[string]bool{}) {
				return true
			}
		}
	case []any:
		for _, child := range inst {
			if carriesSecret(root, m["items"], child, depth+1, map[string]bool{}) {
				return true
			}
		}
	}
	return false
}

// Keywords of the supported subset (docs/tasks.md §6.4); x- keywords are annotations.
var subsetKeywords = map[string]bool{
	"type": true, "properties": true, "required": true, "additionalProperties": true, "propertyNames": true,
	"minLength": true, "maxLength": true, "pattern": true, "format": true, "minimum": true, "maximum": true,
	"exclusiveMinimum": true, "exclusiveMaximum": true, "multipleOf": true, "enum": true, "const": true,
	"oneOf": true, "anyOf": true, "items": true, "minItems": true, "maxItems": true, "uniqueItems": true,
	"$ref": true, "$defs": true, "title": true, "description": true, "default": true, "examples": true,
	"deprecated": true, "readOnly": true, "writeOnly": true, "$schema": true, "$comment": true, "discriminator": true,
}

const maxSafeInteger = 1<<53 - 1

// pathSet are the instance paths collected from one schema.
type pathSet struct {
	secrets, uploads, files []string
}

// checker walks one schema: subset warnings, nested closure warnings, default validation and the path
// lists (docs/tasks.md §6.2–§6.6, §7 steps 4–5).
type checker struct {
	d     *deriver
	name  string
	root  map[string]any
	paths pathSet
	seen  map[string]bool // reported warnings
}

func (c *checker) warn(loc, format string, args ...any) {
	msg := fmt.Sprintf("%s %s: %s", c.name, loc, fmt.Sprintf(format, args...))
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	if !c.seen[msg] {
		c.seen[msg] = true
		c.d.warnings = append(c.d.warnings, msg)
	}
}

// walk visits schema node s at schema location loc and instance path inst; branch is true for the
// members of a oneOf/anyOf.
func (c *checker) walk(s any, loc, inst string, depth int, refs map[string]bool, branch bool) {
	m, ok := s.(map[string]any)
	if !ok || depth > walkDepth {
		return
	}
	if ref, ok := m["$ref"].(string); ok {
		if refs[ref] {
			c.warn(loc, "recursive $ref %s is outside the supported subset", ref)
			return
		}
		target, ok := lookupRef(c.root, ref)
		if !ok {
			c.d.errorf("%s %s: $ref %s cannot be resolved (only local references are supported)", c.name, loc, ref)
			return
		}
		next := maps.Clone(refs)
		next[ref] = true
		c.walk(target, ref, inst, depth+1, next, branch)
	}
	c.collect(m, inst)
	c.checkKeywords(m, loc)
	if t, ok := m["type"].(string); ok && t == "null" && !branch {
		c.warn(loc, "type null is only supported in nullable unions")
	}
	c.checkDefault(m, loc)
	if props, ok := m["properties"].(map[string]any); ok {
		if depth > 0 && isObjectSchema(m) {
			if ap, has := m["additionalProperties"]; !has || ap == true {
				c.warn(loc, "the nested object allows unknown keys")
			}
		}
		for _, name := range slices.Sorted(maps.Keys(props)) {
			c.walk(props[name], loc+"/properties/"+escape(name), inst+"/"+escape(name), depth+1, refs, false)
		}
	}
	if ap, ok := m["additionalProperties"].(map[string]any); ok {
		c.walk(ap, loc+"/additionalProperties", inst+"/*", depth+1, refs, false)
	}
	if items, ok := m["items"].(map[string]any); ok {
		c.walk(items, loc+"/items", inst+"/*", depth+1, refs, false)
	}
	for _, k := range []string{"oneOf", "anyOf"} {
		if branches, ok := m[k].([]any); ok {
			c.checkUnion(k, branches, loc)
			for i, b := range branches {
				c.walk(b, loc+"/"+k+"/"+strconv.Itoa(i), inst, depth+1, refs, true)
			}
		}
	}
	if defs, ok := m["$defs"].(map[string]any); ok && depth == 0 {
		for _, name := range slices.Sorted(maps.Keys(defs)) {
			c.walkDefinition(defs[name], "#/$defs/"+escape(name))
		}
	}
}

// walkDefinition checks the keywords of a $defs entry that may not be referenced from a walked path.
func (c *checker) walkDefinition(s any, loc string) {
	if m, ok := s.(map[string]any); ok {
		c.checkKeywords(m, loc)
	}
}

func isObjectSchema(m map[string]any) bool {
	switch t := m["type"].(type) {
	case string:
		return t == "object"
	case []any:
		return slices.Contains(t, any("object"))
	}
	return true
}

func escape(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1") }

// collect records the instance path of writeOnly, upload and file annotations.
func (c *checker) collect(m map[string]any, inst string) {
	if m["writeOnly"] == true {
		c.paths.secrets = appendUnique(c.paths.secrets, inst)
	}
	switch m["x-scantor"] {
	case "upload":
		if c.name == TaskConfig || c.name == ScanConfig {
			c.paths.uploads = appendUnique(c.paths.uploads, inst)
		}
	case "file":
		if c.name == Result {
			c.paths.files = appendUnique(c.paths.files, inst)
		}
	}
}

func appendUnique(list []string, s string) []string {
	if slices.Contains(list, s) {
		return list
	}
	return append(list, s)
}

// limit enforces the path list limits: at most 256 paths of depth ≤ 16.
func (d *deriver) limit(typ, what string, paths []string) []string {
	if paths == nil {
		return []string{}
	}
	if len(paths) > MaxPaths {
		d.errorf("the %s schema has %d %s paths; the limit is %d", typ, len(paths), what, MaxPaths)
	}
	for _, p := range paths {
		if strings.Count(p, "/") > MaxPathDepth {
			d.errorf("the %s schema has the %s path %s deeper than %d levels", typ, what, p, MaxPathDepth)
		}
	}
	slices.Sort(paths)
	return paths
}

// checkKeywords warns about constructs outside the supported subset (docs/tasks.md §6.4).
func (c *checker) checkKeywords(m map[string]any, loc string) {
	for _, k := range slices.Sorted(maps.Keys(m)) {
		if !subsetKeywords[k] && !strings.HasPrefix(k, "x-") {
			c.warn(loc, "%s is outside the supported JSON Schema subset", k)
		}
	}
	if p, ok := m["pattern"].(string); ok {
		if _, err := regexp.Compile(p); err != nil {
			c.warn(loc, "pattern %q is not valid in RE2 (%v)", p, err)
		}
	}
	for _, k := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "default", "const"} {
		if n, ok := m[k].(json.Number); ok && !portable(n) {
			c.warn(loc, "%s %s is outside ±(2^53 − 1), which is not portable", k, n)
		}
	}
}

func portable(n json.Number) bool {
	if i, err := n.Int64(); err == nil {
		return i >= -maxSafeInteger && i <= maxSafeInteger
	}
	if f, err := n.Float64(); err == nil {
		if f != math.Trunc(f) {
			return true
		}
		return math.Abs(f) <= maxSafeInteger
	}
	b, ok := new(big.Int).SetString(n.String(), 10)
	return !ok || b.IsInt64()
}

// checkUnion warns about oneOf/anyOf outside the subset: allowed are nullable unions, titled const
// options and discriminated unions of objects.
func (c *checker) checkUnion(keyword string, branches []any, loc string) {
	nonNull := 0
	consts := 0
	objects := 0
	for _, b := range branches {
		m, _ := resolve(c.root, b).(map[string]any)
		switch {
		case m["type"] == "null":
		case m["const"] != nil:
			consts++
			nonNull++
		case isObjectBranch(m):
			objects++
			nonNull++
		default:
			nonNull++
		}
	}
	switch {
	case nonNull <= 1:
	case consts == nonNull:
	case objects == nonNull && c.discriminated(branches):
	default:
		c.warn(loc, "%s with these branches is outside the supported subset (nullable unions, titled options and discriminated unions are supported)", keyword)
	}
}

func isObjectBranch(m map[string]any) bool {
	_, hasProps := m["properties"]
	return m["type"] == "object" || hasProps
}

// discriminated reports whether every branch has a common property with distinct const values.
func (c *checker) discriminated(branches []any) bool {
	var common map[string]bool
	for _, b := range branches {
		props := properties(resolve(c.root, b))
		names := map[string]bool{}
		for name, p := range props {
			if pm, ok := resolve(c.root, p).(map[string]any); ok {
				if _, ok := pm["const"]; ok {
					names[name] = true
				} else if e, ok := pm["enum"].([]any); ok && len(e) == 1 {
					names[name] = true
				}
			}
		}
		if common == nil {
			common = names
			continue
		}
		for name := range common {
			if !names[name] {
				delete(common, name)
			}
		}
	}
	for name := range common {
		seen := map[string]bool{}
		distinct := true
		for _, b := range branches {
			pm, _ := resolve(c.root, properties(resolve(c.root, b))[name]).(map[string]any)
			v := pm["const"]
			if v == nil {
				if e, ok := pm["enum"].([]any); ok {
					v = e[0]
				}
			}
			key := fmt.Sprint(v)
			if seen[key] {
				distinct = false
				break
			}
			seen[key] = true
		}
		if distinct {
			return true
		}
	}
	return false
}

// checkDefault requires a default to validate against its own subschema (docs/tasks.md §6.3).
func (c *checker) checkDefault(m map[string]any, loc string) {
	def, ok := m["default"]
	if !ok {
		return
	}
	doc := maps.Clone(m)
	delete(doc, "default")
	delete(doc, "$schema")
	if defs, ok := c.root["$defs"]; ok {
		if _, own := doc["$defs"]; !own {
			doc["$defs"] = defs
		}
	}
	compiled, err := schema.CompileValue(doc)
	if err != nil {
		c.d.errorf("%s %s: the schema cannot be compiled: %v", c.name, loc, err)
		return
	}
	if issues := compiled.Validate(def); len(issues) > 0 {
		c.d.errorf("%s %s: the default does not validate against its schema: %s", c.name, loc, issues[0].String())
	}
}

// mergeWarnings puts the connector warnings first, without duplicates, at most 100 entries of at most
// 1000 characters each.
func mergeWarnings(lists ...[]string) []string {
	out := []string{}
	for _, list := range lists {
		for _, w := range list {
			if len([]rune(w)) > MaxWarningLen {
				w = string([]rune(w)[:MaxWarningLen-1]) + "…"
			}
			if len(out) == MaxWarnings {
				return out
			}
			if !slices.Contains(out, w) {
				out = append(out, w)
			}
		}
	}
	return out
}
