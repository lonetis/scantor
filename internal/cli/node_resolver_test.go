package cli

import (
	"encoding/json"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/resolver"
)

func TestNodeResolverCommandsAreHidden(t *testing.T) {
	app, out, _ := testApp(nil)
	if code := run(app, "node", "--help"); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	if strings.Contains(out.String(), "resolver") {
		t.Errorf("node --help lists the resolver:\n%s", out.String())
	}
}

func TestNodeResolverServeValidatesItsFlags(t *testing.T) {
	app, _, errOut := testApp(nil)
	if code := run(app, "node", "resolver", "serve", "--spec-hash", "sha256:x"); code != ExitValidation || !strings.Contains(errOut.String(), "config") {
		t.Errorf("missing --config: exit %d, stderr %q", code, errOut.String())
	}
	app, _, errOut = testApp(nil)
	if code := run(app, "node", "resolver", "serve", "--config", `{"nodeId":"n","bogus":1}`, "--spec-hash", "sha256:x"); code != ExitValidation ||
		!strings.Contains(errOut.String(), "--config") || !strings.Contains(errOut.String(), "unknown field") {
		t.Errorf("unknown field: exit %d, stderr %q", code, errOut.String())
	}
}

// serve answers until SIGINT/SIGTERM, then drains and exits 0.
func TestNodeResolverServeStopsOnSignal(t *testing.T) {
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	_ = pc.Close()
	cfg, err := json.Marshal(resolver.Config{
		NodeID: "2d9e1f6a-0b7c-4c3e-9f1a-5b6c7d8e9f00", Listen: addr, Clients: []string{"127.0.0.0/8"}, Mode: resolver.ModeRecursive,
		// A closed loopback port: the upstream check fails at once and no query leaves the host.
		Upstreams: []string{"127.0.0.1:9"}, TrustedServers: []string{"127.0.0.1:9"},
		CacheBytes: resolver.MinCacheBytes, MaxLookups: 4, LogLevel: "info", LogFormat: "json",
	})
	if err != nil {
		t.Fatal(err)
	}
	app, out, errOut := testApp(nil)
	done := make(chan int, 1)
	go func() {
		done <- run(app, "node", "resolver", "serve", "--config", string(cfg), "--spec-hash", "sha256:abc")
	}()
	q := new(dns.Msg)
	q.SetQuestion(resolver.ProbeName, dns.TypeTXT)
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, _, err := (&dns.Client{Timeout: 200 * time.Millisecond}).Exchange(q, addr)
		if err == nil && len(r.Answer) == 1 && strings.Contains(r.Answer[0].String(), "spec=sha256:abc") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the resolver did not answer: %v (stderr %q)", err, errOut.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != ExitOK {
			t.Errorf("exit %d, stderr %q", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not stop")
	}
	if !strings.Contains(out.String(), "node resolver listening") || !strings.Contains(out.String(), "node resolver stopped") {
		t.Errorf("log:\n%s", out.String())
	}
}

func TestNodeResolverHealthcheckFailsWithoutState(t *testing.T) {
	if _, err := os.Stat(resolver.StatePath); err == nil {
		t.Skip("a resolver state file exists on this host")
	}
	app, out, errOut := testApp(nil)
	if code := run(app, "node", "resolver", "healthcheck"); code != 1 || out.Len() != 0 || !strings.Contains(errOut.String(), "state") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, out.String(), errOut.String())
	}
}
