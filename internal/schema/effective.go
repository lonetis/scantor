package schema

import (
	"bytes"
	"encoding/json"
)

// KeywordInstance is the Keyword of the single root issue Effective reports when a config cannot be
// filled at all: it is not exactly one JSON value, or the schema's defaults expand without bound
// (ErrDefaultsUnbounded).
const KeywordInstance = "instance"

// Effective returns the effective config of raw under a described config schema (docs/tasks.md §6.3):
// the defaults filled with ajv's useDefaults semantics, then validated. An empty raw or JSON null means
// {}. Issues carry JSON pointers ("" is the root) and are sorted by path; the filled config is returned
// with them unless raw could not be filled (one root issue of KeywordInstance). The error is non-nil
// only when schemaDoc does not compile.
func Effective(schemaDoc, raw json.RawMessage) (json.RawMessage, []Issue, error) {
	s, err := Compile(schemaDoc)
	if err != nil {
		return nil, nil, err
	}
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		raw = json.RawMessage(`{}`)
	}
	filled, issues, err := s.Fill(raw)
	if err != nil {
		return nil, []Issue{{Path: "", Message: err.Error(), Keyword: KeywordInstance}}, nil
	}
	return filled, issues, nil
}
