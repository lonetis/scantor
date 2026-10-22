// Package main is the tranco binary of the conformance template-models fixture: configs are parsed with
// the native models of template tranco (Go types are static, so the fixture image has one binary per
// template; the harness starts /task/models-<template>).
package main

import (
	"encoding/json"
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/tranco"
)

// ScanConfig carries the template's scan config.
type ScanConfig struct {
	Template string            `json:"template" jsonschema:"required"`
	Config   tranco.ScanConfig `json:"config" jsonschema:"required"`
}

// AnalysisConfig carries one of the template's analysis configs.
type AnalysisConfig struct {
	Template string                `json:"template" jsonschema:"required"`
	Config   tranco.AnalysisConfig `json:"config" jsonschema:"required"`
}

// Result echoes the parsed analysis config.
type Result struct {
	Config map[string]any `json:"config"`
}

func schedule(ctx scantor.Context, sc ScanConfig, tc scantor.Empty) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for item, err := range tranco.Schedule(ctx, sc.Config, tc) {
			if err != nil {
				yield(AnalysisConfig{}, err)
				return
			}
			if !yield(AnalysisConfig{Template: sc.Template, Config: item}, nil) {
				return
			}
		}
	}
}

func run(_ scantor.Context, ac AnalysisConfig, _ scantor.Empty) (Result, error) {
	b, err := json.Marshal(ac.Config)
	if err != nil {
		return Result{}, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return Result{}, err
	}
	return Result{Config: m}, nil
}

func main() { scantor.Serve(schedule, run) }
