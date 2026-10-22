package scantor

import (
	"strings"
	"testing"
)

func mustDecode(t *testing.T, s string) any {
	t.Helper()
	v, err := decodeValue([]byte(s))
	if err != nil {
		t.Fatalf("decode %s: %v", s, err)
	}
	return v
}

func TestValidateKeywords(t *testing.T) {
	cases := []struct {
		name     string
		schema   string
		instance string
		wantPath string // "" with wantOK
		wantOK   bool
		wantMsg  string
	}{
		{"type ok", `{"type":"integer"}`, `3`, "", true, ""},
		{"integer rejects fraction", `{"type":"integer"}`, `1.5`, "", false, "must be integer"},
		{"integer accepts 1.0", `{"type":"integer"}`, `1.0`, "", true, ""},
		{"nullable type", `{"type":["integer","null"]}`, `null`, "", true, ""},
		{"nullable type rejects string", `{"type":["integer","null"]}`, `"x"`, "", false, "must be integer or null"},
		{"enum", `{"enum":[1000,5000]}`, `5000.0`, "", true, ""},
		{"enum miss", `{"enum":[1000,5000]}`, `7`, "", false, "allowed values"},
		{"const", `{"const":{"a":[1,2]}}`, `{"a":[1,2]}`, "", true, ""},
		{"required at parent path", `{"type":"object","properties":{"a":{"type":"object","required":["b"]}}}`, `{"a":{}}`, "/a", false, "required property 'b'"},
		{"closed object", `{"type":"object","properties":{"a":{}},"additionalProperties":false}`, `{"a":1,"b":2}`, "", false, "additional property 'b'"},
		{"additional schema", `{"type":"object","additionalProperties":{"type":"string"}}`, `{"k":1}`, "/k", false, "must be string"},
		{"pointer escaping", `{"type":"object","additionalProperties":{"type":"string"}}`, `{"a/b~c":1}`, "/a~1b~0c", false, "must be string"},
		{"items", `{"type":"array","items":{"type":"string","minLength":2}}`, `["ab","c"]`, "/1", false, "fewer than 2 characters"},
		{"min items", `{"type":"array","minItems":1}`, `[]`, "", false, "fewer than 1 items"},
		{"unique items", `{"type":"array","uniqueItems":true}`, `[1,2,1.0]`, "", false, "duplicate"},
		{"length counts characters", `{"type":"string","maxLength":2}`, `"äö"`, "", true, ""},
		{"pattern", `{"type":"string","pattern":"^(global|[a-z]{2})$"}`, `"DE"`, "", false, "must match pattern"},
		{"minimum", `{"type":"integer","minimum":1}`, `0`, "", false, "must be >= 1"},
		{"maximum big", `{"type":"integer","maximum":9007199254740991}`, `9007199254740992`, "", false, "must be <= 9007199254740991"},
		{"exclusive", `{"type":"number","exclusiveMinimum":0}`, `0`, "", false, "must be > 0"},
		{"multipleOf", `{"type":"number","multipleOf":0.1}`, `0.3`, "", true, ""},
		{"anyOf null", `{"anyOf":[{"$ref":"#/$defs/A"},{"type":"null"}],"$defs":{"A":{"type":"object"}}}`, `null`, "", true, ""},
		{"anyOf miss", `{"anyOf":[{"type":"string"},{"type":"null"}]}`, `1`, "", false, "anyOf"},
		{"oneOf", `{"oneOf":[{"type":"integer"},{"type":"number"}]}`, `1`, "", false, "exactly one"},
		{"local ref", `{"$ref":"#/$defs/A","$defs":{"A":{"type":"string"}}}`, `1`, "", false, "must be string"},
		{"format uuid", `{"type":"string","format":"uuid"}`, `"targets.txt"`, "", false, "format \"uuid\""},
		{"format ipv4", `{"type":"string","format":"ipv4"}`, `"192.0.2.1"`, "", true, ""},
		{"format ipv4 rejects v6", `{"type":"string","format":"ipv4"}`, `"::1"`, "", false, "ipv4"},
		{"format date-time", `{"type":"string","format":"date-time"}`, `"2026-10-21T09:01:01.010Z"`, "", true, ""},
		{"format date", `{"type":"string","format":"date"}`, `"2026-13-01"`, "", false, "date"},
		{"format duration", `{"type":"string","format":"duration"}`, `"PT5M"`, "", true, ""},
		{"format email", `{"type":"string","format":"email"}`, `"a@example.org"`, "", true, ""},
		{"format hostname", `{"type":"string","format":"hostname"}`, `"-bad.example"`, "", false, "hostname"},
		{"unknown format is an annotation", `{"type":"string","format":"password"}`, `"x"`, "", true, ""},
		{"false schema", `false`, `1`, "", false, "not allowed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues := validateSchema(mustDecode(t, tc.schema), mustDecode(t, tc.instance))
			if tc.wantOK {
				if len(issues) > 0 {
					t.Fatalf("unexpected issues: %+v", issues)
				}
				return
			}
			if len(issues) == 0 {
				t.Fatal("expected an issue")
			}
			if issues[0].Path != tc.wantPath || !strings.Contains(issues[0].Message, tc.wantMsg) {
				t.Fatalf("got %+v, want path %q message containing %q", issues[0], tc.wantPath, tc.wantMsg)
			}
		})
	}
}

func TestValidateIssueCap(t *testing.T) {
	schema := mustDecode(t, `{"type":"array","items":{"type":"string"}}`)
	instance := mustDecode(t, `[`+strings.Repeat(`1,`, 100)+`1]`)
	if n := len(validateSchema(schema, instance)); n != maxIssues {
		t.Fatalf("got %d issues, want %d", n, maxIssues)
	}
}

func TestDecodeValueKeepsOrderAndNumbers(t *testing.T) {
	in := `{"z":1,"a":{"y":12345678901234567890,"b":[true,null,"s"]},"m":1.50}`
	v := mustDecode(t, in)
	out, err := marshalJSON(v)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Fatalf("round trip changed the document:\n got %s\nwant %s", out, in)
	}
	if _, err := decodeValue([]byte(`{"a":1} {}`)); err == nil {
		t.Fatal("trailing data must be rejected")
	}
}

func TestJSONEqual(t *testing.T) {
	if !jsonEqual(mustDecode(t, `{"a":[1,{"b":2.0}]}`), mustDecode(t, `{"a":[1.0,{"b":2}]}`)) {
		t.Fatal("equal documents compare unequal")
	}
	if jsonEqual(mustDecode(t, `{"a":1}`), mustDecode(t, `{"a":1,"b":null}`)) {
		t.Fatal("documents with different keys compare equal")
	}
}
