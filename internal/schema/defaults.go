package schema

import (
	"errors"
	"net/url"
	"reflect"
	"strconv"
	"strings"
)

const (
	// maxDefaultsDepth bounds the nesting of one application: instance levels plus $ref and allOf steps.
	maxDefaultsDepth = 128
	// maxDefaultsWork bounds the work of one ApplyDefaults call: every schema applied to an object or
	// array and every object or array copied from a default counts once. A recursive default (a property
	// whose $ref leads back to its own schema with a default) would otherwise grow the instance
	// exponentially within maxDefaultsDepth levels.
	maxDefaultsWork = 1 << 20
)

// ErrDefaultsUnbounded reports that filling the defaults of a schema exceeded maxDefaultsWork.
var ErrDefaultsUnbounded = errors.New("the defaults of the schema expand without bound (a recursive $ref with defaults?)")

// ApplyDefaults fills missing properties with deep copies of their defaults (see the package
// documentation for the exact semantics) and returns the instance. Objects and arrays of instance are
// modified in place. The work is bounded: a schema that keeps generating defaults stops being applied
// after maxDefaultsWork steps, and Fill reports that as ErrDefaultsUnbounded.
func (s *Schema) ApplyDefaults(instance any) any {
	instance, _ = s.applyDefaults(instance)
	return instance
}

// applyDefaults is ApplyDefaults that also reports whether the work stayed within its bound.
func (s *Schema) applyDefaults(instance any) (any, bool) {
	root, _ := s.doc.(map[string]any)
	d := defaulter{root: root, active: map[defaultsKey]bool{}, idle: map[defaultsKey]idleAt{}}
	d.apply(s.doc, instance, 0)
	return instance, !d.exhausted
}

// defaulter applies the defaults of one schema document to one instance.
//
// Applying a schema node to an object or array a second time while nothing was inserted in between is
// a no-op when the first application inserted nothing either (idle), so it is skipped; that keeps
// repeated $ref and allOf branches (diamonds) linear without changing the result. A node that is
// already being applied to the same instance further up the stack is a $ref or allOf cycle that consumes
// no instance level; it is skipped instead of being followed to maxDefaultsDepth, which doubles the work
// with every level for `allOf: [{$ref: "#"}, {$ref: "#"}]`.
type defaulter struct {
	root map[string]any
	// inserts counts the defaults inserted so far.
	inserts   int
	work      int
	exhausted bool
	active    map[defaultsKey]bool
	idle      map[defaultsKey]idleAt
}

// defaultsKey identifies a schema node applied to an object or array of the instance.
type defaultsKey struct {
	schema, instance uintptr
	length           int
}

// idleAt records an application that inserted nothing: the insert count at its end and its depth (a
// shallower application may reach further before maxDefaultsDepth).
type idleAt struct {
	inserts, depth int
}

func (d *defaulter) apply(node any, instance any, depth int) {
	sch, ok := node.(map[string]any)
	if !ok || depth > maxDefaultsDepth || d.exhausted {
		return
	}
	key := defaultsKey{schema: reflect.ValueOf(sch).Pointer()}
	switch inst := instance.(type) {
	case map[string]any:
		key.instance = reflect.ValueOf(inst).Pointer()
	case []any:
		if len(inst) == 0 {
			return
		}
		key.instance, key.length = reflect.ValueOf(inst).Pointer(), len(inst)
	default:
		return // nothing to fill in a scalar
	}
	if d.active[key] {
		return
	}
	if at, ok := d.idle[key]; ok && at.inserts == d.inserts && depth >= at.depth {
		return
	}
	if !d.charge(1) {
		return
	}
	d.active[key] = true
	defer delete(d.active, key)
	start := d.inserts

	if ref, ok := sch["$ref"].(string); ok {
		if target, ok := resolveLocalRef(d.root, ref); ok {
			d.apply(target, instance, depth+1)
		}
	}
	if all, ok := sch["allOf"].([]any); ok {
		for _, sub := range all {
			d.apply(sub, instance, depth+1)
		}
	}

	switch inst := instance.(type) {
	case map[string]any:
		props, _ := sch["properties"].(map[string]any)
		for name, sub := range props {
			subSchema, ok := sub.(map[string]any)
			if !ok {
				continue
			}
			if _, present := inst[name]; !present {
				if def, hasDefault := subSchema["default"]; hasDefault {
					inst[name] = d.copy(def)
					d.inserts++
				}
			}
			if v, present := inst[name]; present {
				d.apply(subSchema, v, depth+1)
			}
		}
		if additional, ok := sch["additionalProperties"].(map[string]any); ok {
			for name, v := range inst {
				if _, listed := props[name]; !listed {
					d.apply(additional, v, depth+1)
				}
			}
		}
	case []any:
		prefix, _ := sch["prefixItems"].([]any)
		for i, v := range inst {
			if i < len(prefix) {
				d.apply(prefix[i], v, depth+1)
				continue
			}
			if items, ok := sch["items"].(map[string]any); ok {
				d.apply(items, v, depth+1)
			}
		}
	}
	if d.inserts == start && !d.exhausted {
		d.idle[key] = idleAt{inserts: d.inserts, depth: depth}
	}
}

// charge counts n units of work and reports whether the bound still holds.
func (d *defaulter) charge(n int) bool {
	d.work += n
	if d.work > maxDefaultsWork {
		d.exhausted = true
	}
	return !d.exhausted
}

// copy returns a deep copy of a default and charges every object and array it allocates.
func (d *defaulter) copy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		d.charge(1)
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = d.copy(val)
		}
		return out
	case []any:
		d.charge(1)
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = d.copy(val)
		}
		return out
	default:
		return t
	}
}

// resolveLocalRef resolves "#" and "#/<json pointer>" references within the root document.
func resolveLocalRef(root map[string]any, ref string) (any, bool) {
	if !strings.HasPrefix(ref, "#") {
		return nil, false
	}
	frag, err := url.PathUnescape(ref[1:])
	if err != nil {
		return nil, false
	}
	var cur any = root
	if frag == "" {
		return cur, true
	}
	if !strings.HasPrefix(frag, "/") {
		return nil, false // anchors are not part of the supported subset
	}
	for _, tok := range strings.Split(frag[1:], "/") {
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		switch c := cur.(type) {
		case map[string]any:
			v, ok := c[tok]
			if !ok {
				return nil, false
			}
			cur = v
		case []any:
			i, err := strconv.Atoi(tok)
			if err != nil || i < 0 || i >= len(c) {
				return nil, false
			}
			cur = c[i]
		default:
			return nil, false
		}
	}
	return cur, true
}
