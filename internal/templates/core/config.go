package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/schema"
	"github.com/lonetis/scantor/internal/version"
)

// DecodeConfig decodes a scan config into v. Unknown fields are rejected, and integral numbers in any
// JSON spelling (1, 1.0, 1e3) decode into integer fields, as JSON Schema's `integer` accepts them.
// Failures are validation errors.
func DecodeConfig(raw json.RawMessage, v any) error {
	normalised, err := normaliseIntegers(raw)
	if err != nil {
		return Validationf("invalid scan config: %v", err)
	}
	dec := json.NewDecoder(bytes.NewReader(normalised))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return Validationf("invalid scan config: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Validationf("invalid scan config: unexpected data after the JSON value")
	}
	return nil
}

// normaliseIntegers rewrites integral numbers to their plain decimal form.
func normaliseIntegers(raw json.RawMessage) ([]byte, error) {
	v, err := schema.ParseJSON(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(rewriteNumbers(v))
}

func rewriteNumbers(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			t[k] = rewriteNumbers(val)
		}
	case []any:
		for i, val := range t {
			t[i] = rewriteNumbers(val)
		}
	case json.Number:
		if n, ok := integral(t.String()); ok {
			return json.Number(n)
		}
	}
	return v
}

// integral returns the plain decimal form of a JSON number with an integral value. Exponents beyond
// ±400 are left alone (they cannot fit an integer field, and big.Rat would expand them).
func integral(s string) (string, bool) {
	i := strings.IndexAny(s, "eE")
	if i < 0 && !strings.Contains(s, ".") {
		return s, false
	}
	if i >= 0 {
		exp, err := strconv.Atoi(s[i+1:])
		if err != nil || exp > 400 || exp < -400 {
			return s, false
		}
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok || !r.IsInt() {
		return s, false
	}
	return r.Num().String(), true
}

// EncodeItem marshals an analysis config (or a resolved scan config) compactly without HTML
// escaping, so the bytes stay close to their canonical JSON form.
func EncodeItem(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("encode JSON: %w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// DecodeProvenance decodes a resolution's provenance into the typed v. Provenance maps hold Go values
// right after Resolve and generic JSON values after a round trip through the orchestrator; both decode
// the same way. Failures are validation errors (a stored resolution that does not fit the template).
func DecodeProvenance(provenance map[string]any, v any) error {
	raw, err := json.Marshal(provenance)
	if err != nil {
		return Validationf("invalid resolution provenance: %v", err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return Validationf("invalid resolution provenance: %v", err)
	}
	return nil
}

// ProvenanceMap converts a typed provenance struct into the map of Resolution.Provenance.
func ProvenanceMap(v any) (map[string]any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// ResolutionFromJSON builds a Resolution from its stored JSON parts (the orchestrator's
// scheduling.resolved.<key> record or the response of POST /api/runtime/scheduler/resolved).
func ResolutionFromJSON(scanConfig, provenance json.RawMessage, expectedTotal *int64) (Resolution, error) {
	res := Resolution{ScanConfig: scanConfig, Provenance: map[string]any{}, ExpectedTotal: expectedTotal}
	if len(bytes.TrimSpace(provenance)) > 0 && !bytes.Equal(bytes.TrimSpace(provenance), []byte("null")) {
		dec := json.NewDecoder(bytes.NewReader(provenance))
		dec.UseNumber()
		if err := dec.Decode(&res.Provenance); err != nil {
			return Resolution{}, fmt.Errorf("decode provenance: %w", err)
		}
	}
	return res, nil
}

// FormatTime renders t as ISO 8601 UTC with milliseconds, the format of provenance.fetchedAt.
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// DefaultUserAgent is the User-Agent of data-source requests (docs/templates.md §7.2).
func DefaultUserAgent() string {
	return version.UserAgent("scantor") + " (+https://github.com/lonetis/scantor)"
}
