package bundlerun

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/schema"
)

// secretMask replaces the value of a secret in everything a bundle run writes: run.json, results.jsonl, the
// console and --describe (docs/security.md BDL-7), as the platform masks stored configs and results.
const secretMask = "***"

// mask returns raw with every non-null value at the secret paths replaced by secretMask. A value that is not
// JSON is returned unchanged; null and absent values stay as they are.
func mask(raw json.RawMessage, paths []string) json.RawMessage {
	if len(paths) == 0 || len(bytes.TrimSpace(raw)) == 0 {
		return raw
	}
	doc, err := schema.ParseJSON(raw)
	if err != nil {
		return raw
	}
	changed := false
	for _, p := range paths {
		doc = schema.ReplacePointer(doc, p, func(_ string, v any) (any, bool) {
			if v == nil {
				return v, false
			}
			changed = true
			return secretMask, true
		})
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return raw
	}
	return out
}

// maskedSecrets reports the secrets of a config whose value is secretMask itself: a config copied from masked
// output, whose secret would otherwise be the three asterisks.
func maskedSecrets(kind string, raw json.RawMessage, paths []string) []api.Issue {
	if len(paths) == 0 || raw == nil {
		return nil
	}
	doc, err := schema.ParseJSON(raw)
	if err != nil {
		return nil
	}
	var issues []api.Issue
	for _, p := range paths {
		schema.WalkPointer(doc, p, func(at string, v any) {
			if s, ok := v.(string); ok && s == secretMask {
				issues = append(issues, api.Issue{Path: "/" + kind + at, Message: `is the mask "` + secretMask + `" of a secret; give the secret value itself`})
			}
		})
	}
	return issues
}

// valueFreeKeywords are the schema keywords whose issue messages never show the checked value or a property
// name of it, so they stay as they are at a secret path.
var valueFreeKeywords = map[string]bool{
	"type": true, "required": true, "minLength": true, "maxLength": true, "minItems": true, "maxItems": true,
	"minProperties": true, "maxProperties": true,
}

// underSecret reports whether the instance pointer path lies at or below one of the secret paths, whose
// segment `*` matches every member and item (schema.WalkPointer). Both are escaped pointers.
func underSecret(path string, secrets []string) bool {
	segs := pointerSegments(path)
	for _, secret := range secrets {
		want := pointerSegments(secret)
		if len(want) > len(segs) {
			continue
		}
		match := true
		for k, w := range want {
			if w != "*" && w != segs[k] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// pointerSegments splits an escaped JSON pointer into its escaped reference tokens.
func pointerSegments(p string) []string {
	if p == "" {
		return nil
	}
	return strings.Split(strings.TrimPrefix(p, "/"), "/")
}

// secretIssueMessage is the message of a schema issue at a secret path: it names the failing keyword, never
// the value (docs/security.md BDL-7).
func secretIssueMessage(keyword string) string {
	if keyword == "" {
		return "is not valid (secret values are not shown)"
	}
	return "does not satisfy the schema's " + keyword + " (secret values are not shown)"
}

// masker masks the configs and results of one bundle by its secret paths.
type masker struct {
	paths api.SecretPaths
}

func (m masker) taskConfig(raw json.RawMessage) json.RawMessage { return mask(raw, m.paths.TaskConfig) }

func (m masker) scanConfig(raw json.RawMessage) json.RawMessage { return mask(raw, m.paths.ScanConfig) }

func (m masker) analysisConfig(raw json.RawMessage) json.RawMessage {
	return mask(raw, m.paths.AnalysisConfig)
}

func (m masker) result(raw json.RawMessage) json.RawMessage { return mask(raw, m.paths.Result) }
