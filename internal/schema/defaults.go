package schema

import (
	"net/url"
	"strconv"
	"strings"
)

// maxDefaultsDepth bounds schema traversal for reference cycles that do not consume instance depth.
const maxDefaultsDepth = 128

// ApplyDefaults fills missing properties with deep copies of their defaults (see the package
// documentation for the exact semantics) and returns the instance. Objects and arrays of instance are
// modified in place.
func (s *Schema) ApplyDefaults(instance any) any {
	root, _ := s.doc.(map[string]any)
	applyDefaults(root, s.doc, instance, 0)
	return instance
}

func applyDefaults(root map[string]any, node any, instance any, depth int) {
	sch, ok := node.(map[string]any)
	if !ok || depth > maxDefaultsDepth {
		return
	}
	if ref, ok := sch["$ref"].(string); ok {
		if target, ok := resolveLocalRef(root, ref); ok {
			applyDefaults(root, target, instance, depth+1)
		}
	}
	if all, ok := sch["allOf"].([]any); ok {
		for _, sub := range all {
			applyDefaults(root, sub, instance, depth+1)
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
					inst[name] = deepCopy(def)
				}
			}
			if v, present := inst[name]; present {
				applyDefaults(root, subSchema, v, depth+1)
			}
		}
		if additional, ok := sch["additionalProperties"].(map[string]any); ok {
			for name, v := range inst {
				if _, listed := props[name]; !listed {
					applyDefaults(root, additional, v, depth+1)
				}
			}
		}
	case []any:
		prefix, _ := sch["prefixItems"].([]any)
		for i, v := range inst {
			if i < len(prefix) {
				applyDefaults(root, prefix[i], v, depth+1)
				continue
			}
			if items, ok := sch["items"].(map[string]any); ok {
				applyDefaults(root, items, v, depth+1)
			}
		}
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

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopy(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = deepCopy(val)
		}
		return out
	default:
		return t
	}
}
