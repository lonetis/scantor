// Package dockerfile implements the Dockerfile policy of task images (docs/tasks.md §8.2, rules D1–D11
// and warnings W1–W3; docs/security.md BLD-1…BLD-6, LBL-2) with BuildKit's own parser
// (frontend/dockerfile/parser and instructions.Parse), so every rule sees what BuildKit will execute.
// Check never builds or pulls anything; the build phase of internal/taskpipe pulls and inspects the
// external images it returns.
package dockerfile

import (
	"bytes"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/moby/buildkit/frontend/dockerfile/instructions"
	"github.com/moby/buildkit/frontend/dockerfile/linter"
	"github.com/moby/buildkit/frontend/dockerfile/parser"
	"github.com/moby/buildkit/frontend/dockerfile/shell"

	"github.com/lonetis/scantor/internal/container"
)

// Bounds of rule D1.
const (
	MaxBytes        = 256 << 10
	MaxStages       = 32
	MaxInstructions = 1000
)

// BaseArg is the build argument that carries the pinned base image.
const BaseArg = "SCANTOR_BASE"

// scratchImage is BuildKit's reserved name of the empty image: FROM scratch, COPY --from=scratch and
// RUN --mount from=scratch never pull anything (exactly this spelling; BuildKit compares it verbatim).
const scratchImage = "scratch"

// Options configure Check.
type Options struct {
	// ForbiddenHosts are registry hosts (without port, lower case) that image references must never
	// use besides the fixed list of rule D5: the hosts of SCANTOR_REGISTRY_PUBLIC_HOST and
	// SCANTOR_PUBLIC_URL.
	ForbiddenHosts []string
	// HasDockerignore reports whether the task has a .dockerignore (warning W3 otherwise).
	HasDockerignore bool
}

// Issue is one policy violation or warning. Line is 1-based (0 when the rule concerns the whole file).
type Issue struct {
	Rule    string
	Line    int
	Message string
}

// Text renders the message with its rule id, for example "COPY --from=… is not allowed: … (D5)".
func (i Issue) Text() string { return fmt.Sprintf("%s (%s)", i.Message, i.Rule) }

// ImageRef is a literal external image reference of the Dockerfile and its line.
type ImageRef struct {
	Ref  string
	Line int
}

// Result is the outcome of Check.
type Result struct {
	Errors   []Issue
	Warnings []Issue
	// External lists the literal external image references (rule D5) in order of first appearance; the
	// build phase pulls and inspects them (ONBUILD triggers, docs/security.md BLD-7).
	External []ImageRef
}

// OK reports whether the Dockerfile passed the policy.
func (r Result) OK() bool { return len(r.Errors) == 0 }

type checker struct {
	opts   Options
	res    Result
	lex    *shell.Lex
	stages []instructions.Stage
	seen   map[string]bool
}

func (c *checker) fail(rule string, line int, format string, args ...any) {
	c.res.Errors = append(c.res.Errors, Issue{Rule: rule, Line: line, Message: fmt.Sprintf(format, args...)})
}

func (c *checker) warn(rule string, line int, format string, args ...any) {
	c.res.Warnings = append(c.res.Warnings, Issue{Rule: rule, Line: line, Message: fmt.Sprintf(format, args...)})
}

// Check applies the policy to the content of a Dockerfile.
func Check(data []byte, opts Options) (res Result) {
	c := &checker{opts: opts, seen: map[string]bool{}}
	defer func() {
		// The parser handles hostile input; a panic in it must still end as a policy error, not as a
		// crashed pipeline.
		if r := recover(); r != nil {
			c.res = Result{Errors: []Issue{{Rule: "D1", Message: fmt.Sprintf("the Dockerfile cannot be parsed: %v", r)}}}
			res = c.res
		}
	}()
	c.check(data)
	if !opts.HasDockerignore {
		c.warn("W3", 0, "there is no .dockerignore, so every file of the task folder is sent to the build")
	}
	sortIssues(c.res.Errors)
	sortIssues(c.res.Warnings)
	return c.res
}

