// Package main is the conformance template-unwrapped fixture: the range proxy passed unwrapped.
package main

import (
	scantor "github.com/lonetis/scantor/connectors/go"
	ranges "github.com/lonetis/scantor/connectors/go/templates/range"
)

// Result echoes the value.
type Result struct {
	Value int64 `json:"value"`
}

func run(_ scantor.Context, ac ranges.AnalysisConfig, _ scantor.Empty) (Result, error) {
	return Result{Value: ac.Value}, nil
}

func main() { scantor.Serve(ranges.Schedule, run) }
