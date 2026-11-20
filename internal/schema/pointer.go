package schema

import (
	"slices"
	"strconv"
	"strings"
)

// Instance paths of a description (secretPaths, uploadPaths, fileRefPaths; schemas/describe.schema.json)
// are RFC 6901 JSON pointers whose segment `*` matches every array item and every object member. The
// empty pointer is the root. WalkPointer and ReplacePointer apply such a path to a decoded JSON value
// (maps, slices and scalars as produced by ParseJSON or encoding/json).

// WalkPointer calls fn for every value of doc that pointer matches, with the concrete, escaped pointer of
// the value (no `*`). Object members matched by `*` are visited in key order. Missing members and
// out-of-range indexes match nothing.
func WalkPointer(doc any, pointer string, fn func(at string, v any)) {
	walkPointer(doc, splitPointer(pointer), "", fn)
}

// ReplacePointer calls fn for every value of doc that pointer matches (as WalkPointer does) and replaces
// the value with the one fn returns when fn reports true. Objects and arrays of doc are modified in
// place; the returned value is the new root, which differs from doc only when the empty pointer matched
// and fn replaced the root.
func ReplacePointer(doc any, pointer string, fn func(at string, v any) (any, bool)) any {
	return replacePointer(doc, splitPointer(pointer), "", fn)
}

// EscapePointer escapes a property name as a JSON pointer reference token (RFC 6901).
func EscapePointer(token string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(token)
}

func splitPointer(p string) []string {
	if p == "" {
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	for i, s := range parts {
		parts[i] = strings.NewReplacer("~1", "/", "~0", "~").Replace(s)
	}
	return parts
}

func walkPointer(v any, segs []string, at string, fn func(at string, v any)) {
	if len(segs) == 0 {
		fn(at, v)
		return
	}
	seg, rest := segs[0], segs[1:]
	switch node := v.(type) {
	case map[string]any:
		if seg == "*" {
			for _, k := range sortedKeys(node) {
				walkPointer(node[k], rest, at+"/"+EscapePointer(k), fn)
			}
			return
		}
		if child, ok := node[seg]; ok {
			walkPointer(child, rest, at+"/"+EscapePointer(seg), fn)
		}
	case []any:
		if seg == "*" {
			for i, child := range node {
				walkPointer(child, rest, at+"/"+strconv.Itoa(i), fn)
			}
			return
		}
		if i, ok := arrayIndex(seg, len(node)); ok {
			walkPointer(node[i], rest, at+"/"+seg, fn)
		}
	}
}

func replacePointer(v any, segs []string, at string, fn func(at string, v any) (any, bool)) any {
	if len(segs) == 0 {
		if replaced, ok := fn(at, v); ok {
			return replaced
		}
		return v
	}
	seg, rest := segs[0], segs[1:]
	switch node := v.(type) {
	case map[string]any:
		if seg == "*" {
			for _, k := range sortedKeys(node) {
				node[k] = replacePointer(node[k], rest, at+"/"+EscapePointer(k), fn)
			}
			return node
		}
		if child, ok := node[seg]; ok {
			node[seg] = replacePointer(child, rest, at+"/"+EscapePointer(seg), fn)
		}
	case []any:
		if seg == "*" {
			for i, child := range node {
				node[i] = replacePointer(child, rest, at+"/"+strconv.Itoa(i), fn)
			}
			return node
		}
		if i, ok := arrayIndex(seg, len(node)); ok {
			node[i] = replacePointer(node[i], rest, at+"/"+seg, fn)
		}
	}
	return v
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// arrayIndex parses an array index token: digits only, within the array.
func arrayIndex(seg string, n int) (int, bool) {
	i, err := strconv.Atoi(seg)
	if err != nil || i < 0 || i >= n || strconv.Itoa(i) != seg {
		return 0, false
	}
	return i, true
}
