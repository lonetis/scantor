package canonical

import (
	"math"
	"strings"
	"testing"
)

func TestTransform(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"b": 2, "a": 1}`, `{"a":1,"b":2}`},
		{` [ 1 , "x" , null , true , false ] `, `[1,"x",null,true,false]`},
		// RFC 8785 §3.2.3 sorting example: keys compared by UTF-16 code units.
		{`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}`,
			"{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"\u00f6\":\"Latin Small Letter O With Diaeresis\",\"\u20ac\":\"Euro Sign\",\"\U0001F600\":\"Emoji: Grinning Face\",\"\ufb33\":\"Hebrew Letter Dalet With Dagesh\"}"},
		{`{"s":"a\u0001b\u001f\"\\/\b\f\n\r\t"}`, `{"s":"a\u0001b\u001f\"\\/\b\f\n\r\t"}`},
		{`{"html":"<&>"}`, `{"html":"<&>"}`},
		{`{"n":[0, -0, 1.0, 1e3, 123456789012345680000, 1e21, 0.000001, 1e-7, -1.5, 3.0e-10]}`,
			`{"n":[0,0,1,1000,123456789012345680000,1e+21,0.000001,1e-7,-1.5,3e-10]}`},
		{`{"nested":{"z":{"y":1,"x":2},"a":[{"d":1,"c":2}]}}`, `{"nested":{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}}`},
	}
	for _, c := range cases {
		got, err := Transform([]byte(c.in))
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if string(got) != c.want {
			t.Errorf("Transform(%s)\n got %s\nwant %s", c.in, got, c.want)
		}
	}
}

func TestTransformRejects(t *testing.T) {
	for _, in := range []string{`{"a":1,"a":2}`, `{"a":1} x`, `1e400`, `[`, strings.Repeat("[", 2000) + strings.Repeat("]", 2000)} {
		if _, err := Transform([]byte(in)); err == nil {
			t.Errorf("Transform(%.40s) succeeded, want an error", in)
		}
	}
}

func TestFormatFloat(t *testing.T) {
	// Values from the ECMAScript and RFC 8785 test suites.
	cases := map[float64]string{
		1:                           "1",
		-1:                          "-1",
		0.1:                         "0.1",
		1e21:                        "1e+21",
		1e20:                        "100000000000000000000",
		1e-6:                        "0.000001",
		1e-7:                        "1e-7",
		123e-20:                     "1.23e-18",
		math.MaxFloat64:             "1.7976931348623157e+308",
		math.SmallestNonzeroFloat64: "5e-324",
		9007199254740991:            "9007199254740991",
		9007199254740993:            "9007199254740992",
		295147905179352830000:       "295147905179352830000",
		4.35:                        "4.35",
		0.002:                       "0.002",
		1.0000000000000002:          "1.0000000000000002",
		333333333.3333332:           "333333333.3333332",
	}
	for f, want := range cases {
		if got := FormatFloat(f); got != want {
			t.Errorf("FormatFloat(%v) = %s, want %s", f, got, want)
		}
	}
}

func TestHash(t *testing.T) {
	a, err := Hash([]byte(`{"value": 1, "name": "x"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Hash([]byte(`{"name":"x","value":1.0}`))
	if err != nil {
		t.Fatal(err)
	}
	if a != b || !strings.HasPrefix(a, HashPrefix) || len(a) != len(HashPrefix)+64 {
		t.Fatalf("hashes %s and %s", a, b)
	}
	// sha256 of `{"value":1}`.
	got, err := Hash([]byte(`{ "value" : 1.0 }`))
	if err != nil {
		t.Fatal(err)
	}
	if want := "sha256:48208f9428d64634bd8e28ff345bf0eab60d53c18fa2fbdb0b9bc1e84df2b5f6"; got != want {
		t.Fatalf("Hash = %s, want %s", got, want)
	}
}
