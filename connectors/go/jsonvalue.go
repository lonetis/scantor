package scantor

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
)

// object is a JSON object that keeps its keys in insertion order. Schemas keep the declaration order
// of their properties (forms render fields in that order), and re-encoded results keep the order in
// which encoding/json produced them.
type object struct {
	keys   []string
	values map[string]any
}

func newObject() *object {
	return &object{values: map[string]any{}}
}

func (o *object) get(key string) (any, bool) {
	v, ok := o.values[key]
	return v, ok
}

// getObject returns the value of key when it is an object.
func (o *object) getObject(key string) *object {
	v, _ := o.values[key].(*object)
	return v
}

func (o *object) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *object) remove(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			return
		}
	}
}

// clone returns a shallow copy.
func (o *object) clone() *object {
	c := &object{keys: append([]string(nil), o.keys...), values: make(map[string]any, len(o.values))}
	for k, v := range o.values {
		c.values[k] = v
	}
	return c
}

func (o *object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := marshalJSON(k)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		val, err := marshalJSON(o.values[k])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
		buf.Write(val)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// marshalJSON encodes v compactly without HTML escaping (protocol lines are not embedded in HTML).
func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// decodeValue parses one JSON document into ordered values: *object, []any, string, json.Number,
// bool or nil.
func decodeValue(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeNext(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func decodeNext(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := newObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("object key %v is not a string", keyTok)
				}
				v, err := decodeNext(dec)
				if err != nil {
					return nil, err
				}
				o.set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeNext(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		default:
			return nil, fmt.Errorf("unexpected %q", rune(t))
		}
	default:
		return t, nil
	}
}

// numberRat converts a JSON number to an exact rational.
func numberRat(n json.Number) (*big.Rat, bool) {
	return new(big.Rat).SetString(string(n))
}

// jsonEqual compares two decoded JSON values by JSON semantics (numbers by value, objects without
// regard to key order).
func jsonEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		rx, okx := numberRat(x)
		ry, oky := numberRat(y)
		return okx && oky && rx.Cmp(ry) == 0
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !jsonEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	case *object:
		y, ok := b.(*object)
		if !ok || len(x.values) != len(y.values) {
			return false
		}
		for k, v := range x.values {
			w, ok := y.values[k]
			if !ok || !jsonEqual(v, w) {
				return false
			}
		}
		return true
	default:
		return false
	}
}
