package script

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/health"
)

// fakeScript is a script folder with a shell script standing in for `python -m scantor.script`. Its stdio
// are files, like the inherited stdio of a script-run container.
type fakeScript struct {
	t              *testing.T
	dir            string
	workRoot       string
	stdout, stderr *os.File
	signals        chan os.Signal
}

// newFakeScript writes body as script.sh into a new task folder; SCANTOR_SCRIPT_CMD runs it with sh.
func newFakeScript(t *testing.T, body string) *fakeScript {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "script.sh"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	f := &fakeScript{t: t, dir: dir, workRoot: filepath.Join(t.TempDir(), "scantor"), signals: make(chan os.Signal, 4)}
	f.stdout = tempFile(t, "stdout")
	f.stderr = tempFile(t, "stderr")
	return f
}

func tempFile(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Create(filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func (f *fakeScript) options(scriptCmd string) Options {
	environ := append(os.Environ(), "SCANTOR_URL=http://orchestrator:3000", "SCANTOR_SCRIPT_TOKEN=ssr_test", "READY="+filepath.Join(f.dir, "ready"))
	return Options{
		Entry:             "main.py",
		Config:            runtime.Config{ScriptCmd: scriptCmd, WorkRoot: f.workRoot, Environ: environ},
		Signals:           f.signals,
		Stdin:             strings.NewReader(""),
		Stdout:            f.stdout,
		Stderr:            f.stderr,
		TaskDir:           f.dir,
		KillGrace:         time.Minute,
		HeartbeatInterval: 50 * time.Millisecond,
	}
}

// run runs the runtime in the background and returns the channel of its exit code.
func (f *fakeScript) run(ctx context.Context, opts Options) <-chan int {
	code := make(chan int, 1)
	go func() { code <- Run(ctx, opts) }()
	return code
}

// waitReady waits until the script created $READY (its traps are installed).
func (f *fakeScript) waitReady() {
	f.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(f.dir, "ready")); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.t.Fatal("the script did not get ready")
}

func (f *fakeScript) exit(code <-chan int) int {
	f.t.Helper()
	select {
	case c := <-code:
		return c
	case <-time.After(20 * time.Second):
		f.t.Fatal("the runtime did not exit")
		return -1
	}
}

func (f *fakeScript) output(file *os.File) string {
	f.t.Helper()
	data, err := os.ReadFile(file.Name())
	if err != nil {
		f.t.Fatal(err)
	}
	return string(data)
}

func TestRunPassesExitCodeEntryDirAndEnvironment(t *testing.T) {
	f := newFakeScript(t, `echo "args: $*"; echo "dir: $(pwd)"; echo "token: $SCANTOR_SCRIPT_TOKEN url: $SCANTOR_URL"; echo oops >&2; exit 3`+"\n")
	code := Run(context.Background(), f.options("sh ./script.sh {entry} --flag"))
	if code != 3 {
		t.Fatalf("exit %d, want the script's 3; stderr %s", code, f.output(f.stderr))
	}
	dir, err := filepath.EvalSymlinks(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	out := f.output(f.stdout)
	for _, want := range []string{"args: main.py --flag\n", "token: ssr_test url: http://orchestrator:3000\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout lacks %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "dir: "+f.dir+"\n") && !strings.Contains(out, "dir: "+dir+"\n") {
		t.Errorf("the script must run in the task folder %s:\n%s", f.dir, out)
	}
	if got := f.output(f.stderr); got != "oops\n" {
		t.Errorf("stderr %q: the runtime adds nothing to a normal run", got)
	}

	f = newFakeScript(t, "exit 0\n")
	if code := Run(context.Background(), f.options("sh ./script.sh")); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestRunStartFailures(t *testing.T) {
	for _, tt := range []struct {
		name, cmd, want string
	}{
		{"not set", "", "scantor: this base image does not support scripts: SCANTOR_SCRIPT_CMD is not set\n"},
		{"blank", "  \t", "scantor: this base image does not support scripts: SCANTOR_SCRIPT_CMD is not set\n"},
		{"unterminated quote", `python "-m scantor.script {entry}`, "scantor: invalid SCANTOR_SCRIPT_CMD: command template has an unterminated quote\n"},
		{"missing executable", "scantor-no-such-python -m scantor.script {entry}", `scantor: the script command "scantor-no-such-python" cannot be started: scantor-no-such-python: not found in PATH` + "\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeScript(t, "exit 0\n")
			if code := Run(context.Background(), f.options(tt.cmd)); code != ExitRuntime {
				t.Fatalf("exit %d, want %d", code, ExitRuntime)
			}
			if got := f.output(f.stderr); got != tt.want {
				t.Fatalf("stderr %q, want %q", got, tt.want)
			}
			if _, err := os.Stat(health.Path(f.workRoot)); err == nil {
				t.Fatal("no heartbeat without a script")
			}
		})
	}
}

func TestRunForwardsSignalsToTheGroup(t *testing.T) {
	for _, tt := range []struct {
		name   string
		sig    syscall.Signal
		trap   string
		code   int
		stdout string
	}{
		{"SIGTERM", syscall.SIGTERM, "TERM", 7, "got TERM\n"},
		{"SIGINT", syscall.SIGINT, "INT", 5, "got INT\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			// The child sleeps in the background (same process group); the trap proves the shell got the
			// signal, the child's end proves the group did.
			f := newFakeScript(t, `trap 'echo got `+tt.trap+`; exit `+strconv.Itoa(tt.code)+`' `+tt.trap+`
sleep 30 >/dev/null 2>&1 &
echo $! > child.pid
touch "$READY"
wait
`)
			code := f.run(context.Background(), f.options("sh ./script.sh"))
			f.waitReady()
			f.signals <- tt.sig
			if got := f.exit(code); got != tt.code {
				t.Fatalf("exit %d, want %d; stderr %s", got, tt.code, f.output(f.stderr))
			}
			if out := f.output(f.stdout); out != tt.stdout {
				t.Fatalf("stdout %q", out)
			}
			if errOut := f.output(f.stderr); !strings.Contains(errOut, "scantor: received "+tt.name+"; stopping the script (killed after 1m0s)\n") {
				t.Fatalf("stderr %q", errOut)
			}
			assertGone(t, f, "child.pid")
		})
	}
}

// assertGone checks that the process whose pid the script wrote to name has ended.
func assertGone(t *testing.T, f *fakeScript, name string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, name))
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &pid); err != nil || pid <= 0 {
		t.Fatalf("pid %q: %v", data, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d of the script's group is still running", pid)
}

// alive reports whether a process runs. A zombie (killed, not yet reaped by the container's init) is
// not running.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return !os.IsNotExist(err) || noProcfs()
	}
	// The state follows the parenthesised command name: "<pid> (<comm>) <state> …".
	if i := strings.LastIndexByte(string(stat), ')'); i >= 0 && i+2 < len(stat) {
		return stat[i+2] != 'Z'
	}
	return true
}

