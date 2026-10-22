// Package main is the conformance template-tranco fixture: the tranco proxy passed unwrapped with its types.
package main

import (
	"encoding/json"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/tranco"
)

// Result echoes the analysis config.
type Result struct {
	Config map[string]any `json:"config"`
}

func run(_ scantor.Context, ac tranco.AnalysisConfig, _ scantor.Empty) (Result, error) {
	b, err := json.Marshal(ac)
	if err != nil {
		return Result{}, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return Result{}, err
	}
	return Result{Config: m}, nil
}

func main() { scantor.Serve(tranco.Schedule, run) }
