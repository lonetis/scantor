package dind

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake dockerd: with FAKE_DOCKERD set it serves GET /_ping on the socket
// named by FAKE_DOCKERD (after FAKE_DOCKERD_DELAY), or exits 1 when the value is "fail".
func TestMain(m *testing.M) {
	if socket := os.Getenv("FAKE_DOCKERD"); socket != "" {
		fakeDockerd(socket)
		return
	}
	os.Exit(m.Run())
}

func fakeDockerd(socket string) {
	fmt.Println("starting fake dockerd")
	if socket == "fail" {
		fmt.Fprintln(os.Stderr, "failed to start daemon: no space left")
		os.Exit(1)
	}
	if d, err := time.ParseDuration(os.Getenv("FAKE_DOCKERD_DELAY")); err == nil {
		time.Sleep(d)
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(2)
	}
	fmt.Fprintln(os.Stderr, "API listen on "+socket)
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_ping" {
			_, _ = w.Write([]byte("OK"))
			return
		}
		http.NotFound(w, r)
	}))
}

func socketPath(t *testing.T) string {
	dir, err := os.MkdirTemp("/tmp", "dind") // unix socket paths are short
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "docker.sock")
}

func fake(t *testing.T, socket string, extra ...string) Options {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Options{Command: []string{exe, "-test.run=^$"}, Environ: append([]string{"FAKE_DOCKERD=" + socket}, extra...), Socket: socket, Timeout: 5 * time.Second}
}

func TestStartAndStop(t *testing.T) {
	socket := socketPath(t)
	d, err := Start(context.Background(), fake(t, socket, "FAKE_DOCKERD_DELAY=600ms"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.Tail(), "API listen on") {
		t.Fatalf("tail %q", d.Tail())
	}
	start := time.Now()
	d.Stop()
	if time.Since(start) > StopGrace+time.Second {
		t.Fatalf("stop took %s", time.Since(start))
	}
	select {
	case <-d.Exited():
	default:
		t.Fatal("dockerd still runs")
	}
}

func TestStartFailures(t *testing.T) {
	if _, err := Start(context.Background(), Options{Environ: []string{"PATH=/nonexistent"}}); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing dockerd: %v", err)
	}
	_, err := Start(context.Background(), fake(t, "fail"))
	var re *ReadyError
	if !errors.As(err, &re) || !strings.Contains(re.Message, "exited before it became ready (exit code 1)") || !strings.Contains(re.Tail, "no space left") {
		t.Fatalf("early exit: %v", err)
	}
	opts := fake(t, socketPath(t), "FAKE_DOCKERD_DELAY=1h")
	opts.Timeout = 500 * time.Millisecond
	_, err = Start(context.Background(), opts)
	if !errors.As(err, &re) || re.Message != "dockerd did not become ready within 500ms" {
		t.Fatalf("timeout: %v", err)
	}
}
