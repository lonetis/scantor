package describe

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
)

// The schemas are checked and normalised as decoded maps, and encoding/json writes map keys sorted. The
// order of properties is what forms render (docs/ui.md §6), so the output keeps the key order of the
// document each schema came from: the connector's description or the canonical template schema.

// keyOrder maps the JSON pointer of every object of a document to its keys in document order.
type keyOrder map[string][]string

// readKeyOrder records the key order of every object of raw. A document that cannot be read gives an
// empty order, which encodes every object with sorted keys.
func readKeyOrder(raw []byte) keyOrder {
	order := keyOrder{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := recordKeys(dec, order, ""); err != nil {
		return keyOrder{}
	}
	return order
}

func recordKeys(dec *json.Decoder, order keyOrder, ptr string) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return err
			}
			key, ok := tok.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			order[ptr] = append(order[ptr], key)
			if err := recordKeys(dec, order, ptr+"/"+escapePointerToken(key)); err != nil {
				return err
			}
		}
	case '[':
		for i := 0; dec.More(); i++ {
			if err := recordKeys(dec, order, ptr+"/"+strconv.Itoa(i)); err != nil {
				return err
			}
		}
	}
	_, err = dec.Token() // the closing delimiter
	return err
}

// marshalOrdered encodes v like json.Marshal, but writes the keys of every object in the order recorded
// for its pointer. Keys the source did not have (such as the $schema that normalisation adds) come first,
// sorted.
func marshalOrdered(v any, order keyOrder) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeOrdered(&buf, v, order, ""); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeOrdered(buf *bytes.Buffer, v any, order keyOrder, ptr string) error {
	switch t := v.(type) {
	case map[string]any:
		buf.WriteByte('{')
		for i, key := range orderedKeys(t, order[ptr]) {
			if i > 0 {
				buf.WriteByte(',')
			}
			encoded, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buf.Write(encoded)
			buf.WriteByte(':')
			if err := writeOrdered(buf, t[key], order, ptr+"/"+escapePointerToken(key)); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeOrdered(buf, item, order, ptr+"/"+strconv.Itoa(i)); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		encoded, err := json.Marshal(t)
		if err != nil {
			return err
		}
		buf.Write(encoded)
	}
	return nil
}

// orderedKeys returns the keys of m: those missing from known sorted, then the known ones in their order.
func orderedKeys(m map[string]any, known []string) []string {
	listed := make(map[string]bool, len(known))
	ordered := make([]string, 0, len(m))
	for _, key := range known {
		if _, ok := m[key]; ok && !listed[key] {
			listed[key] = true
			ordered = append(ordered, key)
		}
	}
	extra := make([]string, 0, len(m)-len(ordered))
	for key := range m {
		if !listed[key] {
			extra = append(extra, key)
		}
	}
	slices.Sort(extra)
	return append(extra, ordered...)
}

// escapePointerToken escapes a key as a JSON pointer reference token (RFC 6901).
func escapePointerToken(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}
