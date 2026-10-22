package scantor

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/mail"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// issue is one validation finding; path is an RFC 6901 pointer into the instance. Like ajv, missing
// and unknown properties are reported at the path of the object that contains them.
type issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// maxIssues bounds the issues reported for one value (error details are capped at 4 KiB).
const maxIssues = 20

// schemaRegistry resolves "$ref" values that point into other documents ("common.schema.json#/…").
// Exported task schemas only use local references, so the connector itself never needs one; tests use
// it to validate protocol messages against schemas/protocol.
type schemaRegistry map[string]any

// validator checks instances against the JSON Schema subset of docs/tasks.md §6.4 (draft 2020-12
// keywords; annotations and unknown keywords are ignored).
type validator struct {
	registry schemaRegistry
	issues   []issue
}

// validateSchema validates instance against a self-contained schema document.
func validateSchema(schema, instance any) []issue {
	v := &validator{}
	v.check(schema, schema, instance, "")
	return v.issues
}

func (v *validator) report(path, format string, args ...any) {
	if len(v.issues) < maxIssues {
		v.issues = append(v.issues, issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}
}

// matches reports whether instance is valid against schema without recording issues.
func (v *validator) matches(doc, schema, instance any) bool {
	sub := &validator{registry: v.registry}
	sub.check(doc, schema, instance, "")
	return len(sub.issues) == 0
}

// check validates instance against schema; doc is the document schema belongs to (for local $ref).
func (v *validator) check(doc, schema, instance any, path string) {
	switch s := schema.(type) {
	case bool:
		if !s {
			v.report(path, "is not allowed")
		}
		return
	case *object:
		v.checkObject(doc, s, instance, path)
	}
}

func (v *validator) checkObject(doc any, s *object, x any, path string) {
	if ref, ok := s.get("$ref"); ok {
		refStr, _ := ref.(string)
		target, targetDoc, err := v.resolve(doc, refStr)
		if err != nil {
			v.report(path, "schema error: %v", err)
		} else {
			v.check(targetDoc, target, x, path)
		}
	}
	if t, ok := s.get("type"); ok && !typeMatches(t, x) {
		v.report(path, "must be %s", describeType(t))
		return
	}
	if enum, ok := s.get("enum"); ok {
		if list, ok := enum.([]any); ok && !containsJSON(list, x) {
			v.report(path, "must be one of the allowed values")
		}
	}
	if c, ok := s.get("const"); ok && !jsonEqual(c, x) {
		v.report(path, "must be equal to the constant")
	}
	v.checkCombinators(doc, s, x, path)
	switch val := x.(type) {
	case *object:
		v.checkProperties(doc, s, val, path)
	case []any:
		v.checkItems(doc, s, val, path)
	case string:
		v.checkString(s, val, path)
	case json.Number:
		v.checkNumber(s, val, path)
	}
}

func (v *validator) checkCombinators(doc any, s *object, x any, path string) {
	if all, ok := s.get("allOf"); ok {
		for _, sub := range asList(all) {
			v.check(doc, sub, x, path)
		}
	}
	if anyOf, ok := s.get("anyOf"); ok {
		matched := false
		for _, sub := range asList(anyOf) {
			if v.matches(doc, sub, x) {
				matched = true
				break
			}
		}
		if !matched {
			v.report(path, "must match a schema in anyOf")
		}
	}
	if oneOf, ok := s.get("oneOf"); ok {
		n := 0
		for _, sub := range asList(oneOf) {
			if v.matches(doc, sub, x) {
				n++
			}
		}
		if n != 1 {
			v.report(path, "must match exactly one schema in oneOf")
		}
	}
	if not, ok := s.get("not"); ok && v.matches(doc, not, x) {
		v.report(path, "must NOT be valid against the schema in not")
	}
}

func (v *validator) checkProperties(doc any, s *object, o *object, path string) {
	if req, ok := s.get("required"); ok {
		for _, r := range asList(req) {
			name, _ := r.(string)
			if _, present := o.get(name); !present {
				v.report(path, "must have required property '%s'", name)
			}
		}
	}
	props := s.getObject("properties")
	var patterns []*regexp.Regexp
	var patternSchemas []any
	if pp := s.getObject("patternProperties"); pp != nil {
		for _, p := range pp.keys {
			re, err := compilePattern(p)
			if err != nil {
				v.report(path, "schema error: %v", err)
				continue
			}
			patterns = append(patterns, re)
			patternSchemas = append(patternSchemas, pp.values[p])
		}
	}
	additional, hasAdditional := s.get("additionalProperties")
	for _, key := range o.keys {
		val := o.values[key]
		child := path + "/" + escapePointer(key)
		known := false
		if props != nil {
			if ps, ok := props.get(key); ok {
				known = true
				v.check(doc, ps, val, child)
			}
		}
		for i, re := range patterns {
			if re.MatchString(key) {
				known = true
				v.check(doc, patternSchemas[i], val, child)
			}
		}
		if !known && hasAdditional {
			if b, ok := additional.(bool); ok && !b {
				v.report(path, "must NOT have additional property '%s'", key)
			} else {
				v.check(doc, additional, val, child)
			}
		}
		if names, ok := s.get("propertyNames"); ok && !v.matches(doc, names, key) {
			v.report(path, "property name '%s' is invalid", key)
		}
	}
	if n, ok := intKeyword(s, "minProperties"); ok && len(o.keys) < n {
		v.report(path, "must NOT have fewer than %d properties", n)
	}
	if n, ok := intKeyword(s, "maxProperties"); ok && len(o.keys) > n {
		v.report(path, "must NOT have more than %d properties", n)
	}
}

func (v *validator) checkItems(doc any, s *object, arr []any, path string) {
	start := 0
	if prefix, ok := s.get("prefixItems"); ok {
		list := asList(prefix)
		for i := 0; i < len(list) && i < len(arr); i++ {
			v.check(doc, list[i], arr[i], path+"/"+strconv.Itoa(i))
		}
		start = len(list)
	}
	if items, ok := s.get("items"); ok {
		for i := start; i < len(arr); i++ {
			v.check(doc, items, arr[i], path+"/"+strconv.Itoa(i))
		}
	}
	if n, ok := intKeyword(s, "minItems"); ok && len(arr) < n {
		v.report(path, "must NOT have fewer than %d items", n)
	}
	if n, ok := intKeyword(s, "maxItems"); ok && len(arr) > n {
		v.report(path, "must NOT have more than %d items", n)
	}
	if u, ok := s.get("uniqueItems"); ok && u == true {
		for i := range arr {
			for j := i + 1; j < len(arr); j++ {
				if jsonEqual(arr[i], arr[j]) {
					v.report(path, "must NOT have duplicate items (items %d and %d are identical)", i, j)
					return
				}
			}
		}
	}
}

func (v *validator) checkString(s *object, str string, path string) {
	length := utf8.RuneCountInString(str)
	if n, ok := intKeyword(s, "minLength"); ok && length < n {
		v.report(path, "must NOT have fewer than %d characters", n)
	}
	if n, ok := intKeyword(s, "maxLength"); ok && length > n {
		v.report(path, "must NOT have more than %d characters", n)
	}
	if p, ok := s.get("pattern"); ok {
		pattern, _ := p.(string)
		re, err := compilePattern(pattern)
		if err != nil {
			v.report(path, "schema error: %v", err)
		} else if !re.MatchString(str) {
			v.report(path, "must match pattern \"%s\"", pattern)
		}
	}
	if f, ok := s.get("format"); ok {
		format, _ := f.(string)
		if check, known := formats[format]; known && !check(str) {
			v.report(path, "must match format \"%s\"", format)
		}
	}
}

func (v *validator) checkNumber(s *object, n json.Number, path string) {
	x, ok := numberRat(n)
	if !ok {
		v.report(path, "must be a number")
		return
	}
	bound := func(key string) (*big.Rat, bool) {
		b, ok := s.get(key)
		if !ok {
			return nil, false
		}
		num, ok := b.(json.Number)
		if !ok {
			return nil, false
		}
		return numberRat(num)
	}
	if b, ok := bound("minimum"); ok && x.Cmp(b) < 0 {
		v.report(path, "must be >= %s", b.RatString())
	}
	if b, ok := bound("maximum"); ok && x.Cmp(b) > 0 {
		v.report(path, "must be <= %s", b.RatString())
	}
	if b, ok := bound("exclusiveMinimum"); ok && x.Cmp(b) <= 0 {
		v.report(path, "must be > %s", b.RatString())
	}
	if b, ok := bound("exclusiveMaximum"); ok && x.Cmp(b) >= 0 {
		v.report(path, "must be < %s", b.RatString())
	}
	if b, ok := bound("multipleOf"); ok && b.Sign() != 0 {
		if !new(big.Rat).Quo(x, b).IsInt() {
			v.report(path, "must be a multiple of %s", b.RatString())
		}
	}
}

// resolve follows a "$ref": "#/<pointer>" within doc, or "<name>#/<pointer>" through the registry.
func (v *validator) resolve(doc any, ref string) (any, any, error) {
	docPart, fragment, _ := strings.Cut(ref, "#")
	target := doc
	if docPart != "" {
		d, ok := v.registry[docPart]
		if !ok {
			return nil, nil, fmt.Errorf("unresolvable $ref %q", ref)
		}
		target = d
	}
	node, err := resolvePointer(target, fragment)
	if err != nil {
		return nil, nil, fmt.Errorf("$ref %q: %w", ref, err)
	}
	return node, target, nil
}

// resolvePointer follows an RFC 6901 pointer through decoded JSON.
func resolvePointer(doc any, pointer string) (any, error) {
	if pointer == "" {
		return doc, nil
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, fmt.Errorf("pointer %q must start with /", pointer)
	}
	node := doc
	for _, token := range strings.Split(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch n := node.(type) {
		case *object:
			next, ok := n.get(token)
			if !ok {
				return nil, fmt.Errorf("%q not found", token)
			}
			node = next
		case []any:
			i, err := strconv.Atoi(token)
			if err != nil || i < 0 || i >= len(n) {
				return nil, fmt.Errorf("index %q out of range", token)
			}
			node = n[i]
		default:
			return nil, fmt.Errorf("cannot descend into %q", token)
		}
	}
	return node, nil
}

func escapePointer(token string) string {
	return strings.ReplaceAll(strings.ReplaceAll(token, "~", "~0"), "/", "~1")
}

func typeMatches(t any, x any) bool {
	switch tt := t.(type) {
	case string:
		return isType(tt, x)
	case []any:
		for _, one := range tt {
			if name, ok := one.(string); ok && isType(name, x) {
				return true
			}
		}
		return false
	}
	return true
}

func isType(name string, x any) bool {
	switch name {
	case "object":
		_, ok := x.(*object)
		return ok
	case "array":
		_, ok := x.([]any)
		return ok
	case "string":
		_, ok := x.(string)
		return ok
	case "boolean":
		_, ok := x.(bool)
		return ok
	case "null":
		return x == nil
	case "number":
		_, ok := x.(json.Number)
		return ok
	case "integer":
		n, ok := x.(json.Number)
		if !ok {
			return false
		}
		r, ok := numberRat(n)
		return ok && r.IsInt()
	}
	return false
}

func describeType(t any) string {
	switch tt := t.(type) {
	case string:
		return tt
	case []any:
		names := make([]string, 0, len(tt))
		for _, n := range tt {
			if s, ok := n.(string); ok {
				names = append(names, s)
			}
		}
		return strings.Join(names, " or ")
	}
	return fmt.Sprint(t)
}

func containsJSON(list []any, x any) bool {
	for _, item := range list {
		if jsonEqual(item, x) {
			return true
		}
	}
	return false
}

func asList(v any) []any {
	list, _ := v.([]any)
	return list
}

func intKeyword(s *object, key string) (int, bool) {
	v, ok := s.get(key)
	if !ok {
		return 0, false
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := strconv.Atoi(string(n))
	return i, err == nil
}

var patternCache sync.Map // pattern string → *regexp.Regexp

// compilePattern compiles a JSON Schema pattern. The supported subset is ECMA-262 syntax that is also
// valid RE2 (docs/tasks.md §6.4), so Go's regexp agrees with ajv.
func compilePattern(pattern string) (*regexp.Regexp, error) {
	if re, ok := patternCache.Load(pattern); ok {
		return re.(*regexp.Regexp), nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("pattern %q is not a valid regular expression: %w", pattern, err)
	}
	patternCache.Store(pattern, re)
	return re, nil
}

var (
	uuidPattern     = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	durationPattern = regexp.MustCompile(`^P(?:\d+W|(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?)$`)
	hostnameLabel   = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	timePattern     = regexp.MustCompile(`^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$`)
)

// formats asserts the formats that ajv-formats and the platform's Go validator assert
// (docs/tasks.md §6.4); other formats are annotations.
var formats = map[string]func(string) bool{
	"date": func(s string) bool {
		_, err := time.Parse(time.DateOnly, s)
		return err == nil
	},
	"date-time": func(s string) bool {
		_, err := time.Parse(time.RFC3339Nano, s)
		return err == nil
	},
	"time": func(s string) bool {
		if !timePattern.MatchString(s) {
			return false
		}
		_, err := time.Parse("15:04:05", s[:8])
		return err == nil
	},
	"duration": func(s string) bool {
		return s != "P" && !strings.HasSuffix(s, "T") && durationPattern.MatchString(s)
	},
	"email": func(s string) bool {
		addr, err := mail.ParseAddress(s)
		return err == nil && addr.Address == s && addr.Name == ""
	},
	"hostname": func(s string) bool {
		if s == "" || len(s) > 253 {
			return false
		}
		for _, label := range strings.Split(strings.TrimSuffix(s, "."), ".") {
			if !hostnameLabel.MatchString(label) {
				return false
			}
		}
		return true
	},
	"ipv4": func(s string) bool {
		a, err := netip.ParseAddr(s)
		return err == nil && a.Is4()
	},
	"ipv6": func(s string) bool {
		a, err := netip.ParseAddr(s)
		return err == nil && a.Is6() && a.Zone() == ""
	},
	"uri": func(s string) bool {
		u, err := url.Parse(s)
		return err == nil && u.Scheme != ""
	},
	"uuid": uuidPattern.MatchString,
	"regex": func(s string) bool {
		_, err := regexp.Compile(s)
		return err == nil
	},
}