func (c *checker) check(data []byte) {
	if len(data) > MaxBytes {
		c.fail("D1", 0, "the Dockerfile is %d bytes; the limit is %d KiB", len(data), MaxBytes>>10)
		return
	}
	c.directives(data)
	if len(c.res.Errors) > 0 {
		return
	}
	parsed, err := parser.Parse(bytes.NewReader(data))
	if err != nil {
		c.fail("D1", errorLine(err), "the Dockerfile cannot be parsed: %s", errorMessage(err))
		return
	}
	if n := len(parsed.AST.Children); n > MaxInstructions {
		c.fail("D1", 0, "the Dockerfile has %d instructions; the limit is %d", n, MaxInstructions)
		return
	}
	c.lex = shell.NewLex(parsed.EscapeToken)
	stages, metaArgs, err := instructions.Parse(parsed.AST, linter.New(&linter.Config{}))
	if err != nil {
		c.fail("D1", errorLine(err), "the Dockerfile cannot be parsed: %s", errorMessage(err))
		return
	}
	if len(stages) == 0 {
		c.fail("D1", 0, "the Dockerfile has no FROM instruction")
		return
	}
	if len(stages) > MaxStages {
		c.fail("D1", stageLine(stages[MaxStages]), "the Dockerfile has %d stages; the limit is %d", len(stages), MaxStages)
		return
	}
	c.stages = stages
	c.metaArgs(metaArgs)
	final := c.finalChain()
	for i := range stages {
		c.stage(i, final[i])
	}
}

// directives applies rule D2: no syntax or check parser directives. BuildKit detects the syntax
// directive in every format (#, // and a JSON document), so the same detection is used here.
func (c *checker) directives(data []byte) {
	if _, cmdline, loc, ok := parser.DetectSyntax(data); ok {
		c.fail("D2", rangeLine(loc), "the parser directive syntax=%s is not allowed: custom frontends are not supported", cmdline)
	}
	if _, cmdline, loc, ok := parser.ParseDirective("check", data); ok {
		c.fail("D2", rangeLine(loc), "the parser directive check=%s is not allowed", cmdline)
	}
}

// metaArgs applies rule D3 and D10 to the ARG instructions before the first FROM. BuildKit never expands
// the names of these ARGs, so only the literal name SCANTOR_BASE declares the base argument.
func (c *checker) metaArgs(args []instructions.ArgCommand) {
	declared := false
	for i := range args {
		cmd := &args[i]
		c.args(cmd)
		for _, kv := range cmd.Args {
			if kv.Key != BaseArg {
				continue
			}
			declared = true
			if kv.Value != nil {
				c.fail("D3", cmdLine(cmd), "ARG %s must not have a default value; the pipeline always supplies the pinned base image", BaseArg)
			}
		}
	}
	if !declared {
		c.fail("D3", stageLine(c.stages[0]), "ARG %s must be declared before the first FROM (without a default value)", BaseArg)
	}
}

// args applies rule D10 to one ARG instruction. The name is checked as written and without its shell
// quoting: the dispatcher of the vendored BuildKit uses ARG names verbatim, but instructions.ArgCommand's
// Expand removes quotes and escapes (`ARG "BUILDKIT_X"=1` would set BUILDKIT_X), so the rule must not
// depend on which of the two a frontend version applies.
func (c *checker) args(cmd *instructions.ArgCommand) {
	isBuildkit := func(name string) bool { return strings.HasPrefix(strings.ToUpper(name), "BUILDKIT_") }
	for _, kv := range cmd.Args {
		switch {
		case strings.Contains(kv.Key, "$"):
			c.fail("D10", cmdLine(cmd), "ARG names must not contain variables")
		case isBuildkit(kv.Key) || isBuildkit(c.word(kv.Key)):
			c.fail("D10", cmdLine(cmd), "ARG %s is not allowed: BUILDKIT_* arguments configure the builder", kv.Key)
		}
	}
}

// isBaseRef reports whether ref is exactly ${SCANTOR_BASE} or $SCANTOR_BASE.
func isBaseRef(ref string) bool { return ref == "${"+BaseArg+"}" || ref == "$"+BaseArg }

// stageIndex returns the index of the stage named name among the first n stages (stage names are
// case-insensitive).
func (c *checker) stageIndex(name string, n int) (int, bool) {
	for i := n - 1; i >= 0; i-- {
		if c.stages[i].Name != "" && strings.EqualFold(c.stages[i].Name, name) {
			return i, true
		}
	}
	return 0, false
}

// finalChain applies rule D4 and returns the stages the final image is built from (the final stage and
// the stages it descends from by name).
func (c *checker) finalChain() map[int]bool {
	chain := map[int]bool{}
	i := len(c.stages) - 1
	for {
		chain[i] = true
		base := c.stages[i].BaseName
		if isBaseRef(base) {
			return chain
		}
		parent, ok := c.stageIndex(base, i)
		if !ok {
			last := c.stages[len(c.stages)-1]
			c.fail("D4", stageLine(last), "the final stage must be FROM ${%s} or descend from it through earlier stages; it is built from %q", BaseArg, base)
			return chain
		}
		i = parent
	}
}

