package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// apiMaxInputBytes bounds one JSON value or file read from a flag, a file or stdin; the orchestrator
// caps request bodies far below this (SCANTOR_MAX_REQUEST_BYTES).
const apiMaxInputBytes = 64 << 20

// apiInputs reads command inputs given inline, as @file or as - (stdin). Stdin can be consumed by only
// one input per command.
type apiInputs struct {
	app       *App
	stdinUsed string
}

func newAPIInputs(app *App) *apiInputs { return &apiInputs{app: app} }

// bytes returns the raw bytes of a source: "-" reads stdin, "@path" reads a file, anything else is
// the value itself.
func (in *apiInputs) bytes(name, value string) ([]byte, error) {
	switch {
	case value == "-":
		return in.stdin(name)
	case strings.HasPrefix(value, "@"):
		return in.file(name, strings.TrimPrefix(value, "@"))
	default:
		return []byte(value), nil
	}
}

// stdin reads all of stdin for the input name.
func (in *apiInputs) stdin(name string) ([]byte, error) {
	if in.stdinUsed != "" {
		return nil, UsageError(fmt.Errorf("%s: stdin is already used by %s", name, in.stdinUsed))
	}
	in.stdinUsed = name
	return apiReadLimited(in.app.Stdin, name+" (stdin)")
}

// file reads a local file for the input name.
func (in *apiInputs) file(name, path string) ([]byte, error) {
	if path == "" {
		return nil, UsageError(fmt.Errorf("%s: missing file name after @", name))
	}
	f, err := os.Open(path) //nolint:gosec // the user names the file to read
	if err != nil {
		return nil, ValidationError(fmt.Errorf("%s: %w", name, err))
	}
	defer f.Close()
	return apiReadLimited(f, name+" ("+path+")")
}

func apiReadLimited(r io.Reader, what string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, apiMaxInputBytes+1))
	if err != nil {
		return nil, ValidationError(fmt.Errorf("read %s: %w", what, err))
	}
	if len(data) > apiMaxInputBytes {
		return nil, ValidationError(fmt.Errorf("%s exceeds %s", what, HumanBytes(apiMaxInputBytes)))
	}
	return data, nil
}

// apiJSONKind is the JSON type an input must have.
type apiJSONKind int

const (
	apiJSONObject apiJSONKind = iota
	apiJSONArray
)

// json parses a JSON input of the given kind; an empty value means "not given" and returns nil.
func (in *apiInputs) json(name, value string, kind apiJSONKind) (json.RawMessage, error) {
	if value == "" {
		return nil, nil
	}
	data, err := in.bytes(name, value)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimSpace(data)
	if !json.Valid(data) {
		return nil, ValidationError(fmt.Errorf("%s is not valid JSON (use an inline value, @file or - for stdin)", name))
	}
	want, opening := "an object", byte('{')
	if kind == apiJSONArray {
		want, opening = "an array", '['
	}
	if len(data) == 0 || data[0] != opening {
		return nil, ValidationError(fmt.Errorf("%s must be %s", name, want))
	}
	return json.RawMessage(data), nil
}

// object parses a JSON object input; an empty value returns nil.
func (in *apiInputs) object(name, value string) (json.RawMessage, error) {
	return in.json(name, value, apiJSONObject)
}

// decodeStrict decodes a JSON object input into v and rejects unknown fields; it reports whether a value
// was given.
func (in *apiInputs) decodeStrict(name, value string, v any) (bool, error) {
	raw, err := in.object(name, value)
	if err != nil || raw == nil {
		return false, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return false, ValidationError(fmt.Errorf("%s: %w", name, err))
	}
	if dec.More() {
		return false, ValidationError(errors.New(name + ": trailing data after the JSON object"))
	}
	return true, nil
}
