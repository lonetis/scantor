// Package main is the conformance minimal fixture: only a result type and run.
package main

import scantor "github.com/lonetis/scantor/connectors/go"

// Result is the only declared type.
type Result struct {
	OK bool `json:"ok"`
}

func run(scantor.Context, scantor.Empty, scantor.Empty) (Result, error) { return Result{OK: true}, nil }

func main() { scantor.ServeRun(run) }
