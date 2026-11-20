package schema

import (
	"encoding/json"
	"slices"
	"testing"
)

func decodeJSON(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

const pointerDoc = `{"list":"u1","lists":["u2",null,"u4"],"byName":{"b":"u3","a":"u5"},"none":null,"a/b":{"~c":1},"deep":[{"x":{"y":1}},{"x":{"y":2}},{"z":3}]}`

func TestWalkPointer(t *testing.T) {
	doc := decodeJSON(t, pointerDoc)
	for _, tc := range []struct {
		pointer string
		want    []string
	}{
		{"/list", []string{"/list"}},
		{"/lists/*", []string{"/lists/0", "/lists/1", "/lists/2"}},
		{"/lists/2", []string{"/lists/2"}},
		{"/lists/3", nil},
		{"/lists/01", nil},
		{"/lists/-1", nil},
		{"/byName/*", []string{"/byName/a", "/byName/b"}},
		{"/none", []string{"/none"}},
		{"/missing", nil},
		{"/missing/*", nil},
		{"/list/x", nil},
		{"/a~1b/~0c", []string{"/a~1b/~0c"}},
		{"/*/~0c", []string{"/a~1b/~0c"}},
		{"/deep/*/x/y", []string{"/deep/0/x/y", "/deep/1/x/y"}},
		{"", []string{""}},
	} {
		var got []string
		WalkPointer(doc, tc.pointer, func(at string, _ any) { got = append(got, at) })
		if !slices.Equal(got, tc.want) {
			t.Errorf("%q: got %q, want %q", tc.pointer, got, tc.want)
		}
	}
	var values []any
	WalkPointer(doc, "/byName/*", func(_ string, v any) { values = append(values, v) })
	if !slices.Equal(values, []any{"u5", "u3"}) {
		t.Fatalf("values %v", values)
	}
}

func TestReplacePointer(t *testing.T) {
	doc := decodeJSON(t, pointerDoc)
	mask := func(_ string, v any) (any, bool) {
		if v == nil {
			return nil, false
		}
		return "***", true
	}
	for _, p := range []string{"/list", "/lists/*", "/byName/a", "/deep/*/x/y", "/missing", "/none", "/a~1b/~0c"} {
		if got := ReplacePointer(doc, p, mask); got == nil {
			t.Fatalf("%s: the root was dropped", p)
		}
	}
	want := `{"list":"***","lists":["***",null,"***"],"byName":{"b":"u3","a":"***"},"none":null,"a/b":{"~c":"***"},"deep":[{"x":{"y":"***"}},{"x":{"y":"***"}},{"z":3}]}`
	got, _ := json.Marshal(doc)
	jsonEqual(t, got, want)

	var seen []string
	ReplacePointer(doc, "/lists/*", func(at string, v any) (any, bool) {
		seen = append(seen, at)
		return nil, false
	})
	if !slices.Equal(seen, []string{"/lists/0", "/lists/1", "/lists/2"}) {
		t.Fatalf("seen %v", seen)
	}
	if again, _ := json.Marshal(doc); string(again) != string(got) {
		t.Fatalf("fn returning false changed the document: %s", again)
	}
}

func TestReplacePointerRoot(t *testing.T) {
	doc := decodeJSON(t, `{"a":1}`)
	root := ReplacePointer(doc, "", func(at string, _ any) (any, bool) {
		if at != "" {
			t.Fatalf("at %q", at)
		}
		return "***", true
	})
	if root != "***" {
		t.Fatalf("root %v", root)
	}
	if kept := ReplacePointer(doc, "", func(string, any) (any, bool) { return nil, false }); kept == nil {
		t.Fatal("the root was replaced although fn declined")
	}
	if scalar := ReplacePointer("x", "/a", func(string, any) (any, bool) { return 1, true }); scalar != "x" {
		t.Fatalf("scalar %v", scalar)
	}
}

func TestEscapePointer(t *testing.T) {
	if got := EscapePointer("a/b~c"); got != "a~1b~0c" {
		t.Fatalf("got %q", got)
	}
}
