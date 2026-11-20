package schema

import (
	"encoding/json"
	"strings"
	"testing"
)

const effectiveSchema = `{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"n":{"type":"integer","minimum":1,"default":1},"nested":{"type":"object","properties":{"x":{"type":"integer","default":2}},"default":{}}},"additionalProperties":false}`

func TestEffectiveFillsDefaults(t *testing.T) {
	for _, raw := range []string{"", "null", " null\n", "{}"} {
		filled, issues, err := Effective(json.RawMessage(effectiveSchema), json.RawMessage(raw))
		if err != nil || len(issues) != 0 {
			t.Fatalf("%q: %v %v", raw, issues, err)
		}
		jsonEqual(t, filled, `{"greeting":"Hello","n":1,"nested":{"x":2}}`)
	}
	filled, issues, err := Effective(json.RawMessage(effectiveSchema), json.RawMessage(`{"greeting":"Hi","nested":{"x":5}}`))
	if err != nil || len(issues) != 0 {
		t.Fatal(issues, err)
	}
	jsonEqual(t, filled, `{"greeting":"Hi","n":1,"nested":{"x":5}}`)
}

func TestEffectiveIssues(t *testing.T) {
	filled, issues, err := Effective(json.RawMessage(effectiveSchema), json.RawMessage(`{"greeting":5,"n":0,"extra":true}`))
	if err != nil || filled == nil {
		t.Fatalf("filled %s, err %v", filled, err)
	}
	var paths []string
	for _, is := range issues {
		paths = append(paths, is.Path)
		if is.Keyword == KeywordInstance || is.Message == "" {
			t.Fatalf("issue %+v", is)
		}
	}
	// additionalProperties is reported at the object, the others at the offending value; sorted by path.
	if got := strings.Join(paths, ","); got != ",/greeting,/n" {
		t.Fatalf("paths %q (%+v)", got, issues)
	}

	_, issues, err = Effective(json.RawMessage(effectiveSchema), json.RawMessage(`[1]`))
	if err != nil || len(issues) != 1 || issues[0].Path != "" || issues[0].Keyword == KeywordInstance {
		t.Fatalf("root type: %+v %v", issues, err)
	}
}

func TestEffectiveUnfillable(t *testing.T) {
	for _, tc := range []struct {
		name, schema, raw string
	}{
		{"not JSON", effectiveSchema, `{"greeting":`},
		{"trailing data", effectiveSchema, `{} {}`},
		{"unbounded defaults", `{"type":"object","properties":{"a":{"$ref":"#","default":{}},"b":{"$ref":"#","default":{}}}}`, `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filled, issues, err := Effective(json.RawMessage(tc.schema), json.RawMessage(tc.raw))
			if err != nil || filled != nil || len(issues) != 1 || issues[0].Path != "" || issues[0].Keyword != KeywordInstance || issues[0].Message == "" {
				t.Fatalf("filled %s, issues %+v, err %v", filled, issues, err)
			}
		})
	}
}

func TestEffectiveInvalidSchema(t *testing.T) {
	for _, doc := range []string{`{"type": 5}`, `[1]`, `{`} {
		if _, _, err := Effective(json.RawMessage(doc), nil); err == nil {
			t.Errorf("%s compiled", doc)
		}
	}
}
