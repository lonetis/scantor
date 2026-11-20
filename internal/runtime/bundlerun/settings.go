package bundlerun

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/schema"
)

// Bounds of the settings, those of scans (orchestrator settingsIssues, docs/data-model.md §4.5.1); the bound
// of processes is the bundle's limits.maxProcesses.
const (
	minTimeoutMs             = 1000
	maxTimeoutMs             = 86_400_000
	maxMaxAttempts           = 20
	maxBackoffFactor         = 10
	maxMaxAnalysesPerProcess = 1_000_000
)

// rejectedSettings are scan settings that a bundle run does not have, with the reason.
var rejectedSettings = map[string]string{
	"workers":      "a bundle run is one container; use processes",
	"nodeSelector": "a bundle run is not placed on nodes",
	"privileged":   "a bundle run is never privileged",
	"resources":    "set the container's limits with docker run --cpus and --memory",
}

// settingValue is one numeric setting while it is merged and checked.
type settingValue struct {
	path    string
	value   float64
	min     float64
	max     float64
	integer bool
}

// mergeSettings applies the partial settings of --settings (raw, nil when not given) and --processes (0:
// not given) to the bundle's settings defaults, the backoff field by field, and checks the bounds of
// scans with processes up to maxProcesses. The settings are returned unchanged with the issues.
func mergeSettings(base bundle.Settings, raw json.RawMessage, processes, maxProcesses int) (bundle.Settings, []api.Issue) {
	var issues []api.Issue
	add := func(path, format string, args ...any) {
		issues = append(issues, api.Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}
	v := map[string]*settingValue{
		"processes":             {"settings.processes", float64(base.Processes), 1, float64(maxProcesses), true},
		"timeoutMs":             {"settings.timeoutMs", float64(base.TimeoutMs), minTimeoutMs, maxTimeoutMs, true},
		"maxAttempts":           {"settings.maxAttempts", float64(base.MaxAttempts), 1, maxMaxAttempts, true},
		"maxAnalysesPerProcess": {"settings.maxAnalysesPerProcess", float64(base.MaxAnalysesPerProcess), 1, maxMaxAnalysesPerProcess, true},
		"backoff.initialMs":     {"settings.backoff.initialMs", float64(base.Backoff.InitialMs), minTimeoutMs, maxTimeoutMs, true},
		"backoff.factor":        {"settings.backoff.factor", base.Backoff.Factor, 1, maxBackoffFactor, false},
		"backoff.maxMs":         {"settings.backoff.maxMs", float64(base.Backoff.MaxMs), minTimeoutMs, maxTimeoutMs, true},
	}
	jitter := base.Backoff.Jitter
	set := func(key string, value any) {
		sv := v[key]
		n, ok := number(value)
		switch {
		case !ok && sv.integer:
			add(sv.path, "must be an integer")
		case !ok:
			add(sv.path, "must be a number")
		default:
			sv.value = n
		}
	}
	if raw != nil {
		doc, err := schema.ParseJSON(raw)
		patch, ok := doc.(map[string]any)
		if err != nil || !ok {
			add("--settings", "must be a JSON object")
			return base, issues
		}
		for _, key := range sortedKeys(patch) {
			switch key {
			case "processes", "timeoutMs", "maxAttempts", "maxAnalysesPerProcess":
				set(key, patch[key])
			case "backoff":
				backoff, ok := patch[key].(map[string]any)
				if !ok {
					add("settings.backoff", "must be an object")
					continue
				}
				for _, field := range sortedKeys(backoff) {
					switch field {
					case "initialMs", "factor", "maxMs":
						set("backoff."+field, backoff[field])
					case "jitter":
						if b, ok := backoff[field].(bool); ok {
							jitter = b
						} else {
							add("settings.backoff.jitter", "must be a boolean")
						}
					default:
						add("settings.backoff."+field, "is not allowed (unknown property)")
					}
				}
			default:
				if reason, ok := rejectedSettings[key]; ok {
					add("settings."+key, "is not a setting of a bundle run: %s", reason)
				} else {
					add("settings."+key, "is not allowed (unknown property)")
				}
			}
		}
	}
	switch {
	case processes < 0:
		add("--processes", "must be at least 1")
	case processes > 0:
		v["processes"].path, v["processes"].value = "--processes", float64(processes)
	}
	for _, key := range []string{"processes", "timeoutMs", "maxAttempts", "backoff.initialMs", "backoff.factor", "backoff.maxMs", "maxAnalysesPerProcess"} {
		sv := v[key]
		switch {
		case sv.integer && sv.value != math.Trunc(sv.value):
			add(sv.path, "must be an integer")
		case sv.value < sv.min || sv.value > sv.max:
			add(sv.path, "must be between %s and %s", formatNumber(sv.min), formatNumber(sv.max))
		}
	}
	if v["backoff.initialMs"].value > v["backoff.maxMs"].value {
		add("settings.backoff.maxMs", "must be at least backoff.initialMs")
	}
	if len(issues) > 0 {
		return base, issues
	}
	return bundle.Settings{
		Processes:   int(v["processes"].value),
		TimeoutMs:   int64(v["timeoutMs"].value),
		MaxAttempts: int(v["maxAttempts"].value),
		Backoff: api.Backoff{
			InitialMs: int64(v["backoff.initialMs"].value), Factor: v["backoff.factor"].value,
			MaxMs: int64(v["backoff.maxMs"].value), Jitter: jitter,
		},
		Resources:             base.Resources,
		MaxAnalysesPerProcess: int(v["maxAnalysesPerProcess"].value),
	}, nil
}

// number returns a finite JSON number (schema.ParseJSON decodes numbers as json.Number).
func number(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func formatNumber(f float64) string {
	if f == math.Trunc(f) {
		return fmt.Sprintf("%.0f", f)
	}
	return fmt.Sprint(f)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
