//go:build linux

package resolver

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

// spread sends n datagrams to addr, each from a fresh source port as Docker's embedded DNS does, and
// returns how many each socket received.
func spread(t *testing.T, addr string, n int, socks ...*net.UDPConn) []int32 {
	t.Helper()
	counts := make([]atomic.Int32, len(socks))
	var readers sync.WaitGroup
	for i, c := range socks {
		readers.Go(func() {
			buf := make([]byte, 512)
			for {
				_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
				if _, _, err := c.ReadFrom(buf); err != nil {
					return
				}
				counts[i].Add(1)
			}
		})
	}
	payload, err := newQuery("a.test", dns.TypeA).Pack()
	if err != nil {
		t.Fatal(err)
	}
	for range n {
		c, err := net.Dial("udp4", addr)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = c.Write(payload)
		_ = c.Close()
	}
	readers.Wait()
	out := make([]int32, len(socks))
	for i := range counts {
		out[i] = counts[i].Load()
	}
	return out
}

// TestReuseportSteering binds two sockets to one address (a resolver and its replacement): the
// departing one steers every new datagram to the newer one, and clearing the program restores
// hashing over both.
func TestReuseportSteering(t *testing.T) {
	addr := freeAddr(t)
	lc := net.ListenConfig{Control: listenControl}
	ctx := context.Background()
	old, oldTCP, err := listenPair(ctx, lc, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	defer oldTCP.Close()
	newer, newerTCP, err := listenPair(ctx, lc, addr)
	if err != nil {
		t.Fatalf("second bind with SO_REUSEPORT: %v", err)
	}
	defer newer.Close()
	defer newerTCP.Close()
	if err := steer(old, steerSecond); err != nil {
		t.Fatalf("steer to the newest socket: %v", err)
	}
	// Some kernels refuse reuseport programs on TCP listeners (EOPNOTSUPP, seen on GitHub-hosted
	// runners); steering is best effort there and UDP, the path Docker's embedded DNS uses, still steers.
	if err := steer(oldTCP, steerSecond); err != nil && !errors.Is(err, syscall.EOPNOTSUPP) {
		t.Fatalf("steer TCP to the newest socket: %v", err)
	}
	if got := spread(t, addr, 40, old, newer); got[0] != 0 || got[1] != 40 {
		t.Errorf("after steering: old %d, newer %d datagrams", got[0], got[1])
	}
	if err := steer(newer, steerNone); err != nil {
		t.Fatalf("clear steering: %v", err)
	}
	if got := spread(t, addr, 40, old, newer); got[0] == 0 || got[1] == 0 || got[0]+got[1] != 40 {
		t.Errorf("after clearing: old %d, newer %d datagrams", got[0], got[1])
	}
}

func TestBindErrorCodes(t *testing.T) {
	addr := freeAddr(t)
	holder, err := net.ListenPacket("udp4", addr) // without SO_REUSEPORT
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	lc := net.ListenConfig{Control: listenControl}
	if _, _, err := listenPair(context.Background(), lc, addr); bindErrorCode(err) != "bindInUse" {
		t.Errorf("held port: %v → %s", err, bindErrorCode(err))
	}
	if _, _, err := listenPair(context.Background(), lc, "192.0.2.1:5353"); bindErrorCode(err) != "bindUnavailable" {
		t.Errorf("foreign address: %v → %s", err, bindErrorCode(err))
	}
}

// TestBlueGreenHandoverLosesNoQueries replaces a serving resolver by a newer one on the same address
// while clients query it from fresh source ports: the departing resolver steers new queries to the
// newer one, drains and closes, and no query goes unanswered.
func TestBlueGreenHandoverLosesNoQueries(t *testing.T) {
	addr := freeAddr(t)
	up := fakeDNS(t, rootNS())
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	start := func(spec string) *running {
		cfg := testConfig(ModeRecursive, addr)
		cfg.Upstreams = []string{"198.51.100.1:53"}
		h := newHarness(t, cfg, n, withOptions(func(o *Options) {
			o.SpecHash = spec
			o.timings.drainQuiet = 300 * time.Millisecond
			o.timings.drainMax = 3500 * time.Millisecond
		}))
		return h.run()
	}
	blue := start("sha256:blue")
	var (
		mu       sync.Mutex
		servedBy = map[string]int{}
		failures atomic.Int32
	)
	stop := make(chan struct{})
	var clients sync.WaitGroup
	for range 4 {
		clients.Go(func() {
			c := &dns.Client{Timeout: time.Second}
			for {
				select {
				case <-stop:
					return
				default:
				}
				// Every exchange dials a new socket: a fresh source port, as Docker's embedded DNS uses.
				r, _, err := c.Exchange(newQuery(ProbeName, dns.TypeTXT), addr)
				if err != nil || r.Rcode != dns.RcodeSuccess || len(r.Answer) != 1 {
					failures.Add(1)
					continue
				}
				_, spec, _ := parseProbeAnswer(r.Answer[0].(*dns.TXT).Txt[0])
				mu.Lock()
				servedBy[spec]++
				mu.Unlock()
				time.Sleep(5 * time.Millisecond)
			}
		})
	}
	time.Sleep(300 * time.Millisecond)
	_ = start("sha256:green")
	time.Sleep(300 * time.Millisecond)
	blue.cancel() // SIGTERM
	select {
	case err := <-blue.done:
		if err != nil {
			t.Errorf("blue Run = %v", err)
		}
		blue.done <- nil // for the cleanup
	case <-time.After(5 * time.Second):
		t.Fatal("blue did not stop")
	}
	time.Sleep(300 * time.Millisecond)
	close(stop)
	clients.Wait()
	mu.Lock()
	defer mu.Unlock()
	if failures.Load() != 0 {
		t.Errorf("%d queries failed during the handover (served: %v)", failures.Load(), servedBy)
	}
	if servedBy["sha256:blue"] == 0 || servedBy["sha256:green"] == 0 {
		t.Errorf("served: %v", servedBy)
	}
}

// startOn runs a resolver with spec on addr whose upstream server is upstream (an address of n).
func startOn(t *testing.T, addr, spec, upstream string, n *resolvertest.Network) (*harness, *running) {
	t.Helper()
	cfg := testConfig(ModeRecursive, addr)
	cfg.Upstreams = []string{upstream}
	h := newHarness(t, cfg, n, withOptions(func(o *Options) { o.SpecHash = spec }))
	return h, h.run()
}

// servedBy sends count probe queries to addr, each from a fresh source port, and returns how many
// each resolver (by spec) answered and how many got no answer.
func servedBy(t *testing.T, addr string, count int) (map[string]int, int) {
	t.Helper()
	served, failed := map[string]int{}, 0
	c := &dns.Client{Timeout: time.Second}
	for range count {
		r, _, err := c.Exchange(newQuery(ProbeName, dns.TypeTXT), addr)
		if err != nil || r.Rcode != dns.RcodeSuccess || len(r.Answer) != 1 {
			failed++
			continue
		}
		_, spec, _ := parseProbeAnswer(r.Answer[0].(*dns.TXT).Txt[0])
		served[spec]++
	}
	return served, failed
}

// stop ends a running resolver as SIGTERM does and waits until Run returned.
func stop(t *testing.T, r *running) {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		if err != nil {
			t.Errorf("Run = %v", err)
		}
		r.done <- nil // for the cleanup
	case <-time.After(5 * time.Second):
		t.Fatal("the resolver did not stop")
	}
}

