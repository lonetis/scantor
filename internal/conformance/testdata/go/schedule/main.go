// Package main is the conformance schedule fixture: a generator with failure points.
package main

import (
	"fmt"
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
)

// ScanConfig sets the item count and the failure points.
type ScanConfig struct {
	Count   int  `json:"count" jsonschema:"default=3"`
	FailAt  *int `json:"failAt" jsonschema:"default=null"`
	FatalAt *int `json:"fatalAt" jsonschema:"default=null"`
}

// AnalysisConfig is one item.
type AnalysisConfig struct {
	N int `json:"n" jsonschema:"required"`
}

// Result echoes the item.
type Result struct {
	N int `json:"n"`
}

func schedule(_ scantor.Context, sc ScanConfig, _ scantor.Empty) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for n := range sc.Count {
			if sc.FailAt != nil && *sc.FailAt == n {
				yield(AnalysisConfig{}, fmt.Errorf("failing before item %d", n))
				return
			}
			if sc.FatalAt != nil && *sc.FatalAt == n {
				yield(AnalysisConfig{}, scantor.Fatalf("fatal before item %d", n))
				return
			}
			if !yield(AnalysisConfig{N: n}, nil) {
				return
			}
		}
	}
}

func run(_ scantor.Context, ac AnalysisConfig, _ scantor.Empty) (Result, error) {
	return Result{N: ac.N}, nil
}

func main() { scantor.Serve(schedule, run) }