func (c *checker) stage(i int, inFinalImage bool) {
	st := &c.stages[i]
	line := stageLine(*st)
	if st.Platform != "" {
		c.fail("D6", line, "FROM --platform is not allowed: tasks are built for the platform of the build daemon")
	}
	if !isBaseRef(st.BaseName) {
		if _, ok := c.stageIndex(st.BaseName, i); !ok && st.BaseName != scratchImage {
			c.imageRef("FROM", st.BaseName, line)
		}
	}
	for _, cmd := range st.Commands {
		c.command(i, cmd, inFinalImage)
	}
}

func (c *checker) command(stage int, cmd instructions.Command, inFinalImage bool) {
	line := cmdLine(cmd)
	switch cmd := cmd.(type) {
	case *instructions.CopyCommand:
		if cmd.From != "" {
			c.stageOrImage(stage, "COPY --from="+cmd.From, cmd.From, line, true)
		}
	case *instructions.AddCommand:
		c.add(cmd, line)
	case *instructions.RunCommand:
		c.run(stage, cmd, line)
	case *instructions.LabelCommand:
		c.labels(cmd, line)
	case *instructions.ArgCommand:
		c.args(cmd)
	case *instructions.OnbuildCommand:
		c.fail("D11", line, "ONBUILD is not allowed: it hides instructions that run in later builds")
	case *instructions.VolumeCommand:
		c.fail("D11", line, "VOLUME is not allowed: anonymous volumes leak worker disk space")
	case *instructions.EnvCommand:
		if inFinalImage {
			for _, kv := range cmd.Env {
				if key := c.word(kv.Key); strings.HasPrefix(key, "SCANTOR_") {
					c.warn("W2", line, "ENV overrides %s of the base image", key)
				}
			}
		}
	case *instructions.EntrypointCommand, *instructions.CmdCommand, *instructions.HealthCheckCommand, *instructions.StopSignalCommand:
		if inFinalImage {
			c.warn("W1", line, "%s is ignored; the runtime is the entrypoint", strings.ToUpper(cmd.Name()))
		}
	}
}

// stageOrImage accepts an earlier stage by name, ${SCANTOR_BASE} or scratch, and checks anything else as
// a literal image reference (COPY --from, RUN --mount from=). A number is a stage index only where BuildKit
// reads it as one (indexes: COPY --from); RUN --mount from= resolves only stage names, so BuildKit would
// read a number there as the Docker Hub image library/<n>, which is rejected.
func (c *checker) stageOrImage(stage int, what, ref string, line int, indexes bool) {
	if isBaseRef(ref) || ref == scratchImage {
		return
	}
	if _, ok := c.stageIndex(ref, stage); ok {
		return
	}
	if n, err := strconv.Atoi(ref); err == nil {
		switch {
		case !indexes:
			c.fail("D5", line, "%s is not allowed: BuildKit reads a number there as the Docker Hub image library/%s, not as a stage index; use the stage's name", what, ref)
		case n < 0 || n >= stage:
			c.fail("D5", line, "%s is not allowed: stage %d is not an earlier stage", what, n)
		}
		return
	}
	c.imageRef(what, ref, line)
}

// imageRef applies rule D5 to a literal external image reference and records it for the build phase.
func (c *checker) imageRef(what, ref string, line int) {
	if problem := CheckImageRef(ref, c.opts.ForbiddenHosts); problem != "" {
		c.fail("D5", line, "%s is not allowed: %s", what+describeRef(what, ref), problem)
		return
	}
	if !c.seen[ref] {
		c.seen[ref] = true
		c.res.External = append(c.res.External, ImageRef{Ref: ref, Line: line})
	}
}

func describeRef(what, ref string) string {
	if strings.Contains(what, ref) {
		return ""
	}
	return " " + ref
}

// add applies rule D7: ADD sources are local paths only.
func (c *checker) add(cmd *instructions.AddCommand, line int) {
	if cmd.Checksum != "" || slices.ContainsFunc(nodeFlags(cmd), func(f string) bool { return f == "checksum" }) {
		c.fail("D7", line, "ADD --checksum is not allowed: ADD sources must be local paths")
	}
	if cmd.KeepGitDir != nil {
		c.fail("D7", line, "ADD --keep-git-dir is not allowed: ADD sources must be local paths")
	}
	for _, src := range cmd.SourcePaths {
		if strings.Contains(src, "$") {
			c.fail("D7", line, "ADD source %q is not allowed: ADD sources must not contain variables", src)
			continue
		}
		if remoteSource(c.word(src)) {
			c.fail("D7", line, "ADD source %q is not allowed: ADD sources must be local paths; download with RUN instead", src)
		}
	}
}

