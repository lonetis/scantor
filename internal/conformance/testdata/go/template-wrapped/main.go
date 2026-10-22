// Package main is the conformance template-wrapped fixture: a custom schedule iterating the range proxy.
package main

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	ranges "github.com/lonetis/scantor/connectors/go/templates/range"
)

// ScanConfig bounds the range and optionally stops early.
type ScanConfig struct {
	Start     int64  `json:"start" jsonschema:"default=0"`
	End       int64  `json:"end" jsonschema:"default=10"`
	StopAfter *int64 `json:"stopAfter" jsonschema:"default=null"`
}

// AnalysisConfig is one doubled value.
type AnalysisConfig struct {
	N int `json:"n" jsonschema:"required"`
}

// Result echoes the item.
type Result struct {
	N int `json:"n"`
}

func schedule(ctx scantor.Context, sc ScanConfig, tc scantor.Empty) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		var n int64
		for item, err := range ranges.Schedule(ctx, ranges.ScanConfig{Start: sc.Start, End: sc.End, Step: 1}, tc) {
			if err != nil {
				yield(AnalysisConfig{}, err)
				return
			}
			if sc.StopAfter != nil && n >= *sc.StopAfter {
				return
			}
			if !yield(AnalysisConfig{N: int(item.Value * 2)}, nil) {
				return
			}
			n++
		}
	}
}

func run(_ scantor.Context, ac AnalysisConfig, _ scantor.Empty) (Result, error) {
	return Result{N: ac.N}, nil
}

func main() { scantor.Serve(schedule, run) }
