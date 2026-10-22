// Command stubruntime stands in for `scantor runtime describe|check|local` in the task pipeline's
// integration tests when the binary has no runtime yet. It checks the container contract the pipeline
// sets up (injection path, working directory /task, the entry, network none, no platform credentials)
// and emits the events of docs/runtime.md §15–§16. describe answers with a fixed description, check
// really runs SCANTOR_CHECK_CMD, local writes one file to the out directory.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 3 || os.Args[0] != "/scantor/scantor" || os.Args[1] != "runtime" {
		fatal(3, "describe", fmt.Sprintf("unexpected invocation %q", os.Args))
	}
	mode := os.Args[2]
	fs := flag.NewFlagSet(mode, flag.ContinueOnError)
	entry := fs.String("entry", "", "entry")
	spec := fs.String("spec", "", "local-mode spec")
	if err := fs.Parse(os.Args[3:]); err != nil {
		fatal(3, mode, err.Error())
	}
	switch mode {
	case "describe":
		describe(*entry)
	case "check":
		check(*entry)
	case "local":
		local(*spec)
	default:
		fatal(3, mode, "unknown mode "+mode)
	}
}

func emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(b))
}

func fatal(code int, phase, msg string) {
	emit(map[string]any{"phase": phase, "type": "error", "error": map[string]any{"phase": phase, "message": msg}})
	os.Exit(code)
}

// contract verifies what every pipeline container must look like and reports it as a log line.
func contract(phase, entry string) {
	wd, err := os.Getwd()
	if err != nil || wd != "/task" {
		fatal(2, phase, fmt.Sprintf("working directory %q, want /task", wd))
	}
	if entry != "" {
		if info, err := os.Stat(entry); err != nil || !info.Mode().IsRegular() {
			fatal(2, phase, fmt.Sprintf("entry %s is missing", entry))
		}
	}
	for _, name := range []string{"SCANTOR_WORKER_TOKEN", "SCANTOR_URL", "SCANTOR_TOKEN", "SCANTOR_SECRET"} {
		if os.Getenv(name) != "" {
			fatal(3, phase, name+" must not reach a pipeline container")
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		fatal(3, phase, err.Error())
	}
	var up []string
	for _, i := range ifaces {
		if i.Flags&net.FlagUp != 0 {
			up = append(up, i.Name)
		}
	}
	emit(map[string]any{"phase": phase, "type": "log", "stream": "stderr",
		"text": fmt.Sprintf("stub runtime: uid %d, interfaces up: %s", os.Getuid(), strings.Join(up, ","))})
}

func describe(entry string) {
	contract("describe", entry)
	language := strings.Fields(os.Getenv("SCANTOR_LANGUAGE"))
	if len(language) == 0 {
		fatal(2, "describe", "the image sets no SCANTOR_LANGUAGE")
	}
	object := map[string]any{
		"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
		"properties": map[string]any{}, "additionalProperties": false,
	}
	emit(map[string]any{"phase": "describe", "type": "result", "description": map[string]any{
		"protocolVersion": 1,
		"connector":       map[string]any{"language": language[0], "version": "0.0.0-stub"},
		"schemas":         map[string]any{"taskConfig": object, "scanConfig": object, "analysisConfig": object, "result": map[string]any{"type": "object"}},
		"schedule":        map[string]any{"kind": "template", "template": "single"},
		"secretPaths":     map[string]any{"taskConfig": []string{}, "scanConfig": []string{}, "analysisConfig": []string{}, "result": []string{}},
		"uploadPaths":     map[string]any{"taskConfig": []string{}, "scanConfig": []string{}},
		"fileRefPaths":    []string{},
		"warnings":        []string{"described by the stub runtime"},
	}})
}

var diagnostic = regexp.MustCompile(`^([^:\s][^:]*):([0-9]+)(?::([0-9]+))?: (.+)$`)

func check(entry string) {
	contract("check", entry)
	template := os.Getenv("SCANTOR_CHECK_CMD")
	if template == "" {
		emit(map[string]any{"phase": "check", "type": "result", "ok": true, "exitCode": 0, "skipped": true})
		return
	}
	args := strings.Fields(strings.ReplaceAll(template, "{entry}", entry))
	cmd := exec.Command(args[0], args[1:]...) //nolint:gosec // the command template of the image under test
	cmd.Dir = "/task"
	out, err := cmd.CombinedOutput()
	code := 0
	var exitErr *exec.ExitError
	switch {
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	case err != nil:
		fatal(2, "check", err.Error())
	}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := sc.Text()
		emit(map[string]any{"phase": "check", "type": "log", "stream": "check", "text": line})
		if m := diagnostic.FindStringSubmatch(line); m != nil {
			lineNo, _ := strconv.Atoi(m[2])
			col, _ := strconv.Atoi(m[3])
			emit(map[string]any{"phase": "check", "type": "error", "error": map[string]any{"phase": "check", "file": m[1], "line": lineNo, "column": col, "message": m[4]}})
		}
	}
	emit(map[string]any{"phase": "check", "type": "result", "ok": code == 0, "exitCode": code, "skipped": false})
	if code != 0 {
		os.Exit(2)
	}
}

func local(specPath string) {
	data, err := os.ReadFile(specPath)
	if err != nil {
		fatal(3, "local", err.Error())
	}
	var spec struct {
		RunID      string          `json:"runId"`
		Entry      string          `json:"entry"`
		TaskConfig json.RawMessage `json:"taskConfig"`
		OutDir     string          `json:"outDir"`
		Limit      int             `json:"limit"`
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		fatal(3, "local", err.Error())
	}
	contract("local", spec.Entry)
	emit(map[string]any{"type": "start", "runtimeVersion": "stub", "language": os.Getenv("SCANTOR_LANGUAGE"), "protocolVersion": 1,
		"connector": map[string]any{"language": "python", "version": "0.0.0-stub"}, "schedule": map[string]any{"kind": "template", "template": "single"},
		"limit": spec.Limit, "processes": 1})
	rel := filepath.Join("files", "0", "f1", "hello.txt")
	if err := os.MkdirAll(filepath.Join(spec.OutDir, filepath.Dir(rel)), 0o755); err != nil {
		fatal(3, "local", err.Error())
	}
	if err := os.WriteFile(filepath.Join(spec.OutDir, rel), spec.TaskConfig, 0o644); err != nil {
		fatal(3, "local", err.Error())
	}
	emit(map[string]any{"type": "result", "seq": 0, "status": "succeeded", "attempt": 1, "config": map[string]any{},
		"result": map[string]any{"runId": spec.RunID}, "error": nil, "logTail": "", "attempts": []any{},
		"files": []any{map[string]any{"id": "f1", "name": "hello.txt", "size": len(spec.TaskConfig), "sha256": "", "contentType": "application/json", "path": rel}}})
	emit(map[string]any{"type": "end", "reason": "done", "summary": map[string]any{"analyses": 1, "succeeded": 1, "failed": 0}, "exitCode": 0})
}
