package scantor

import (
	"fmt"
	"io"
	"iter"
	"os"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// templatePackagePrefix is the import path prefix of the template proxies. A schedule whose function
// symbol belongs to one of these packages is the template itself, passed unwrapped.
const templatePackagePrefix = "github.com/lonetis/scantor/connectors/go/templates/"

// notConnectorMessage is printed when the binary is started without the protocol file descriptors.
const notConnectorMessage = `scantor: this program is a scantor task connector; run it with "scantor dev run"`

// Serve runs the task defined by schedule and run as a connector process. It blocks until the runtime
// shuts the process down and then exits the process.
//
// The type parameters are inferred from the two functions, also when schedule is an uninstantiated
// template proxy: Serve(tranco.Schedule, run) uses the template unwrapped, so the scheduler runs it
// natively. A custom schedule must be deterministic for a given scan config and task config.
func Serve[TC, SC, AC, R any](
	schedule func(ctx Context, scanConfig SC, taskConfig TC) iter.Seq2[AC, error],
	run func(ctx Context, analysisConfig AC, taskConfig TC) (R, error),
) {
	os.Exit(serveProcess(newTask(schedule, run)))
}

// newTask erases the type parameters of a task definition.
func newTask[TC, SC, AC, R any](
	schedule func(ctx Context, scanConfig SC, taskConfig TC) iter.Seq2[AC, error],
	run func(ctx Context, analysisConfig AC, taskConfig TC) (R, error),
) *task {
	t := &task{
		taskConfig:     reflect.TypeFor[TC](),
		scanConfig:     reflect.TypeFor[SC](),
		analysisConfig: reflect.TypeFor[AC](),
		result:         reflect.TypeFor[R](),
	}
	if run != nil {
		t.run = func(ctx Context, ac, tc any) (any, error) { return run(ctx, ac.(AC), tc.(TC)) }
	}
	if schedule == nil {
		t.template = "single"
		t.schedule = singleSchedule
		return t
	}
	t.template = templateOf(schedule)
	t.schedule = func(ctx Context, sc, tc any) iter.Seq2[any, error] {
		return func(yield func(any, error) bool) {
			for ac, err := range schedule(ctx, sc.(SC), tc.(TC)) {
				if !yield(ac, err) {
					return
				}
			}
		}
	}
	return t
}

// ServeRun runs a task without a schedule, which means the template single: one analysis with an
// empty analysis config. It is Serve(single.Schedule, run).
func ServeRun[TC, R any](run func(ctx Context, analysisConfig Empty, taskConfig TC) (R, error)) {
	Serve[TC, Empty, Empty, R](nil, run)
}

// singleSchedule is the proxy of the template single used by ServeRun.
func singleSchedule(ctx Context, _, _ any) iter.Seq2[any, error] {
	return func(yield func(any, error) bool) {
		for ac, err := range proxy.Schedule[Empty](ctx, "single", Empty{}) {
			if !yield(ac, err) {
				return
			}
		}
	}
}

// task is the type-erased task definition.
type task struct {
	taskConfig, scanConfig, analysisConfig, result reflect.Type
	// template is the name of the template passed unwrapped, or "" for a custom schedule.
	template string
	schedule func(ctx Context, scanConfig, taskConfig any) iter.Seq2[any, error]
	run      func(ctx Context, analysisConfig, taskConfig any) (any, error)
}

// taskModels are the native models of a valid task definition.
type taskModels struct {
	taskConfig, scanConfig, analysisConfig, result *model
}

// prepare validates the definition and exports its schemas.
func (t *task) prepare() (*taskModels, error) {
	if t.run == nil {
		return nil, fmt.Errorf("run is required")
	}
	configs := []struct {
		name string
		typ  reflect.Type
	}{{"task config", t.taskConfig}, {"scan config", t.scanConfig}, {"analysis config", t.analysisConfig}}
	for _, c := range configs {
		if derefType(c.typ).Kind() != reflect.Struct {
			return nil, fmt.Errorf("the %s type %s must be a struct (configs are closed objects)", c.name, c.typ)
		}
	}
	if r := derefType(t.result); r.Kind() != reflect.Struct && (r.Kind() != reflect.Map || r.Key().Kind() != reflect.String) {
		return nil, fmt.Errorf("the result type %s must be a struct or a map with string keys", t.result)
	}
	var m taskModels
	var err error
	if m.taskConfig, err = modelFor(t.taskConfig, inputMode); err != nil {
		return nil, err
	}
	if m.scanConfig, err = modelFor(t.scanConfig, inputMode); err != nil {
		return nil, err
	}
	if m.analysisConfig, err = modelFor(t.analysisConfig, inputMode); err != nil {
		return nil, err
	}
	if m.result, err = modelFor(t.result, outputMode); err != nil {
		return nil, err
	}
	return &m, nil
}

func derefType(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

// templateOf returns the template name when fn is the Schedule function of a template package.
func templateOf(fn any) string {
	f := runtime.FuncForPC(reflect.ValueOf(fn).Pointer())
	if f == nil {
		return ""
	}
	rest, ok := strings.CutPrefix(f.Name(), templatePackagePrefix)
	if !ok {
		return ""
	}
	name, symbol, ok := strings.Cut(rest, ".")
	if !ok || (symbol != "Schedule" && !strings.HasPrefix(symbol, "Schedule[")) {
		return ""
	}
	return name
}

// serveProcess connects to the protocol file descriptors and serves until shutdown; it returns the
// process exit code of docs/protocol.md §11.
func serveProcess(t *task) int {
	inFD, outFD := protocolFDs(os.Getenv)
	in, out, ok := openProtocolFDs(inFD, outFD)
	if !ok {
		fmt.Fprintln(os.Stderr, notConnectorMessage)
		return 2
	}
	return serve(t, in, out, os.Stderr)
}

// protocolFDs reads SCANTOR_PROTOCOL_IN_FD and SCANTOR_PROTOCOL_OUT_FD (defaults 3 and 4), which the
// runtime sets for every connector process (debuggers may move the descriptors).
func protocolFDs(getenv func(string) string) (int, int) {
	parse := func(name string, fallback int) int {
		if v, err := strconv.Atoi(getenv(name)); err == nil && v > 2 {
			return v
		}
		return fallback
	}
	return parse("SCANTOR_PROTOCOL_IN_FD", 3), parse("SCANTOR_PROTOCOL_OUT_FD", 4)
}

func openProtocolFDs(inFD, outFD int) (io.Reader, io.Writer, bool) {
	var st syscall.Stat_t
	if inFD == outFD || syscall.Fstat(inFD, &st) != nil || syscall.Fstat(outFD, &st) != nil {
		return nil, nil, false
	}
	// The runtime passes the pipes without FD_CLOEXEC, and os/exec does not close inherited
	// descriptors: child processes of task code (browsers, tools) would otherwise read requests from fd
	// 3, write into fd 4 or keep fd 4 open after the connector exited.
	syscall.CloseOnExec(inFD)
	syscall.CloseOnExec(outFD)
	in := os.NewFile(uintptr(inFD), "scantor-protocol-in")
	out := os.NewFile(uintptr(outFD), "scantor-protocol-out")
	return in, out, true
}
