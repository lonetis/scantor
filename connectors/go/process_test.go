package scantor_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
)

// fixtureEnv makes the test binary act as a task binary (TestMain), so the real entry point Serve runs
// in a child process with real file descriptors.
const fixtureEnv = "SCANTOR_GO_TEST_FIXTURE"

func TestMain(m *testing.M) {
	if os.Getenv(fixtureEnv) == "echo" {
		scantor.Serve[echoTaskConfig, scantor.Empty, echoAnalysisConfig](nil, echoRun)
	}
	os.Exit(m.Run())
}

func fixtureCommand(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), fixtureEnv+"=echo")
	return cmd
}

func TestStartedWithoutProtocolFDs(t *testing.T) {
	cmd := fixtureCommand(t)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("want exit code 2, got %v", err)
	}
	if !strings.Contains(stderr.String(), `run it with "scantor dev run"`) {
		t.Fatalf("stderr %q", stderr.String())
	}
}

// TestProtocolOverFileDescriptors runs a handshake, a run and a shutdown over fds 3/4 and, as
// debuggers may need, over descriptors named by SCANTOR_PROTOCOL_IN_FD/OUT_FD.
func TestProtocolOverFileDescriptors(t *testing.T) {
	for _, viaEnv := range []bool{false, true} {
		name := "fds 3 and 4"
		if viaEnv {
			name = "fds from the environment"
		}
		t.Run(name, func(t *testing.T) {
			toConnR, toConnW, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			fromConnR, fromConnW, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd := fixtureCommand(t)
			if viaEnv {
				devNull, err := os.Open(os.DevNull)
				if err != nil {
					t.Fatal(err)
				}
				defer devNull.Close()
				// fds 3 and 4 are /dev/null; the protocol runs on 5 and 6.
				cmd.ExtraFiles = []*os.File{devNull, devNull, toConnR, fromConnW}
				cmd.Env = append(cmd.Env, "SCANTOR_PROTOCOL_IN_FD=5", "SCANTOR_PROTOCOL_OUT_FD=6")
			} else {
				cmd.ExtraFiles = []*os.File{toConnR, fromConnW}
			}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			toConnR.Close()
			fromConnW.Close()
			lines := bufio.NewScanner(fromConnR)
			lines.Buffer(make([]byte, 1<<20), 8<<20)
			read := func(want string) map[string]any {
				t.Helper()
				if !lines.Scan() {
					t.Fatalf("no %s (stderr: %s)", want, stderr.String())
				}
				var m map[string]any
				if err := json.Unmarshal(lines.Bytes(), &m); err != nil || m["type"] != want {
					t.Fatalf("want %s, got %s", want, lines.Bytes())
				}
				return m
			}
			write := func(v any) {
				raw, _ := json.Marshal(v)
				if _, err := toConnW.Write(append(raw, '\n')); err != nil {
					t.Fatal(err)
				}
			}
			hello := read("hello")
			if int(hello["pid"].(float64)) != cmd.Process.Pid {
				t.Fatalf("hello pid %v, child %d", hello["pid"], cmd.Process.Pid)
			}
			write(map[string]any{"type": "welcome", "id": "hello", "protocolVersion": 1, "mode": "local",
				"runtime": map[string]any{"version": "dev"}, "limits": defaultLimits, "cancelGraceMs": 5000})
			read("ready")
			write(map[string]any{"type": "run", "id": "r1", "ctx": runCtx(execDir(t), 0, nil), "analysisConfig": map[string]any{}, "taskConfig": map[string]any{}})
			if r := read("result"); r["result"].(map[string]any)["text"] != "Hello, world!" {
				t.Fatalf("result %v", r)
			}
			write(map[string]any{"type": "shutdown", "id": "x1", "graceMs": 5000})
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("exit: %v (stderr: %s)", err, stderr.String())
				}
			case <-time.After(5 * time.Second):
				_ = cmd.Process.Kill()
				t.Fatal("no exit within the shutdown grace")
			}
		})
	}
}