// TestReplacementTakesNoQueriesBeforeItsUpstreamCheck binds a replacement whose upstream server does
// not answer next to a serving resolver: every query stays with the serving one until the
// replacement's upstream check passes, then both share them.
func TestReplacementTakesNoQueriesBeforeItsUpstreamCheck(t *testing.T) {
	addr := freeAddr(t)
	up := fakeDNS(t, rootNS())
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	_, _ = startOn(t, addr, "sha256:blue", "198.51.100.1:53", n)
	green, _ := startOn(t, addr, "sha256:green", "198.51.100.9:53", n)
	eventually(t, 2*time.Second, func() bool { return green.s.upstreamErr.Load() != nil })
	served, failed := servedBy(t, addr, 60)
	if failed != 0 || served["sha256:green"] != 0 || served["sha256:blue"] != 60 {
		t.Errorf("before the replacement's upstream check passed: served %v, %d failed", served, failed)
	}
	// The replacement's upstream server answers now: after its next check it takes queries too.
	n.Add(netip.MustParseAddr("198.51.100.9"), up)
	eventually(t, 2*time.Second, func() bool { return green.s.upstreamOK.Load() })
	served, failed = servedBy(t, addr, 100)
	if failed != 0 || served["sha256:green"] == 0 || served["sha256:blue"] == 0 {
		t.Errorf("after the check passed: served %v, %d failed", served, failed)
	}
}

// TestDepartingResolverSteersAway stops resolvers of a group in the orders of the daemon's hand-overs:
// a departing resolver sends new queries to the other resolver, never to itself, whichever of the two
// bound first and whether the resolver it bound next to is still there.
func TestDepartingResolverSteersAway(t *testing.T) {
	addr := freeAddr(t)
	up := fakeDNS(t, rootNS())
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	// afterStop stops r and returns who answered the queries sent while r drains.
	afterStop := func(r *running) (map[string]int, int) {
		t.Helper()
		done := make(chan struct{})
		go func() {
			stop(t, r)
			close(done)
		}()
		time.Sleep(20 * time.Millisecond)
		served, failed := servedBy(t, addr, 40)
		<-done
		return served, failed
	}
	// The newer resolver stops (a replacement that the daemon removes again): the older keeps every
	// query.
	_, blue := startOn(t, addr, "sha256:blue", "198.51.100.1:53", n)
	_, green := startOn(t, addr, "sha256:green", "198.51.100.1:53", n)
	if served, failed := afterStop(green); failed != 0 || served["sha256:green"] != 0 {
		t.Errorf("the newer resolver departing: served %v, %d failed", served, failed)
	}
	// A replacement wins and the older resolver stops: the replacement takes every query.
	_, red := startOn(t, addr, "sha256:red", "198.51.100.1:53", n)
	if served, failed := afterStop(blue); failed != 0 || served["sha256:blue"] != 0 {
		t.Errorf("the older resolver departing: served %v, %d failed", served, failed)
	}
	// The next replacement binds next to red, which bound second but is now the only (first) socket:
	// when red stops, gold takes every query.
	_, gold := startOn(t, addr, "sha256:gold", "198.51.100.1:53", n)
	if served, failed := afterStop(red); failed != 0 || served["sha256:red"] != 0 || served["sha256:gold"] != 40 {
		t.Errorf("a former replacement departing: served %v, %d failed", served, failed)
	}
	_ = gold
}
