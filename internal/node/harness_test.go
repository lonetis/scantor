package node

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/redact"
)

const (
	testToken   = "snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9"
	testTaskID  = "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c"
	testScanID  = "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f"
	testUserID  = "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11"
	testDigest  = "sha256:4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091"
	testWorker1 = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	testWorker2 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
)

func testImage() string { return "registry.example.com/tasks/" + testTaskID + "@" + testDigest }

// testAssignment returns a valid assignment of worker id with 2 processes of 1 CPU and 512 MiB.
func testAssignment(id string) api.Assignment {
	return api.Assignment{
		WorkerID:  id,
		ScanID:    testScanID,
		UserID:    testUserID,
		Role:      "runner",
		SpecHash:  "sha256:5d41402abc4b2a76b9719d911017c592",
		Image:     testImage(),
		Processes: 2,
		Resources: api.AssignmentResources{NanoCPUs: 2_000_000_000, MemoryBytes: 1_342_177_280},
		CapAdd:    []string{"NET_BIND_SERVICE", "NET_RAW"},
		Env: map[string]string{
			"SCANTOR_URL":          "https://scantor.example.com",
			"SCANTOR_WORKER_TOKEN": "swt_" + id + ".yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o",
		},
	}
}

func testTimings() timings {
	t := defaultTimings()
	t.reconcileEvery = 50 * time.Millisecond
	t.statusDebounce = 20 * time.Millisecond
	t.apiBackoffMin = 20 * time.Millisecond
	t.apiBackoffMax = 100 * time.Millisecond
	t.unauthorizedRetry = 100 * time.Millisecond
	t.defaultOfflineAfter = 300 * time.Millisecond
	t.incompatibleRetry = 200 * time.Millisecond
	t.exitZeroDelay = 150 * time.Millisecond
	t.crashBase = 100 * time.Millisecond
	t.crashMax = 400 * time.Millisecond
	t.failureBase = 50 * time.Millisecond
	t.failureMax = 200 * time.Millisecond
	t.recheck = 20 * time.Millisecond
	t.shutdownGrace = 500 * time.Millisecond
	t.finalStatusTimeout = time.Second
	t.networkRetry = 100 * time.Millisecond
	t.gcEvery = time.Hour
	t.egressEvery = time.Hour
	t.helperTimeout = 5 * time.Second
	return t
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type harness struct {
	t      *testing.T
	docker *fakeDocker
	orch   *fakeOrchestrator
	d      *Daemon
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
}

// newHarness wires a daemon to a fake engine and a fake orchestrator. The task image is present
// locally unless the test removes it.
func newHarness(t *testing.T, mutate func(*Config)) *harness {
	t.Helper()
	docker := newFakeDocker()
	orch := newFakeOrchestrator(t, testToken)
	cfg := Config{
		URL: orch.srv.URL, Token: testToken, DinD: DinDDisabled,
		PidsLimit: 4096, ShmSize: 256 << 20, Nofile: 65536, LogMaxSize: 20 << 20, LogMaxFiles: 3,
		ImageRetention: 24 * time.Hour, PullTimeout: 5 * time.Second,
		LogLevel: slog.LevelDebug, LogFormat: redact.FormatText,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	logs := &syncBuffer{}
	d, err := New(Options{Config: cfg, Docker: docker, Logger: redact.NewLogger(logs, redact.FormatText, slog.LevelDebug)})
	if err != nil {
		t.Fatal(err)
	}
	d.t = testTimings()
	d.statusFile = filepath.Join(t.TempDir(), "scantor-node.status")
	d.diskFree = func() (int64, error) { return 100 << 30, nil }
	d.mountinfo = filepath.Join(t.TempDir(), "no-mountinfo")
	d.binarySource = func(context.Context) (*container.Binary, error) {
		return container.NewBinary([]byte("#!/bin/sh\nexec sleep 1000\n")), nil
	}
	docker.addImage(testImage())
	h := &harness{t: t, docker: docker, orch: orch, d: d, logs: logs}
	t.Cleanup(func() {
		if err := h.stop(); err != nil {
			t.Errorf("Run returned %v", err)
		}
		if t.Failed() {
			t.Logf("daemon log:\n%s", logs.String())
		}
	})
	return h
}

func (h *harness) start() {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	go func() { h.done <- h.d.Run(ctx) }()
}

// stop sends the shutdown signal and waits for Run to return.
func (h *harness) stop() error {
	if h.cancel == nil {
		return nil
	}
	h.cancel()
	h.cancel = nil
	select {
	case err := <-h.done:
		return err
	case <-time.After(10 * time.Second):
		h.t.Fatal("the daemon did not stop within 10 s")
		return nil
	}
}

// eventually polls cond until it holds or the timeout expires.
func eventually(t *testing.T, timeout time.Duration, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting: %s", msg)
}

// waitWorkerState waits until the last status reports the worker in state.
func (h *harness) waitWorkerState(workerID, state string) api.NodeWorkerStatus {
	h.t.Helper()
	var got api.NodeWorkerStatus
	eventually(h.t, 5*time.Second, "worker "+workerID+" reported "+state, func() bool {
		w := h.orch.workerStatus(workerID)
		if w != nil && w.State == state {
			got = *w
			return true
		}
		return false
	})
	return got
}

func (h *harness) logContains(s string) bool { return strings.Contains(h.logs.String(), s) }

var _ io.Writer = (*syncBuffer)(nil)

// testCACert returns a self-signed CA certificate in PEM form.
func testCACert(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "scantor test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
