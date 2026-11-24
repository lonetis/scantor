package resolver

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

func TestHealthcheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run", "state.json")
	now := time.Now()
	if _, err := Healthcheck(path, now); err == nil || !strings.Contains(err.Error(), "not written") {
		t.Errorf("missing state file: %v", err)
	}
	healthy := Stats{V: 1, Ready: true, Node: testNodeID, Spec: testSpec, Mode: ModeRecursive, Listen: "10.10.0.1:53",
		UpstreamOK: true, At: now.Add(-2 * time.Second).UTC().Format(time.RFC3339Nano), HostNameservers: []string{}}
	cases := []struct {
		name string
		edit func(*Stats)
		want string // "" = healthy
	}{
		{"healthy", func(*Stats) {}, ""},
		{"stale", func(s *Stats) { s.At = now.Add(-6 * time.Second).UTC().Format(time.RFC3339Nano) }, "old"},
		{"no time", func(s *Stats) { s.At = "" }, "time"},
		{"not listening", func(s *Stats) { s.Ready = false; s.Error = "bindInUse" }, "bindInUse"},
		{"starting", func(s *Stats) { s.Ready = false }, "yet"},
		{"no upstream", func(s *Stats) { s.UpstreamOK = false; s.UpstreamError = "upstreamUnreachable" }, "no upstream server"},
		{"no root", func(s *Stats) { s.Mode = ModeIterative; s.UpstreamOK = false }, "no root server"},
	}
	for _, tc := range cases {
		st := healthy
		tc.edit(&st)
		if err := writeState(path, st); err != nil {
			t.Fatal(err)
		}
		line, err := Healthcheck(path, now)
		if (tc.want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), tc.want)) {
			t.Errorf("%s: %v", tc.name, err)
		}
		var got Stats
		if jerr := json.Unmarshal(line, &got); jerr != nil || !reflect.DeepEqual(got, st) {
			t.Errorf("%s: health output %s", tc.name, line)
		}
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if line, err := Healthcheck(path, now); err == nil || line != nil {
		t.Errorf("malformed state file: %q %v", line, err)
	}
}

func TestWriteStateIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	for range 3 {
		if err := writeState(path, Stats{V: 1}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Errorf("directory entries = %v, %v", entries, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("state file mode = %v, %v", info, err)
	}
}

func TestRateMeterAndConntrack(t *testing.T) {
	var m rateMeter
	if q := m.observe(0, 0); q != 0 {
		t.Errorf("first sample = %v", q)
	}
	for i := 1; i <= 20; i++ {
		q := m.observe(float64(i), int64(i*100))
		if q != 100 {
			t.Fatalf("sample %d = %v", i, q)
		}
	}
	// The window covers the last ten seconds: a burst fades out.
	q := m.observe(21, 20*100+1000)
	if q < 100 || q > 200 {
		t.Errorf("after a burst = %v", q)
	}
	dir := t.TempDir()
	files := [2]string{filepath.Join(dir, "count"), filepath.Join(dir, "max")}
	if c := readConntrack(files); c != (Conntrack{}) {
		t.Errorf("missing files = %+v", c)
	}
	_ = os.WriteFile(files[0], []byte("12000\n"), 0o600)
	_ = os.WriteFile(files[1], []byte("262144\n"), 0o600)
	if c := readConntrack(files); c.Count != 12000 || c.Max != 262144 {
		t.Errorf("conntrack = %+v", c)
	}
}

func TestParseResolvConf(t *testing.T) {
	data := []byte(`# generated
search example.com
options ndots:0
nameserver 127.0.0.53
nameserver 192.0.2.53
nameserver 192.0.2.53
nameserver fe80::1%eth0
nameserver fe80::2
nameserver 169.254.169.254
nameserver 0.0.0.0
nameserver 224.0.0.251
nameserver 2001:db8::53
nameserver ::1
nameserver not-an-address
nameserver
`)
	// IPv4 link-local nameservers (GCE's metadata server) stay; IPv6 link-local and zoned ones cannot be
	// dialled without an interface.
	got := parseResolvConf(data, families{v4: true})
	want := []netip.AddrPort{
		netip.MustParseAddrPort("127.0.0.53:53"), netip.MustParseAddrPort("192.0.2.53:53"),
		netip.MustParseAddrPort("169.254.169.254:53"), netip.MustParseAddrPort("[::1]:53"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("IPv4-only node: %v", got)
	}
	got = parseResolvConf(data, families{v4: true, v6: true})
	if len(got) != 5 || got[3] != netip.MustParseAddrPort("[2001:db8::53]:53") {
		t.Errorf("dual-stack node: %v", got)
	}
	f := familiesOf([]netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("fe80::1"), netip.MustParseAddr("::1"), netip.MustParseAddr("10.0.0.2")})
	if f != (families{v4: true}) {
		t.Errorf("families = %+v", f)
	}
}

func TestProbe(t *testing.T) {
	_, srv := newRunning(t, tweaks{})
	via := func(addr string) *net.Resolver {
		return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res := Probe(ctx, via(srv.addr))
	if !res.OK || res.Node != testNodeID || res.Spec != testSpec || res.Error != "" {
		t.Errorf("probe = %+v", res)
	}
	// Another server answers something else for the name.
	other := fakeDNS(t, resolvertest.MustZone("invalid.", "resolver.scantor 0 IN TXT \"hello\""))
	if res := Probe(ctx, via(other.Addr().String())); res.OK || res.Error != ProbeErrBadAnswer {
		t.Errorf("foreign answer = %+v", res)
	}
	empty := fakeDNS(t, resolvertest.MustZone("invalid."))
	if res := Probe(ctx, via(empty.Addr().String())); res.OK || res.Error != ProbeErrNotFound {
		t.Errorf("NXDOMAIN = %+v", res)
	}
	failing := fakeDNS(t, resolvertest.MustZone("invalid."))
	failing.On("", 0, resolvertest.Behavior{Rcode: dns.RcodeServerFailure})
	if res := Probe(ctx, via(failing.Addr().String())); res.OK || res.Error != ProbeErrFailed {
		t.Errorf("SERVFAIL = %+v", res)
	}
	silent := fakeDNS(t, resolvertest.MustZone("invalid."))
	silent.On("", 0, resolvertest.Behavior{Drop: true})
	short, cancelShort := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelShort()
	if res := Probe(short, via(silent.Addr().String())); res.OK || res.Error != ProbeErrTimeout {
		t.Errorf("no answer = %+v", res)
	}
	for _, txt := range []string{"scantor-resolver node=a", "scantor-resolver node= spec=b", "other node=a spec=b", "scantor-resolver spec=a node=b"} {
		if _, _, ok := parseProbeAnswer(txt); ok {
			t.Errorf("parseProbeAnswer(%q) accepted", txt)
		}
	}
}
