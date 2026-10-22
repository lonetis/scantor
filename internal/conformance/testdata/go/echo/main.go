// Package main is the conformance echo fixture (docs/protocol.md §12.2): no schedule, a custom analysis
// config, a synchronous run.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
)

// TaskConfig has a defaulted greeting and an optional secret.
type TaskConfig struct {
	Greeting string         `json:"greeting" jsonschema:"default=Hello"`
	APIToken scantor.Secret `json:"apiToken,omitempty"`
}

// AnalysisConfig selects the behaviour of run.
type AnalysisConfig struct {
	Name    string `json:"name" jsonschema:"default=world"`
	Mode    string `json:"mode" jsonschema:"default=ok"`
	SleepMs int    `json:"sleepMs" jsonschema:"default=0"`
	Bytes   int    `json:"bytes" jsonschema:"default=0"`
}

// EchoCtx echoes the call's ctx.
type EchoCtx struct {
	ScanID         string  `json:"scanId"`
	AnalysisID     *string `json:"analysisId"`
	Seq            *int64  `json:"seq"`
	Attempt        int     `json:"attempt"`
	HasDeadline    bool    `json:"hasDeadline"`
	TmpDirWritable bool    `json:"tmpDirWritable"`
}

// Result is the echo result; an empty text violates its schema (mode invalidResult).
type Result struct {
	Text         string            `json:"text" jsonschema:"minLength=1"`
	Ctx          EchoCtx           `json:"ctx"`
	SecretLength int               `json:"secretLength"`
	Files        []scantor.FileRef `json:"files"`
}

func init() {
	fmt.Println("importing echo")
	fmt.Fprintln(os.Stderr, "importing echo")
}

func echoCtx(ctx scantor.Context) EchoCtx {
	e := EchoCtx{ScanID: ctx.ScanID(), Attempt: ctx.Attempt()}
	if id := ctx.AnalysisID(); id != "" {
		e.AnalysisID = &id
	}
	if seq := ctx.Seq(); seq >= 0 {
		e.Seq = &seq
	}
	_, e.HasDeadline = ctx.Deadline()
	entries, err := os.ReadDir(ctx.TmpDir())
	e.TmpDirWritable = err == nil && len(entries) == 0 && os.WriteFile(filepath.Join(ctx.TmpDir(), "probe"), []byte("x"), 0o600) == nil
	return e
}

func run(ctx scantor.Context, ac AnalysisConfig, tc TaskConfig) (Result, error) {
	text := tc.Greeting + ", " + ac.Name + "!"
	var files []scantor.FileRef
	switch ac.Mode {
	case "fatal":
		return Result{}, scantor.Fatal("fatal requested")
	case "retry":
		return Result{}, scantor.Retry("retry requested", 0)
	case "retryAfter":
		return Result{}, scantor.Retry("retry requested", 1500*time.Millisecond)
	case "throw":
		panic("boom")
	case "invalidResult":
		text = ""
	case "sleep":
		select {
		case <-time.After(time.Duration(ac.SleepMs) * time.Millisecond):
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	case "sleepUncooperative":
		time.Sleep(time.Duration(ac.SleepMs) * time.Millisecond)
	case "exit":
		os.Exit(3)
	case "oversized":
		text = strings.Repeat("x", ac.Bytes)
	case "stdout":
		fmt.Println(`{"type":"result","id":"r0","result":{}}`)
		fmt.Fprintln(os.Stderr, "noise")
	case "log":
		ctx.Log(scantor.LevelInfo, "hello", "n", 1)
	case "progress":
		ctx.Progress(0.5, "half")
	case "file":
		a, err := ctx.Files().Put("a.bin", []byte("abc"), "application/octet-stream")
		if err != nil {
			return Result{}, err
		}
		b, err := ctx.Files().Put("b.txt", []byte("hello"), "")
		if err != nil {
			return Result{}, err
		}
		path := filepath.Join(ctx.TmpDir(), "c.json")
		if err := os.WriteFile(path, []byte(`{"c":true}`), 0o600); err != nil {
			return Result{}, err
		}
		c, err := ctx.Files().PutFile("c.json", path, "")
		if err != nil {
			return Result{}, err
		}
		if err := os.WriteFile(path, []byte("changed after put"), 0o600); err != nil {
			return Result{}, err
		}
		files = []scantor.FileRef{a, b, c}
	case "fileError":
		if _, err := ctx.Files().Put("bad.bin", []byte("x"), ""); err != nil {
			return Result{}, err
		}
	}
	return Result{Text: text, Ctx: echoCtx(ctx), SecretLength: len(tc.APIToken), Files: files}, nil
}

func main() { scantor.Serve[TaskConfig, scantor.Empty, AnalysisConfig, Result](nil, run) }
