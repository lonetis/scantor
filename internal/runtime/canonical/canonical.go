// Package canonical implements the JSON Canonicalization Scheme (RFC 8785, JCS) and the item hash of
// scheduler checkpoints: "sha256:" + hex(SHA-256(JCS(config))) (docs/runtime.md §11.3,
// docs/templates.md §6).
//
// JCS: object members sorted by the UTF-16 code units of their names, no insignificant whitespace,
// numbers in ECMAScript Number.prototype.toString form (IEEE 754 double precision), strings with the
// minimal JSON escapes. Duplicate member names are rejected (I-JSON).
package canonical

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// HashPrefix prefixes every item hash.
const HashPrefix = "sha256:"

// maxDepth bounds nesting so hostile input cannot exhaust the stack.
const maxDepth = 1000

// Transform returns the canonical form of the JSON value raw.
func Transform(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var out bytes.Buffer
	if err := writeValue(&out, dec, 0); err != nil {
		return nil, fmt.Errorf("canonical JSON: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("canonical JSON: unexpected data after the value")
	}
	return out.Bytes(), nil
}

// Hash returns "sha256:" + the hex SHA-256 of the canonical form of raw.
func Hash(raw []byte) (string, error) {
	c, err := Transform(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return HashPrefix + hex.EncodeToString(sum[:]), nil
}

func writeValue(out *bytes.Buffer, dec *json.Decoder, depth int) error {
	if depth > maxDepth {
		return errors.New("nesting too deep")
	}
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			return writeObject(out, dec, depth)
		case '[':
			return writeArray(out, dec, depth)
		default:
			return fmt.Errorf("unexpected delimiter %q", t)
		}
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(t))
	case json.Number:
		s, err := Number(string(t))
		if err != nil {
			return err
		}
		out.WriteString(s)
	case string:
		writeString(out, t)
	default:
		return fmt.Errorf("unexpected token %v", tok)
	}
	return nil
}

type member struct {
	key   string
	units []uint16
	value []byte
}

func writeObject(out *bytes.Buffer, dec *json.Decoder, depth int) error {
	var members []member
	seen := map[string]bool{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := tok.(string)
		if !ok {
			return fmt.Errorf("object key is %T", tok)
		}
		if seen[key] {
			return fmt.Errorf("duplicate member name %q", key)
		}
		seen[key] = true
		var value bytes.Buffer
		if err := writeValue(&value, dec, depth+1); err != nil {
			return err
		}
		members = append(members, member{key: key, units: utf16.Encode([]rune(key)), value: value.Bytes()})
	}
	if _, err := dec.Token(); err != nil { // '}'
		return err
	}
	slices.SortFunc(members, func(a, b member) int { return slices.Compare(a.units, b.units) })
	out.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			out.WriteByte(',')
		}
		writeString(out, m.key)
		out.WriteByte(':')
		out.Write(m.value)
	}
	out.WriteByte('}')
	return nil
}

func writeArray(out *bytes.Buffer, dec *json.Decoder, depth int) error {
	out.WriteByte('[')
	for i := 0; dec.More(); i++ {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeValue(out, dec, depth+1); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil { // ']'
		return err
	}
	out.WriteByte(']')
	return nil
}

const hexDigits = "0123456789abcdef"

// writeString writes s with the escapes of ECMAScript JSON.stringify: \" \\ \b \f \n \r \t, other
// control characters as \u00xx, everything else literally.
func writeString(out *bytes.Buffer, s string) {
	out.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteByte(hexDigits[r>>4])
				out.WriteByte(hexDigits[r&0xf])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

// Number formats a JSON number literal as ECMAScript Number.prototype.toString does for the nearest
// IEEE 754 double.
func Number(literal string) (string, error) {
	f, err := strconv.ParseFloat(literal, 64)
	if err != nil {
		return "", fmt.Errorf("number %s: %w", literal, err)
	}
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return "", fmt.Errorf("number %s is not finite", literal)
	}
	return FormatFloat(f), nil
}

// FormatFloat formats a finite double like ECMAScript Number.prototype.toString.
func FormatFloat(f float64) string {
	if f == 0 {
		return "0" // also -0
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// Shortest round-trip digits: "d.ddddde±xx".
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, expText, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expText)
	k := len(digits)
	n := exp + 1 // the value is 0.digits × 10^n
	var b strings.Builder
	b.WriteString(sign)
	switch {
	case k <= n && n <= 21:
		b.WriteString(digits)
		b.WriteString(strings.Repeat("0", n-k))
	case 0 < n && n <= 21:
		b.WriteString(digits[:n])
		b.WriteByte('.')
		b.WriteString(digits[n:])
	case -6 < n && n <= 0:
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", -n))
		b.WriteString(digits)
	default:
		b.WriteByte(digits[0])
		if k > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		b.WriteByte('e')
		if n-1 >= 0 {
			b.WriteByte('+')
		}
		b.WriteString(strconv.Itoa(n - 1))
	}
	return b.String()
}
