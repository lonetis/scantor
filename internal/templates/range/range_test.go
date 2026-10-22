package ranges_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	ranges "github.com/lonetis/scantor/internal/templates/range"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

// pythonRange is the reference: Python's range(start, end, step).
func pythonRange(start, end, step int64) []int64 {
	var out []int64
	for v := start; (step > 0 && v < end) || (step < 0 && v > end); v += step {
		out = append(out, v)
	}
	return out
}

func TestMatchesPythonRange(t *testing.T) {
	tmpl := ranges.New()
	for start := int64(-7); start <= 7; start++ {
		for end := int64(-7); end <= 7; end++ {
			for _, step := range []int64{-4, -3, -1, 1, 2, 5} {
				cfg := json.RawMessage(fmt.Sprintf(`{"start":%d,"end":%d,"step":%d}`, start, end, step))
				want := pythonRange(start, end, step)
				est, err := tmpl.Estimate(cfg, core.Env{})
				if err != nil || *est.ExpectedTotal != int64(len(want)) || !est.Exact {
					t.Fatalf("%s: estimate %v %v, want %d", cfg, est.ExpectedTotal, err, len(want))
				}
				res, err := tmpl.Resolve(context.Background(), core.Env{}, cfg)
				if err != nil {
					t.Fatal(err)
				}
				items, err := templatestest.Collect(context.Background(), tmpl, core.Env{}, res)
				if err != nil || len(items) != len(want) {
					t.Fatalf("%s: %d items (%v), want %d", cfg, len(items), err, len(want))
				}
				for i, item := range items {
					if string(item) != fmt.Sprintf(`{"value":%d}`, want[i]) {
						t.Fatalf("%s: item %d = %s, want %d", cfg, i, item, want[i])
					}
				}
			}
		}
	}
}

func TestExtremes(t *testing.T) {
	const b = ranges.Bound
	cases := []struct {
		c    ranges.Config
		want int64
	}{
		{ranges.Config{Start: -b, End: b, Step: 1}, 2*b - 0},
		{ranges.Config{Start: b, End: -b, Step: -b}, 2},
		{ranges.Config{Start: -b, End: b, Step: b}, 2},
		{ranges.Config{Start: 0, End: b, Step: b}, 1},
	}
	for _, tc := range cases {
		if got := ranges.Count(tc.c); got != tc.want {
			t.Errorf("Count(%+v) = %d, want %d", tc.c, got, tc.want)
		}
	}
	// The last values of the widest range do not overflow.
	cfg := json.RawMessage(fmt.Sprintf(`{"start":%d,"end":%d,"step":%d}`, b, -b, -b))
	res, err := ranges.New().Resolve(context.Background(), core.Env{}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	items, err := templatestest.Collect(context.Background(), ranges.New(), core.Env{}, res)
	if err != nil || len(items) != 2 || string(items[1]) != `{"value":0}` {
		t.Fatalf("%s %v", items, err)
	}
}

func TestStepZeroIsAnIssue(t *testing.T) {
	issues := ranges.New().Validate(json.RawMessage(`{"start":0,"end":1,"step":0}`))
	if len(issues) != 1 || issues[0] != (core.Issue{Path: "/step", Message: "must not be 0"}) {
		t.Fatalf("issues %v", issues)
	}
	_, err := ranges.New().Resolve(context.Background(), core.Env{}, json.RawMessage(`{"start":0,"end":1,"step":0}`))
	if e, ok := core.AsError(err); !ok || e.Type != "validation" || core.ErrorPath(e) != "/step" {
		t.Fatalf("err %v", err)
	}
}

func TestStopAndCancel(t *testing.T) {
	tmpl := ranges.New()
	res, err := tmpl.Resolve(context.Background(), core.Env{}, json.RawMessage(`{"start":0,"end":1000,"step":1}`))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, err := range tmpl.Stream(context.Background(), core.Env{}, res) {
		if err != nil {
			t.Fatal(err)
		}
		if n++; n == 3 {
			break
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := templatestest.Collect(ctx, tmpl, core.Env{}, res); err != context.Canceled {
		t.Fatalf("cancelled stream: %v", err)
	}
}
