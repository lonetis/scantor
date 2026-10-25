package worker

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeapi"
	"github.com/lonetis/scantor/internal/runtime/runner"
)

const workerID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"

func config(t *testing.T, url string) runtime.Config {
	return runtime.Config{URL: url, WorkerToken: fakeapi.Token(workerID), WorkRoot: filepath.Join(t.TempDir(), "scantor")}
}

func run(t *testing.T, cfg runtime.Config) (int, string) {
	t.Helper()
	var log bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	code := Run(ctx, Options{Config: cfg, Stderr: &log, Unsetenv: func(string) error { return nil }})
	return code, log.String()
}

func TestBootstrapExits(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()

	srv.Snapshot(func(s *fakeapi.Server) { s.BootstrapFailures, s.BootstrapStatus = 1, http.StatusUnauthorized })
	if code, log := run(t, config(t, srv.URL)); code != ExitOK || !strings.Contains(log, "no longer active") {
		t.Fatalf("401: %d %s", code, log)
	}
	srv.Snapshot(func(s *fakeapi.Server) { s.BootstrapFailures, s.BootstrapStatus = 1, http.StatusUpgradeRequired })
	if code, _ := run(t, config(t, srv.URL)); code != ExitFatal {
		t.Fatalf("426: %d", code)
	}
	srv.Snapshot(func(s *fakeapi.Server) { s.Bootstrap = api.Bootstrap{Action: api.ActionStop} })
	if code, log := run(t, config(t, srv.URL)); code != ExitOK || !strings.Contains(log, "not running") {
		t.Fatalf("stop: %d %s", code, log)
	}
	// A transient failure is retried.
	srv.Snapshot(func(s *fakeapi.Server) { s.BootstrapFailures, s.BootstrapStatus = 1, http.StatusServiceUnavailable })
	if code, _ := run(t, config(t, srv.URL)); code != ExitOK {
		t.Fatalf("retry: %d", code)
	}
}

// TestSignalDuringBootstrap: bootstrap retries forever, so a SIGTERM before the role starts must end the
// worker (exit 0) instead of waiting for Docker's SIGKILL.
func TestSignalDuringBootstrap(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	srv.Snapshot(func(s *fakeapi.Server) { s.BootstrapFailures, s.BootstrapStatus = 1000, http.StatusServiceUnavailable })
	signals := make(chan os.Signal, 1)
	var log bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- Run(context.Background(), Options{Config: config(t, srv.URL), Signals: signals, Stderr: &log, Unsetenv: func(string) error { return nil }})
	}()
	time.Sleep(300 * time.Millisecond)
	signals <- syscall.SIGTERM
	select {
	case code := <-done:
		if code != ExitOK || !strings.Contains(log.String(), "signal received during start-up") {
			t.Fatalf("exit %d: %s", code, log.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the worker kept retrying bootstrap after SIGTERM")
	}
}

func TestEnvironmentAndTransport(t *testing.T) {
	if code, log := run(t, runtime.Config{}); code != ExitFatal || !strings.Contains(log, "SCANTOR_URL is not set") {
		t.Fatalf("missing env: %d %s", code, log)
	}
	if code, log := run(t, config(t, "http://8.8.8.8:3000")); code != ExitFatal || !strings.Contains(log, "refused by the transport policy") {
		t.Fatalf("public plaintext: %d %s", code, log)
	}
}

func TestAMQPTransportRefusedIsReported(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	srv.Snapshot(func(s *fakeapi.Server) {
		s.Bootstrap = api.Bootstrap{
			Action: api.ActionRun, Worker: api.BootstrapWorker{ID: workerID, Role: api.RoleRunner, ScanID: "s"},
			AMQP: api.BootstrapAMQP{URL: "amqp://8.8.8.8:5672"},
		}
	})
	code, _ := run(t, config(t, srv.URL))
	if code != ExitFatal {
		t.Fatalf("exit %d", code)
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		if len(s.Errors) != 1 || !s.Errors[0].Fatal || s.Errors[0].Error.Phase != api.PhaseBootstrap || s.Errors[0].Error.Type != api.ErrorPlatform {
			t.Fatalf("reports %+v", s.Errors)
		}
	})
}

// The AMQP callbacks run on the connection goroutine, which starts before the role exists: they read the role
// without a race, and a stop that came first stops the role once it is set.
func TestRoleIsSetSafely(t *testing.T) {
	boot := &api.Bootstrap{Worker: api.BootstrapWorker{ID: workerID, Role: api.RoleRunner, ScanID: "s"}}
	w := &worker{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.reconnected()
		w.accessRefused(0)
		w.stop()
	}()
	r := runner.New(runner.Config{Boot: boot})
	w.setRunner(r)
	<-done
	if !r.Stopping() {
		t.Fatal("a stop before the role existed did not stop the runner")
	}
}