// noProcfs reports a system without procfs (macOS), where kill(pid, 0) is the only signal.
func noProcfs() bool {
	_, err := os.Stat("/proc/self/stat")
	return err != nil
}

func TestRunKillsTheGroupAfterTheGrace(t *testing.T) {
	f := newFakeScript(t, `trap '' TERM
sleep 30 >/dev/null 2>&1 &
echo $! > child.pid
touch "$READY"
wait
`)
	opts := f.options("sh ./script.sh")
	opts.KillGrace = 200 * time.Millisecond
	code := f.run(context.Background(), opts)
	f.waitReady()
	start := time.Now()
	f.signals <- syscall.SIGTERM
	f.signals <- syscall.SIGTERM // a second signal is forwarded too and does not restart the grace
	if got := f.exit(code); got != 128+int(syscall.SIGKILL) {
		t.Fatalf("exit %d, want 137", got)
	}
	if elapsed := time.Since(start); elapsed < 200*time.Millisecond || elapsed > 10*time.Second {
		t.Fatalf("killed after %s", elapsed)
	}
	errOut := f.output(f.stderr)
	if strings.Count(errOut, "received SIGTERM") != 1 || !strings.Contains(errOut, "scantor: the script did not stop within 200ms; killing it\n") {
		t.Fatalf("stderr %q", errOut)
	}
	assertGone(t, f, "child.pid")
}

func TestRunReportsTheSignalThatEndedTheScript(t *testing.T) {
	f := newFakeScript(t, "kill -TERM $$\nsleep 5\n")
	if code := Run(context.Background(), f.options("sh ./script.sh")); code != 128+int(syscall.SIGTERM) {
		t.Fatalf("exit %d, want 143", code)
	}
}

func TestRunStopsOnCancel(t *testing.T) {
	f := newFakeScript(t, `trap 'exit 9' TERM
touch "$READY"
sleep 30 >/dev/null 2>&1 &
wait
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	code := f.run(ctx, f.options("sh ./script.sh"))
	f.waitReady()
	cancel()
	if got := f.exit(code); got != 9 {
		t.Fatalf("exit %d, want 9 (a cancelled context is SIGTERM)", got)
	}
}

func TestRunWritesHeartbeats(t *testing.T) {
	f := newFakeScript(t, `while [ ! -f "$HEARTBEAT" ]; do sleep 0.02; done
exit 0
`)
	opts := f.options("sh ./script.sh")
	opts.Config.Environ = append(opts.Config.Environ, "HEARTBEAT="+health.Path(f.workRoot))
	if code := Run(context.Background(), opts); code != 0 {
		t.Fatalf("exit %d; stderr %s", code, f.output(f.stderr))
	}
	data, err := os.ReadFile(health.Path(f.workRoot))
	if err != nil {
		t.Fatal(err)
	}
	var rec health.Record
	if err := json.Unmarshal(data, &rec); err != nil || rec.Mode != "script" || rec.IntervalMs != 50 {
		t.Fatalf("heartbeat %s: %v", data, err)
	}
	if err := health.Check(health.Path(f.workRoot), time.UnixMilli(rec.At)); err != nil {
		t.Fatalf("the healthcheck must accept the heartbeat: %v", err)
	}
}