// run applies rules D5 and D8 to RUN flags.
func (c *checker) run(stage int, cmd *instructions.RunCommand, line int) {
	if slices.Contains(cmd.FlagsUsed, "security") {
		c.fail("D8", line, "RUN --security is not allowed")
	}
	if network := instructions.GetNetwork(cmd); network != instructions.NetworkDefault {
		c.fail("D8", line, "RUN --network=%s is not allowed; only the default build network is", network)
	}
	if !slices.Contains(cmd.FlagsUsed, "mount") {
		return
	}
	// Mount options are parsed at expansion time; the identity expander keeps variables literal, so a
	// variable in a mount type or source stage fails the rules below instead of being expanded.
	if err := cmd.Expand(func(word string) (string, error) { return word, nil }); err != nil {
		c.fail("D8", line, "RUN --mount is not allowed: %s", errorMessage(err))
		return
	}
	for _, m := range instructions.GetMounts(cmd) {
		switch m.Type {
		case instructions.MountTypeBind, instructions.MountTypeTmpfs:
		default:
			c.fail("D8", line, "RUN --mount=type=%s is not allowed; only bind and tmpfs mounts are", m.Type)
			continue
		}
		if m.From != "" {
			c.stageOrImage(stage, "RUN --mount from="+m.From, m.From, line, false)
		}
	}
}

// labels applies rule D9 (and docs/security.md LBL-2) to LABEL keys.
func (c *checker) labels(cmd *instructions.LabelCommand, line int) {
	for _, kv := range cmd.Labels {
		if strings.Contains(kv.Key, "$") {
			c.fail("D9", line, "LABEL key %q is not allowed: label keys must not contain variables", kv.Key)
			continue
		}
		if key := c.word(kv.Key); container.ForbiddenImageLabel(key) {
			c.fail("D9", line, "LABEL key %q is not allowed: traefik.*, com.docker.compose.* and scantor.* labels are reserved", key)
		}
	}
}

// word removes shell quoting from a Dockerfile word the way BuildKit's expansion does, without
// expanding variables (callers reject words with variables first).
func (c *checker) word(w string) string {
	out, _, err := c.lex.ProcessWord(w, shell.EnvsFromSlice(nil))
	if err != nil {
		return w
	}
	return out
}

// nodeFlags returns the lower-case names of the flags written on an instruction ("checksum" for
// --checksum=…), read from its original source line.
func nodeFlags(cmd instructions.Command) []string {
	sc, ok := cmd.(fmt.Stringer)
	if !ok {
		return nil
	}
	fields := strings.Fields(sc.String())
	var out []string
	for i, f := range fields {
		if i == 0 {
			continue // the instruction name
		}
		if !strings.HasPrefix(f, "--") {
			break
		}
		name, _, _ := strings.Cut(strings.TrimPrefix(f, "--"), "=")
		out = append(out, strings.ToLower(name))
	}
	return out
}

func cmdLine(cmd instructions.Command) int { return rangeLine(cmd.Location()) }

func stageLine(st instructions.Stage) int { return rangeLine(st.Location) }

func rangeLine(loc []parser.Range) int {
	if len(loc) == 0 {
		return 0
	}
	return loc[0].Start.Line
}

// errorLine extracts the 1-based line of a parser error, or 0.
func errorLine(err error) int {
	var le *parser.LocationError
	for e := err; e != nil; {
		if l, ok := e.(*parser.LocationError); ok {
			le = l
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			break
		}
		e = u.Unwrap()
	}
	if le == nil || len(le.Locations) == 0 {
		return 0
	}
	return rangeLine(le.Locations[0])
}

// errorMessage returns the innermost meaningful message of a parser error without BuildKit's
// "dockerfile parse error on line N:" prefix (the line is reported separately).
func errorMessage(err error) string {
	msg := err.Error()
	if _, rest, ok := strings.Cut(msg, "dockerfile parse error on line "); ok {
		if _, after, ok := strings.Cut(rest, ": "); ok {
			msg = after
		}
	}
	return msg
}

func sortIssues(issues []Issue) {
	slices.SortStableFunc(issues, func(a, b Issue) int { return a.Line - b.Line })
}
