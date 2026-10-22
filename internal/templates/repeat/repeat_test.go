package repeat_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/repeat"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func TestRejectsZeroTimes(t *testing.T) {
	_, err := repeat.New().Estimate(json.RawMessage(`{"times":0}`), core.Env{})
	if e, ok := core.AsError(err); !ok || e.Type != "validation" || core.ErrorPath(e) != "/times" {
		t.Fatalf("err %v", err)
	}
}

func TestIntegralFloatsAreAccepted(t *testing.T) {
	res, err := repeat.New().Resolve(context.Background(), core.Env{}, json.RawMessage(`{"times":2.0}`))
	if err != nil || string(res.ScanConfig) != `{"times":2}` {
		t.Fatalf("%s %v", res.ScanConfig, err)
	}
	items, err := templatestest.Collect(context.Background(), repeat.New(), core.Env{}, res)
	if err != nil || len(items) != 2 || string(items[1]) != `{"iteration":1}` {
		t.Fatalf("%s %v", items, err)
	}
}
