package bundlerun

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
)

var baseSettings = bundle.Settings{
	Processes: 1, TimeoutMs: 300000, MaxAttempts: 3,
	Backoff:   api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 600000, Jitter: true},
	Resources: api.Resources{CPUs: 1, MemoryMiB: 512}, MaxAnalysesPerProcess: 1000,
}

func TestMergeSettings(t *testing.T) {
	got, issues := mergeSettings(baseSettings, nil, 0, 64)
	if len(issues) > 0 || got != baseSettings {
		t.Fatalf("no patch: %+v %v", got, issues)
	}

	raw := json.RawMessage(`{"processes":4,"timeoutMs":60000,"maxAttempts":5,"backoff":{"maxMs":120000,"jitter":false},"maxAnalysesPerProcess":10}`)
	got, issues = mergeSettings(baseSettings, raw, 0, 64)
	want := bundle.Settings{
		Processes: 4, TimeoutMs: 60000, MaxAttempts: 5,
		Backoff:   api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 120000, Jitter: false},
		Resources: baseSettings.Resources, MaxAnalysesPerProcess: 10,
	}
	if len(issues) > 0 || got != want {
		t.Fatalf("patch: %+v %v", got, issues)
	}

	// --processes wins over settings.processes.
	if got, issues := mergeSettings(baseSettings, json.RawMessage(`{"processes":4}`), 8, 64); len(issues) > 0 || got.Processes != 8 {
		t.Fatalf("--processes: %+v %v", got, issues)
	}
	if got, issues := mergeSettings(baseSettings, json.RawMessage(`{"backoff":{"factor":1.5}}`), 0, 64); len(issues) > 0 || got.Backoff.Factor != 1.5 || got.Backoff.InitialMs != 5000 {
		t.Fatalf("factor: %+v %v", got, issues)
	}
}

func TestMergeSettingsIssues(t *testing.T) {
	cases := []struct {
		raw       string
		processes int
		want      []string
	}{
		{`{"processes":65}`, 0, []string{"settings.processes: must be between 1 and 64"}},
		{`{}`, 65, []string{"--processes: must be between 1 and 64"}},
		{`{"processes":0}`, 0, []string{"settings.processes: must be between 1 and 64"}},
		{`{"processes":1.5}`, 0, []string{"settings.processes: must be an integer"}},
		{`{"processes":"2"}`, 0, []string{"settings.processes: must be an integer"}},
		{`{"timeoutMs":999}`, 0, []string{"settings.timeoutMs: must be between 1000 and 86400000"}},
		{`{"maxAttempts":21}`, 0, []string{"settings.maxAttempts: must be between 1 and 20"}},
		{`{"backoff":{"initialMs":700000}}`, 0, []string{"settings.backoff.maxMs: must be at least backoff.initialMs"}},
		{`{"backoff":{"factor":11,"jitter":"yes","base":1}}`, 0, []string{"settings.backoff.factor: must be between 1 and 10", "settings.backoff.jitter: must be a boolean", "settings.backoff.base: is not allowed (unknown property)"}},
		{`{"backoff":3}`, 0, []string{"settings.backoff: must be an object"}},
		{`{"maxAnalysesPerProcess":1000001}`, 0, []string{"settings.maxAnalysesPerProcess: must be between 1 and 1000000"}},
		{`{"workers":2,"nodeSelector":{},"privileged":true,"resources":{}}`, 0, []string{
			"settings.workers: is not a setting of a bundle run: a bundle run is one container",
			"settings.nodeSelector: is not a setting of a bundle run",
			"settings.privileged: is not a setting of a bundle run",
			"settings.resources: is not a setting of a bundle run: set the container's limits with docker run --cpus and --memory",
		}},
		{`{"retries":1}`, 0, []string{"settings.retries: is not allowed (unknown property)"}},
		{`[1]`, 0, []string{"--settings: must be a JSON object"}},
	}
	for _, tc := range cases {
		got, issues := mergeSettings(baseSettings, json.RawMessage(tc.raw), tc.processes, 64)
		text := issueText(issues)
		for _, want := range tc.want {
			if !strings.Contains(text, want) {
				t.Errorf("%s: issues lack %q:\n%s", tc.raw, want, text)
			}
		}
		if got != baseSettings {
			t.Errorf("%s: settings changed despite issues: %+v", tc.raw, got)
		}
	}
}
