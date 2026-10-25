package manifest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// position is a 1-based line and column in scantor.yaml.
type position struct {
	line, column int
}

// document is a parsed YAML manifest: its JSON value and the position of every instance path.
type document struct {
	value     any
	positions map[string]position
}

var yamlLinePattern = regexp.MustCompile(`line (\d+)`)

// parseYAML parses exactly one YAML document and converts it into a JSON-compatible value (maps,
// slices, strings, bools, nil and json.Number), recording the position of every value. Duplicate keys,
// non-string keys and values JSON cannot represent are errors.
func parseYAML(data []byte) (*document, []Issue) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var root yaml.Node
	if err := dec.Decode(&root); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, []Issue{{Rule: "M1", Line: 1, Message: "the manifest is empty"}}
		}
		return nil, []Issue{yamlError(err)}
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err == nil {
		return nil, []Issue{{Rule: "M1", Line: extra.Line, Message: "the manifest must contain exactly one YAML document"}}
	} else if !errors.Is(err, io.EOF) {
		return nil, []Issue{yamlError(err)}
	}
	c := converter{positions: map[string]position{}}
	value, err := c.convert(&root, "", 0, false)
	if err != nil {
		return nil, c.issues
	}
	if len(c.issues) > 0 {
		return nil, c.issues
	}
	if _, ok := value.(map[string]any); !ok {
		line := root.Line
		if len(root.Content) > 0 {
			line = root.Content[0].Line
		}
		return nil, []Issue{{Rule: "M1", Line: line, Message: "the manifest root must be a mapping"}}
	}
	return &document{value: value, positions: c.positions}, nil
}

func yamlError(err error) Issue {
	msg := strings.TrimPrefix(err.Error(), "yaml: ")
	line := 0
	if m := yamlLinePattern.FindStringSubmatch(msg); m != nil {
		line, _ = strconv.Atoi(m[1])
		msg = strings.TrimSpace(yamlLinePattern.ReplaceAllString(msg, ""))
		msg = strings.TrimPrefix(msg, ": ")
	}
	return Issue{Rule: "M1", Line: line, Message: "invalid YAML: " + msg}
}

const (
	maxYAMLDepth = 64
	// maxYAMLNodes, maxYAMLScalarBytes and maxYAMLPointerBytes bound the expanded document. yaml.v3
	// checks its alias ratio only when it decodes into Go values, never into a yaml.Node, so the
	// converter counts every value it produces, aliases and merge sources included: nested anchors
	// (billion laughs) would otherwise expand a few hundred bytes into gigabytes. The pointer budget
	// charges the instance path of every value, which contains every key above it, so it also bounds
	// the keys a long key repeated through aliases, or above many values, makes the converter, the JSON
	// encoding and the schema validator copy. An ordinary manifest of MaxBytes stays far below all three.
	maxYAMLNodes        = 1 << 17
	maxYAMLScalarBytes  = 1 << 20
	maxYAMLPointerBytes = 4 << 20
)

type converter struct {
	positions    map[string]position
	issues       []Issue
	nodes        int
	scalarBytes  int
	pointerBytes int
}

var errConvert = errors.New("convert")

func (c *converter) fail(n *yaml.Node, format string, args ...any) error {
	c.issues = append(c.issues, Issue{Rule: "M1", Line: n.Line, Column: n.Column, Message: fmt.Sprintf(format, args...)})
	return errConvert
}

// convert converts the node n at the instance path ptr. inAlias is set below an alias: such values
// record no position, so document.position reports the alias, and an expansion adds no map entries.
func (c *converter) convert(n *yaml.Node, ptr string, depth int, inAlias bool) (any, error) {
	if depth > maxYAMLDepth {
		return nil, c.fail(n, "the manifest is nested too deeply")
	}
	c.nodes++
	if c.nodes > maxYAMLNodes {
		return nil, c.fail(n, "the manifest expands to more than %d values (check its anchors and aliases)", maxYAMLNodes)
	}
	c.pointerBytes += len(ptr)
	if c.pointerBytes > maxYAMLPointerBytes {
		return nil, c.fail(n, "the manifest expands to more than %d bytes of keys and paths (check its anchors, aliases and key lengths)", maxYAMLPointerBytes)
	}
	if n.Kind == yaml.ScalarNode {
		c.scalarBytes += len(n.Value)
		if c.scalarBytes > maxYAMLScalarBytes {
			return nil, c.fail(n, "the manifest expands to more than %d bytes of values (check its anchors and aliases)", maxYAMLScalarBytes)
		}
	}
	if _, seen := c.positions[ptr]; !seen && !inAlias {
		c.positions[ptr] = position{n.Line, n.Column}
	}
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return c.convert(n.Content[0], ptr, depth+1, inAlias)
	case yaml.AliasNode:
		if n.Alias == nil {
			return nil, c.fail(n, "unknown alias")
		}
		return c.convert(n.Alias, ptr, depth+1, true)
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for i, item := range n.Content {
			v, err := c.convert(item, ptr+"/"+strconv.Itoa(i), depth+1, inAlias)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		return c.mapping(n, ptr, depth, inAlias)
	case yaml.ScalarNode:
		return c.scalar(n)
	default:
		return nil, c.fail(n, "unsupported YAML node")
	}
}

func (c *converter) mapping(n *yaml.Node, ptr string, depth int, inAlias bool) (any, error) {
	out := map[string]any{}
	explicit := map[string]int{}
	var merges []*yaml.Node
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		if key.Kind == yaml.ScalarNode && key.ShortTag() == "!!merge" {
			merges = append(merges, val)
			continue
		}
		if key.Kind != yaml.ScalarNode || key.ShortTag() != "!!str" {
			return nil, c.fail(key, "mapping keys must be strings")
		}
		if first, dup := explicit[key.Value]; dup {
			return nil, c.fail(key, "duplicate key %q (first defined at line %d)", key.Value, first)
		}
		explicit[key.Value] = key.Line
		childPtr := ptr + "/" + escapePointer(key.Value)
		v, err := c.convert(val, childPtr, depth+1, inAlias)
		if err != nil {
			return nil, err
		}
		out[key.Value] = v
	}
	for _, m := range merges {
		sources := []*yaml.Node{m}
		if m.Kind == yaml.SequenceNode {
			sources = m.Content
		}
		for _, src := range sources {
			v, err := c.convert(src, ptr, depth+1, inAlias)
			if err != nil {
				return nil, err
			}
			merged, ok := v.(map[string]any)
			if !ok {
				return nil, c.fail(src, "merge keys must reference mappings")
			}
			for k, mv := range merged {
				if _, set := out[k]; !set {
					out[k] = mv
				}
			}
		}
	}
	return out, nil
}

func (c *converter) scalar(n *yaml.Node) (any, error) {
	switch n.ShortTag() {
	case "!!null":
		return nil, nil
	case "!!bool":
		var b bool
		if err := n.Decode(&b); err != nil {
			return nil, c.fail(n, "invalid boolean %q", n.Value)
		}
		return b, nil
	case "!!int":
		var i int64
		if err := n.Decode(&i); err != nil {
			return nil, c.fail(n, "integer %q is out of range", n.Value)
		}
		return json.Number(strconv.FormatInt(i, 10)), nil
	case "!!float":
		var f float64
		if err := n.Decode(&f); err != nil {
			return nil, c.fail(n, "invalid number %q", n.Value)
		}
		if math.IsInf(f, 0) || math.IsNaN(f) {
			return nil, c.fail(n, "number %q cannot be represented in JSON", n.Value)
		}
		return json.Number(strconv.FormatFloat(f, 'g', -1, 64)), nil
	case "!!binary":
		return nil, c.fail(n, "binary values are not allowed")
	default:
		// !!str, !!timestamp (kept as written) and custom tags are strings.
		return n.Value, nil
	}
}

func escapePointer(s string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(s)
}

// position returns the position of the value at ptr, falling back to the closest existing parent.
func (d *document) position(ptr string) position {
	for {
		if p, ok := d.positions[ptr]; ok {
			return p
		}
		i := strings.LastIndex(ptr, "/")
		if i < 0 {
			return position{1, 1}
		}
		ptr = ptr[:i]
	}
}
